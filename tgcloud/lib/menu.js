// The /start menu as screens: each is { text, reply_markup }. Buttons carry
// `menu:<screen>`; pressing one edits the same message into that screen.
// Copy this shape for any multi-screen menu (settings, help, prices…).

import { api } from 'sdk';
import { MINI_APP_URL, DEVELOPER } from './config.js';
import { esc } from './html.js';
import { botUsername } from './bot.js';

const back = { text: '🔙 برگشت', callback_data: 'menu:home' };

const SCREENS = {
  home: (user, bot) => ({
    text: `سلام${user?.first_name ? ` ${esc(user.first_name)}` : ''} 👋\n\n` +
      'لینک یه ترک از <b>ساندکلاد</b> یا اسم آهنگ رو برام بفرست تا فایل صوتی‌ش رو همین‌جا برات بفرستم 🎧\n\n' +
      '🔗 لینک: <code>https://soundcloud.com/forss/flickermood</code>\n' +
      '🔎 اسم: <code>flickermood</code>\n\n' +
      `توی هر چت دیگه‌ای هم بنویس <code>@${esc(bot)} اسم آهنگ</code> و از لیست انتخابش کن.`,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: [
      ...(MINI_APP_URL ? [[{ text: '📱 باز کردن اپ', web_app: { url: MINI_APP_URL } }]] : []),
      // Opens the chat picker with "@bot " typed in (inline mode, lib/inline.js).
      [{ text: '🔎 جستجو و فرستادن توی چت‌های دیگه', switch_inline_query: '' }],
      [{ text: '📖 راهنما', callback_data: 'menu:help' }, { text: '💬 ارسال نظر', callback_data: 'feedback' }],
    ] },
  }),
  help: (user, bot) => ({
    text: [
      '📖 <b>راهنما</b>',
      '',
      '<b>با لینک</b>',
      '۱. توی اپ یا سایت ساندکلاد، روی ترک دکمه‌ی <b>Share</b> رو بزن و <b>Copy link</b> رو انتخاب کن.',
      '۲. لینک رو همین‌جا برام بفرست.',
      '۳. چند ثانیه بعد فایل صوتی با اسم و کاور ترک می‌رسه.',
      '',
      '<b>با اسم</b>',
      '🔎 اسم آهنگ یا خواننده رو بفرست؛ از نتیجه‌ها روی آهنگی که می‌خوای بزن تا دانلود بشه. با ◀️ ▶️ نتیجه‌های بیشتری می‌بینی.',
      '',
      '<b>توی چت‌های دیگه</b>',
      `توی هر چت یا گروهی بنویس <code>@${esc(bot)} اسم آهنگ</code> و آهنگ رو از لیست انتخاب کن؛ همون‌جا فرستاده می‌شه. آهنگی که تازه‌ست چند ثانیه طول می‌کشه تا جاش بیاد.`,
      '',
      '<b>چه لینک‌هایی؟</b>',
      '✅ لینک یه ترک: <code>soundcloud.com/artist/track</code>',
      '✅ لینک اشتراک‌گذاری: <code>on.soundcloud.com/…</code>',
      '✅ ترک خصوصی با لینک مخفی‌ش',
      '❌ پلی‌لیست، آلبوم و پروفایل (فعلاً)',
      '',
      '<b>عوض کردن اسم، خواننده و کاور</b>',
      'زیر هر آهنگ سه دکمه هست: <b>✏️ اسم آهنگ</b>، <b>🎤 خواننده</b> و <b>🖼 کاور</b>.',
      'دکمه رو بزن، اسم جدید یا عکس کاور رو بفرست؛ یه نسخه‌ی جدید از آهنگ با همون اطلاعات می‌گیری. این اطلاعات توی خود فایل هم نوشته می‌شه، پس بعد از ذخیره هم همین‌ها رو می‌بینی.',
      '',
      '<b>محدودیت‌ها</b>',
      '• تلگرام فایل بزرگ‌تر از ۵۰ مگابایت رو از ربات قبول نمی‌کنه (حدود ۵۰ دقیقه).',
      '• ترک‌های SoundCloud Go+ فقط پیش‌نمایش ۳۰ ثانیه‌ای عمومی دارن.',
      '• بعضی ترک‌ها فقط به‌صورت رمزگذاری‌شده پخش می‌شن و قابل دانلود نیستن.',
      '',
      `👨‍💻 توسعه‌دهنده: <a href="https://t.me/${esc(DEVELOPER)}">@${esc(DEVELOPER)}</a>`,
    ].join('\n'),
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: [[back]] },
  }),
};

export async function sendScreen(message, screen) {
  return api.sendMessage({ chat_id: message.chat.id, ...SCREENS[screen](message.from, await botUsername()) });
}

export const sendHome = (message) => sendScreen(message, 'home');

// true when `query` was a menu button.
export async function handleMenuCallback(query) {
  const m = /^menu:(\w+)$/.exec(query.data ?? '');
  if (!m || !SCREENS[m[1]]) return false;
  // Stop the button's spinner; fails when the query is too old — the screen still changes.
  await api.answerCallbackQuery({ callback_query_id: query.id }).catch(console.error);
  if (!query.message) return true;
  try {
    await api.editMessageText({
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      ...SCREENS[m[1]](query.from, await botUsername()),
    });
  } catch (e) {
    if (!/not modified/i.test(e.description ?? '')) throw e;   // same screen pressed twice
  }
  return true;
}
