// The bot's one job: a SoundCloud link sent to it in a private chat comes
// back as an audio message (handlers/message.js → replyDownload).
//
// 1. A status message ("⏳ …") answers the link right away.
// 2. The link is resolved to a track (lib/soundcloud.js).
// 3. A track already on Telegram (`tracks`) is sent again by its file_id.
//    Otherwise its audio is downloaded, uploaded with sendAudio, and the
//    file_id is kept for next time.
// 4. The status message is deleted, or edited into the reason it failed.
// Every link gets a row in `downloads`: what came of it, and how long it took.

import { api, db, InputFile, BotApiError } from 'sdk';
import { sql } from 'sdk/db';
import { esc } from './html.js';
import { botUsername } from './bot.js';
import { findSoundcloudUrl, getTrack, downloadAudio, artwork, SoundcloudError } from './soundcloud.js';

// What the user reads for each SoundcloudError code (INTERNAL: anything else).
const ERRORS = {
  NOT_FOUND: '🔍 این ترک پیدا نشد. شاید پاک شده یا خصوصیه (برای ترک خصوصی، لینک مخفی‌ش رو بفرست).',
  NOT_TRACK: '🎵 فعلاً فقط لینک یه ترک رو می‌تونم دانلود کنم، نه پلی‌لیست، آلبوم یا پروفایل.',
  BLOCKED: '🚫 این ترک از جایی که ربات کار می‌کنه در دسترس نیست.',
  PREVIEW_ONLY: '💎 این ترک فقط برای مشترک‌های SoundCloud Go+ کامله و فقط ۳۰ ثانیه‌ش عمومیه.',
  NO_STREAM: '🔒 ساندکلاد این ترک رو فقط به‌صورت رمزگذاری‌شده پخش می‌کنه و قابل دانلود نیست.',
  TOO_LONG: '⏱ این ترک خیلی طولانیه. تلگرام فایل بزرگ‌تر از ۵۰ مگابایت رو از ربات قبول نمی‌کنه.',
  TOO_BIG: '📦 فایل این ترک از ۵۰ مگابایت بزرگ‌تره و تلگرام از ربات قبولش نمی‌کنه.',
  RATE_LIMITED: '🐢 ساندکلاد الان درخواست زیادی گرفته. چند دقیقه‌ی دیگه دوباره امتحان کن.',
  NO_CLIENT_ID: '🛠 ارتباط با ساندکلاد موقتاً مشکل داره. کمی بعد دوباره امتحان کن.',
  UNREACHABLE: '📡 الان به ساندکلاد دسترسی ندارم. کمی بعد دوباره امتحان کن.',
  INTERNAL: '⚠️ یه مشکلی پیش اومد. کمی بعد دوباره امتحان کن.',
};

// "Artist - Title.mp3", without characters file systems refuse.
export function fileName(track, ext) {
  const base = [track.artist, track.title].filter(Boolean).join(' - ')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
  return `${base || `soundcloud-${track.id}`}.${ext}`;
}

async function caption(track) {
  const link = track.permalink ? `<a href="${esc(track.permalink)}">SoundCloud</a> · ` : '';
  return `${link}@${esc(await botUsername())}`;
}

// ---------- the file_id cache ----------

async function cached(trackId) {
  return db.get(sql`SELECT file_id FROM tracks WHERE track_id = ${trackId}`);
}

async function remember(track, audio, { size, format }) {
  await db.run(sql`
    INSERT INTO tracks (track_id, permalink_url, title, artist, duration, file_id, file_unique_id, size, format, sends)
    VALUES (${track.id}, ${track.permalink}, ${track.title}, ${track.artist}, ${track.duration},
            ${audio.file_id}, ${audio.file_unique_id ?? null}, ${size}, ${format}, 1)
    ON CONFLICT (track_id) DO UPDATE SET
      file_id = excluded.file_id,
      file_unique_id = excluded.file_unique_id,
      size = excluded.size,
      format = excluded.format,
      sends = coalesce(tracks.sends, 0) + 1,
      last_sent_at = unixepoch()`);
}

const sentAgain = (trackId) => db.run(sql`
  UPDATE tracks SET sends = coalesce(sends, 0) + 1, last_sent_at = unixepoch() WHERE track_id = ${trackId}`);

const forget = (trackId) => db.run(sql`DELETE FROM tracks WHERE track_id = ${trackId}`);

// Never throws: logging must not turn a delivered track into an error.
async function log(row) {
  try {
    await db.run(sql`
      INSERT INTO downloads (user_id, url, track_id, status, error, ms)
      VALUES (${row.userId}, ${row.url}, ${row.trackId ?? null}, ${row.status}, ${row.error ?? null}, ${row.ms})`);
  } catch (e) {
    console.error(e);
  }
}

// ---------- delivery ----------

// The audio message: by file_id (a string) or as a new upload (an InputFile).
async function sendAudio(message, track, audio, thumbnail) {
  return api.sendAudio({
    chat_id: message.chat.id,
    audio,
    title: track.title,
    performer: track.artist || undefined,
    duration: track.duration || undefined,
    ...(thumbnail ? { thumbnail: new InputFile(thumbnail, 'cover.jpg', { type: 'image/jpeg' }) } : {}),
    caption: await caption(track),
    parse_mode: 'HTML',
    reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
  });
}

// The track as audio: the kept file_id when there is one, otherwise
// downloaded and uploaded. → 'cached' | 'sent'
async function deliver(message, track) {
  const hit = await cached(track.id);
  if (hit) {
    try {
      await sendAudio(message, track, hit.file_id);
      await sentAgain(track.id);
      return 'cached';
    } catch (e) {
      // A file_id Telegram no longer knows: forget it and upload again.
      if (!(e instanceof BotApiError && e.code === 400)) throw e;
      await forget(track.id);
    }
  }
  await api.sendChatAction({ chat_id: message.chat.id, action: 'upload_voice' }).catch(console.error);
  const file = await downloadAudio(track);
  const thumbnail = await artwork(track);
  const sent = await sendAudio(message, track, new InputFile(file.bytes, fileName(track, file.ext), { type: file.type }), thumbnail);
  if (sent?.audio?.file_id) await remember(track, sent.audio, { size: file.bytes.length, format: file.format });
  return 'sent';
}

// The message's SoundCloud link, downloaded and sent back. false when the
// text has no SoundCloud link (handlers/message.js goes on).
export async function replyDownload(message, text) {
  const link = findSoundcloudUrl(text);
  if (!link) return false;
  const started = Date.now();
  const status = await api.sendMessage({
    chat_id: message.chat.id,
    text: '⏳ دارم از ساندکلاد می‌گیرمش…',
    reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
  });
  let track = null;
  try {
    track = await getTrack(link);
    const result = await deliver(message, track);
    await log({ userId: message.from.id, url: link.url, trackId: track.id, status: result, ms: Date.now() - started });
    await api.deleteMessage({ chat_id: message.chat.id, message_id: status.message_id }).catch(console.error);
  } catch (e) {
    const code = e instanceof SoundcloudError ? e.code : 'INTERNAL';
    if (code === 'INTERNAL' || code === 'NO_CLIENT_ID') console.error(e);
    await log({ userId: message.from.id, url: link.url, trackId: track?.id, status: 'failed', error: code, ms: Date.now() - started });
    await api.editMessageText({ chat_id: message.chat.id, message_id: status.message_id, text: ERRORS[code] ?? ERRORS.INTERNAL })
      .catch(console.error);
  }
  return true;
}

// ---------- /stats ----------

// Downloads overall and lately, the tracks on Telegram, and why links failed.
export async function downloadStats() {
  const s = await db.get(sql`
    SELECT count(*) AS links,
           coalesce(sum(status = 'sent'), 0) AS sent,
           coalesce(sum(status = 'cached'), 0) AS cached,
           coalesce(sum(status = 'failed'), 0) AS failed,
           count(DISTINCT user_id) AS users,
           coalesce(sum(created_at > unixepoch() - 86400), 0) AS links_1d,
           count(DISTINCT CASE WHEN created_at > unixepoch() - 86400 THEN user_id END) AS users_1d
    FROM downloads`);
  const tracksKept = await db.get(sql`SELECT count(*) AS n FROM tracks`);
  const errors = await db.all(sql`
    SELECT error, count(*) AS n FROM downloads WHERE status = 'failed' GROUP BY error ORDER BY n DESC, error`);
  // Raw SQL: aggregates may come back as strings.
  return {
    ...Object.fromEntries(Object.entries(s ?? {}).map(([k, v]) => [k, Number(v ?? 0)])),
    tracks: Number(tracksKept?.n ?? 0),
    errors: errors.map((e) => ({ error: e.error ?? '—', n: Number(e.n) })),
  };
}
