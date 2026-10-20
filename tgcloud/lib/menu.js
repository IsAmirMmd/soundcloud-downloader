// The /start menu as screens: each is { text, reply_markup }. Buttons carry
// `menu:<screen>`; pressing one edits the same message into that screen.
// Copy this shape for any multi-screen menu (settings, help, prices…).

import { api } from 'sdk';
import { MINI_APP_URL } from './config.js';

const back = { text: '🔙 برگشت', callback_data: 'menu:home' };

const SCREENS = {
  home: (user) => ({
    text: `سلام${user?.first_name ? ` ${user.first_name}` : ''} 👋\n\nچه کاری برات انجام بدم؟`,
    reply_markup: { inline_keyboard: [
      ...(MINI_APP_URL ? [[{ text: '📱 باز کردن اپ', web_app: { url: MINI_APP_URL } }]] : []),
      [{ text: '📖 راهنما', callback_data: 'menu:help' }, { text: '💬 ارسال نظر', callback_data: 'feedback' }],
    ] },
  }),
  help: () => ({
    text: '📖 راهنما\n\nاینجا توضیح بده ربات چه کاری انجام میده.',
    reply_markup: { inline_keyboard: [[back]] },
  }),
};

export function sendHome(message) {
  return api.sendMessage({ chat_id: message.chat.id, ...SCREENS.home(message.from) });
}

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
      ...SCREENS[m[1]](query.from),
    });
  } catch (e) {
    if (!/not modified/i.test(e.description ?? '')) throw e;   // same screen pressed twice
  }
  return true;
}
