// Search inside the bot: a private message that is no link and no command
// (handlers/message.js → replySearch) is looked up on SoundCloud, and the
// results come back as buttons, one per track:
//   dl:<track id>             download it, like a link (lib/download.js sendTrack)
//   sr:<search id>:<offset>   ◀️ ▶️ another page, in the same message
// The text is kept in `searches`: callback_data holds only 64 bytes.

import { api, db } from 'sdk';
import { sql } from 'sdk/db';
import { esc, clip, clock } from './html.js';
import { ERRORS, sendTrack } from './download.js';
import { searchTracks, getTrackById, SoundcloudError } from './soundcloud.js';

// Tracks asked of SoundCloud per page (a page shows those the bot can deliver).
const PAGE = 8;
// Shorter texts get the hint instead (handlers/message.js).
const MIN_QUERY = 2;

const label = (t) => `🎵 ${clip(t.artist ? `${t.title} — ${t.artist}` : t.title, 48)} · ${clock(t.duration)}`;

// A page of results for `q` from `offset` → { text, reply_markup? }.
async function page(searchId, q, offset) {
  let found;
  try {
    found = await searchTracks(q, { offset, limit: PAGE });
  } catch (e) {
    if (!(e instanceof SoundcloudError)) throw e;
    return { text: ERRORS[e.code] ?? ERRORS.INTERNAL };
  }
  const nav = [
    ...(offset > 0 ? [{ text: '◀️ قبلی', callback_data: `sr:${searchId}:${Math.max(0, offset - PAGE)}` }] : []),
    ...(found.next != null ? [{ text: 'بعدی ▶️', callback_data: `sr:${searchId}:${found.next}` }] : []),
  ];
  if (!found.tracks.length && offset === 0) {
    return { text: `🔍 برای «${esc(q)}» آهنگی پیدا نکردم که بشه دانلودش کرد.\nیه اسم دیگه امتحان کن یا لینک ترک رو بفرست.`, parse_mode: 'HTML' };
  }
  return {
    text: found.tracks.length
      ? `🔎 نتیجه‌های «${esc(q)}»\nروی یه آهنگ بزن تا دانلود بشه 👇`
      : `🔎 «${esc(q)}»: این صفحه چیزی نداشت که بشه دانلودش کرد.`,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [
      ...found.tracks.map((t) => [{ text: label(t), callback_data: `dl:${t.id}` }]),
      ...(nav.length ? [nav] : []),
    ] },
  };
}

// A private message's text, searched; the first page of results as an answer.
// false when it is too short to search (handlers/message.js goes on).
export async function replySearch(message, text) {
  const q = text.trim().replace(/\s+/g, ' ').slice(0, 100);
  if (q.length < MIN_QUERY) return false;
  await api.sendChatAction({ chat_id: message.chat.id, action: 'typing' }).catch(console.error);
  const saved = await db.run(sql`INSERT INTO searches (user_id, query) VALUES (${message.from.id}, ${q}) RETURNING id`);
  const id = Number(saved.rows?.[0]?.id ?? saved.lastInsertRowid);
  await api.sendMessage({
    chat_id: message.chat.id,
    ...(await page(id, q, 0)),
    reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
  });
  return true;
}

// A press on a result (dl:) or on ◀️ ▶️ (sr:). true when the button was one of these.
export async function handleSearchCallback(query) {
  const download = /^dl:(\d+)$/.exec(query.data ?? '');
  if (download) {
    await api.answerCallbackQuery({ callback_query_id: query.id, text: '⏳ دانلودش شروع شد' }).catch(console.error);
    const id = Number(download[1]);
    await sendTrack(
      { chatId: query.message?.chat?.id ?? query.from.id, replyTo: query.message?.message_id },
      () => getTrackById(id),
      { userId: query.from.id, url: `soundcloud:tracks:${id}`, via: 'search' });
    return true;
  }

  const more = /^sr:(\d+):(\d+)$/.exec(query.data ?? '');
  if (!more) return false;
  const search = await db.get(sql`SELECT query FROM searches WHERE id = ${Number(more[1])} AND user_id = ${query.from.id}`);
  if (!search || !query.message) {
    await api.answerCallbackQuery({ callback_query_id: query.id, text: '⌛️ این جستجو قدیمیه؛ دوباره اسم آهنگ رو بفرست.', show_alert: true })
      .catch(console.error);
    return true;
  }
  await api.answerCallbackQuery({ callback_query_id: query.id }).catch(console.error);
  try {
    await api.editMessageText({
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      ...(await page(Number(more[1]), search.query, Number(more[2]))),
    });
  } catch (e) {
    if (!/not modified/i.test(e.description ?? '')) throw e;   // the same page pressed twice
  }
  return true;
}

// For /stats: searches overall and lately.
export async function searchStats() {
  const s = await db.get(sql`
    SELECT count(*) AS searches, count(DISTINCT user_id) AS users,
           coalesce(sum(created_at > unixepoch() - 86400), 0) AS searches_1d
    FROM searches`);
  return Object.fromEntries(Object.entries(s ?? {}).map(([k, v]) => [k, Number(v ?? 0)]));
}
