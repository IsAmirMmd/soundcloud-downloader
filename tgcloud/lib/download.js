// The bot's one job: a SoundCloud link sent to it in a private chat comes
// back as an audio message (handlers/message.js → replyDownload).
//
// 1. A status message ("⏳ …") answers the link right away.
// 2. The link is resolved to a track (lib/soundcloud.js).
// 3. A track already on Telegram (`tracks`) is sent again by its file_id.
//    Otherwise its audio is downloaded, its title, artist and cover are
//    written into the file (lib/tags.js), it is uploaded once to the storage
//    channel (lib/storage.js), and the user gets that post's file_id, kept
//    for next time. A cached track not in the channel yet is posted there by
//    its file_id on its next request. Without the channel, the upload goes
//    straight to the user.
// 4. The status message is deleted, or edited into the reason it failed.
// Every link gets a row in `downloads`: what came of it, and how long it took.
// The audio carries ✏️ 🎤 🖼 buttons to change its metadata (lib/audio.js,
// lib/metadata.js).

import { api, db, InputFile, BotApiError } from 'sdk';
import { sql } from 'sdk/db';
import { fileName, mimeOf, sendAudioMessage, withTags } from './audio.js';
import { storeTrack } from './storage.js';
import { findSoundcloudUrl, getTrack, downloadAudio, artwork, coverBytes, SoundcloudError } from './soundcloud.js';

// What the user reads for each SoundcloudError code (INTERNAL: anything else).
export const ERRORS = {
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

// ---------- the file_id cache ----------

// What goes into an uploaded file. A kept file_id from an older version is
// not reused: the track is downloaded and uploaded again, once. Bump it when
// the files change. 1: title, artist and cover written in (until then, the
// cover was only Telegram's thumbnail, and saved files had none). 2: AAC
// files named .mp4 instead of .m4a.
const FILE_VERSION = 2;

async function cached(trackId) {
  return db.get(sql`
    SELECT file_id, format, storage_message_id FROM tracks
    WHERE track_id = ${trackId} AND coalesce(tags_version, 0) >= ${FILE_VERSION}`);
}

// `audio`: { file_id, file_unique_id } of the upload; `stored`: its post in
// the storage channel, if it went there.
async function remember(track, audio, { size, format, stored = null }) {
  await db.run(sql`
    INSERT INTO tracks (track_id, permalink_url, title, artist, duration, file_id, file_unique_id, size, format, tags_version,
                        storage_message_id, sends)
    VALUES (${track.id}, ${track.permalink}, ${track.title}, ${track.artist}, ${track.duration},
            ${audio.file_id}, ${audio.file_unique_id ?? null}, ${size}, ${format}, ${FILE_VERSION},
            ${stored?.message_id ?? null}, 1)
    ON CONFLICT (track_id) DO UPDATE SET
      file_id = excluded.file_id,
      file_unique_id = excluded.file_unique_id,
      size = excluded.size,
      format = excluded.format,
      tags_version = excluded.tags_version,
      storage_message_id = excluded.storage_message_id,
      sends = coalesce(tracks.sends, 0) + 1,
      last_sent_at = unixepoch()`);
}

const sentAgain = (trackId) => db.run(sql`
  UPDATE tracks SET sends = coalesce(sends, 0) + 1, last_sent_at = unixepoch() WHERE track_id = ${trackId}`);

const forget = (trackId) => db.run(sql`DELETE FROM tracks WHERE track_id = ${trackId}`);

// A track kept from before the channel, posted there by its file_id (no new
// upload). Never throws: the user already has the track.
async function archive(track, fileId) {
  try {
    const stored = await storeTrack(track, fileId);
    if (stored) await db.run(sql`UPDATE tracks SET storage_message_id = ${stored.message_id} WHERE track_id = ${track.id}`);
  } catch (e) {
    console.error(e);
  }
}

// Never throws: logging must not turn a delivered track into an error.
// `via`: how the track was asked for — 'link', 'search' (lib/search.js) or
// 'inline' (lib/inline.js).
export async function logDownload(row) {
  try {
    await db.run(sql`
      INSERT INTO downloads (user_id, url, track_id, status, error, ms, via)
      VALUES (${row.userId}, ${row.url}, ${row.trackId ?? null}, ${row.status}, ${row.error ?? null}, ${row.ms}, ${row.via ?? 'link'})`);
  } catch (e) {
    console.error(e);
  }
}

// ---------- the file ----------

// The track downloaded, its title, artist and cover written in, ready to
// upload. → { upload (an InputFile), thumbnail, size, ext, format }
async function prepare(track) {
  const file = await downloadAudio(track);
  // The 300 px artwork is Telegram's thumbnail; the 500 px one goes into the file.
  const [thumbnail, cover] = await Promise.all([artwork(track), coverBytes(track.artworkUrl, 't500x500', 1024 * 1024)]);
  const bytes = withTags(file.bytes, file.ext, { title: track.title, artist: track.artist, cover });
  const upload = new InputFile(bytes, fileName(track, file.ext), { type: mimeOf(file.ext) });
  return { upload, thumbnail, size: bytes.length, ext: file.ext, format: file.format };
}

// The track as a file on Telegram, with no chat to upload to — for inline
// messages (lib/inline.js), which take a file_id and nothing else: the kept
// one, or a new upload to the storage channel. → { fileId, cached }
// Throws (code NO_STORAGE) when the channel can't take it.
export async function storedFile(track) {
  const hit = await cached(track.id);
  if (hit) {
    await sentAgain(track.id);
    if (!hit.storage_message_id) await archive(track, hit.file_id);
    return { fileId: hit.file_id, cached: true };
  }
  const file = await prepare(track);
  const stored = await storeTrack(track, file.upload, { thumbnail: file.thumbnail });
  if (!stored) throw Object.assign(new Error('the storage channel refused the upload'), { code: 'NO_STORAGE' });
  await remember(track, stored, { size: file.size, format: file.format, stored });
  return { fileId: stored.file_id, cached: false };
}

// A kept file_id Telegram no longer knows (a 400 when it is sent): dropped,
// so the next try uploads the track again.
export const forgetFile = (trackId) => forget(trackId);

// The kept file_ids of these tracks → { [track id]: file_id }, for inline
// results that can be the audio itself.
export async function keptFiles(trackIds) {
  if (!trackIds.length) return {};
  const ids = trackIds.map(Number).filter(Number.isFinite);
  const kept = await db.all(sql`
    SELECT track_id, file_id FROM tracks
    WHERE track_id IN (${ids.map((id) => sql`${id}`).reduce((a, b) => sql`${a}, ${b}`)})
      AND coalesce(tags_version, 0) >= ${FILE_VERSION}`);
  return Object.fromEntries(kept.map((r) => [Number(r.track_id), r.file_id]));
}

// ---------- delivery ----------

// The audio message to target.chatId (a reply to target.replyTo): by file_id
// (a string) or as a new upload (an InputFile).
function sendAudio(target, track, audio, { ext, thumbnail } = {}) {
  const info = {
    trackId: track.id,
    permalink: track.permalink,
    ext,
    title: track.title,
    artist: track.artist,
    duration: track.duration,
    artworkUrl: track.artworkUrl,
  };
  return sendAudioMessage(target.chatId, audio, info, { thumbnail, replyTo: target.replyTo });
}

// The track as audio: the kept file_id when there is one, otherwise
// downloaded, posted to the storage channel and sent from there.
// → 'cached' | 'sent'
async function deliver(target, track) {
  const hit = await cached(track.id);
  if (hit) {
    try {
      await sendAudio(target, track, hit.file_id, { ext: /audio\/mp4/.test(hit.format ?? '') ? 'mp4' : 'mp3' });
      await sentAgain(track.id);
      if (!hit.storage_message_id) await archive(track, hit.file_id);
      return 'cached';
    } catch (e) {
      // A file_id Telegram no longer knows: forget it and upload again.
      if (!(e instanceof BotApiError && e.code === 400)) throw e;
      await forget(track.id);
    }
  }
  await api.sendChatAction({ chat_id: target.chatId, action: 'upload_voice' }).catch(console.error);
  const file = await prepare(track);
  // Once into the channel, then to the user by that file_id; straight to the
  // user when the channel can't take it.
  const stored = await storeTrack(track, file.upload, { thumbnail: file.thumbnail });
  if (stored) {
    await sendAudio(target, track, stored.file_id, { ext: file.ext });
    await remember(track, stored, { size: file.size, format: file.format, stored });
    return 'sent';
  }
  const sent = await sendAudio(target, track, file.upload, { ext: file.ext, thumbnail: file.thumbnail });
  if (sent?.audio?.file_id) await remember(track, sent.audio, { size: file.size, format: file.format });
  return 'sent';
}

// A track to target.chatId: "⏳" at once (a reply to target.replyTo), then
// `load()` gives the track, the audio follows, and the status message goes —
// or turns into the reason it failed. Every request is a `downloads` row.
// opts: { userId, url (the link, or what stands for it), via }
export async function sendTrack(target, load, { userId, url, via = 'link' }) {
  const started = Date.now();
  const status = await api.sendMessage({
    chat_id: target.chatId,
    text: '⏳ دارم از ساندکلاد می‌گیرمش…',
    ...(target.replyTo ? { reply_parameters: { message_id: target.replyTo, allow_sending_without_reply: true } } : {}),
  });
  let track = null;
  // A link is logged as sent; anything else by the track's page once known.
  const urlOf = () => (via === 'link' ? url : track?.permalink ?? url);
  try {
    track = await load();
    const result = await deliver(target, track);
    await logDownload({ userId, url: urlOf(), trackId: track.id, status: result, via, ms: Date.now() - started });
    await api.deleteMessage({ chat_id: target.chatId, message_id: status.message_id }).catch(console.error);
  } catch (e) {
    const code = e instanceof SoundcloudError ? e.code : 'INTERNAL';
    if (code === 'INTERNAL' || code === 'NO_CLIENT_ID') console.error(e);
    await logDownload({ userId, url: urlOf(), trackId: track?.id, status: 'failed', error: code, via, ms: Date.now() - started });
    await api.editMessageText({ chat_id: target.chatId, message_id: status.message_id, text: ERRORS[code] ?? ERRORS.INTERNAL })
      .catch(console.error);
  }
}

// The message's SoundCloud link, downloaded and sent back. false when the
// text has no SoundCloud link (handlers/message.js goes on).
export async function replyDownload(message, text) {
  const link = findSoundcloudUrl(text);
  if (!link) return false;
  await sendTrack({ chatId: message.chat.id, replyTo: message.message_id }, () => getTrack(link),
    { userId: message.from.id, url: link.url, via: 'link' });
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
           count(DISTINCT CASE WHEN created_at > unixepoch() - 86400 THEN user_id END) AS users_1d,
           coalesce(sum(via = 'search'), 0) AS from_search,
           coalesce(sum(via = 'inline'), 0) AS from_inline
    FROM downloads`);
  const tracksKept = await db.get(sql`SELECT count(*) AS n FROM tracks`);
  const edits = await db.get(sql`SELECT count(*) AS n, count(DISTINCT chat_id) AS users FROM sent_audios WHERE edited = 1`);
  const stored = await db.get(sql`SELECT count(*) AS n FROM tracks WHERE storage_message_id IS NOT NULL`);
  const errors = await db.all(sql`
    SELECT error, count(*) AS n FROM downloads WHERE status = 'failed' GROUP BY error ORDER BY n DESC, error`);
  // Raw SQL: aggregates may come back as strings.
  return {
    ...Object.fromEntries(Object.entries(s ?? {}).map(([k, v]) => [k, Number(v ?? 0)])),
    tracks: Number(tracksKept?.n ?? 0),
    stored: Number(stored?.n ?? 0),
    edits: Number(edits?.n ?? 0),
    edit_users: Number(edits?.users ?? 0),
    errors: errors.map((e) => ({ error: e.error ?? '—', n: Number(e.n) })),
  };
}
