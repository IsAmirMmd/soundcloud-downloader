// An audio message the bot sends — a downloaded track, a cached one, or an
// edited copy (lib/download.js, lib/metadata.js): its file name, caption and
// ✏️ 🎤 🖼 buttons, and the `sent_audios` row that lets those buttons make a
// copy with new metadata.

import { api, db, InputFile } from 'sdk';
import { sql } from 'sdk/db';
import { MAX_AUDIO_BYTES } from './config.js';
import { esc } from './html.js';
import { botUsername } from './bot.js';
import { tagAudio } from './tags.js';

// Under every audio: change its title, its artist or its cover (lib/metadata.js).
export const META_BUTTONS = { inline_keyboard: [
  [{ text: '✏️ اسم آهنگ', callback_data: 'meta:title' }, { text: '🎤 خواننده', callback_data: 'meta:artist' }],
  [{ text: '🖼 کاور', callback_data: 'meta:cover' }],
] };

// "Artist - Title.m4a" (or .mp3), without characters file systems refuse.
export function fileName({ id, artist, title }, ext) {
  const base = [artist, title].filter(Boolean).join(' - ')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
  return `${base || `soundcloud-${id ?? 'track'}`}.${ext}`;
}

export const mimeOf = (ext) => (ext === 'm4a' ? 'audio/mp4' : 'audio/mpeg');

// The file with its title, artist and cover written in (lib/tags.js): the
// thumbnail sendAudio takes is Telegram's own, and a saved file shows only
// what is inside it. The cover is left out when it would push the file over
// the upload limit; a layout tags.js can't rewrite goes as it is.
export function withTags(bytes, ext, { title, artist, cover }) {
  const fits = cover && bytes.length + cover.length <= MAX_AUDIO_BYTES;
  return tagAudio(bytes, ext, { title, artist, cover: fits ? cover : null }) ?? bytes;
}

async function caption(permalink) {
  const link = permalink ? `<a href="${esc(permalink)}">SoundCloud</a> · ` : '';
  return `${link}@${esc(await botUsername())}`;
}

// Sends `audio` (a file_id, or an InputFile to upload) with its metadata and
// the buttons, and remembers what is in it. → the sent Message.
// info: { trackId, permalink, ext, title, artist, duration, artworkUrl,
//         coverFileId, coverThumbId, edited }
export async function sendAudioMessage(chatId, audio, info, { thumbnail = null, replyTo = null } = {}) {
  const sent = await api.sendAudio({
    chat_id: chatId,
    audio,
    title: info.title,
    performer: info.artist || undefined,
    duration: info.duration || undefined,
    ...(thumbnail ? { thumbnail: new InputFile(thumbnail, 'cover.jpg', { type: 'image/jpeg' }) } : {}),
    caption: await caption(info.permalink),
    parse_mode: 'HTML',
    ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
    reply_markup: META_BUTTONS,
  });
  await remember(chatId, sent, info);
  return sent;
}

// Never throws: the audio is delivered either way. Without a row, its buttons
// only say the file is too old to edit.
async function remember(chatId, sent, info) {
  if (!sent?.audio?.file_id) return;
  const ext = info.ext ?? (/mp4|m4a|aac/i.test(sent.audio.mime_type ?? '') ? 'm4a' : 'mp3');
  try {
    await db.run(sql`
      INSERT INTO sent_audios (chat_id, message_id, track_id, permalink_url, file_id, ext, title, artist, duration,
                               artwork_url, cover_file_id, cover_thumb_id, edited)
      VALUES (${chatId}, ${sent.message_id}, ${info.trackId ?? null}, ${info.permalink ?? null}, ${sent.audio.file_id},
              ${ext}, ${info.title ?? null}, ${info.artist ?? null}, ${info.duration ?? null}, ${info.artworkUrl ?? null},
              ${info.coverFileId ?? null}, ${info.coverThumbId ?? null}, ${info.edited ? 1 : 0})
      ON CONFLICT (chat_id, message_id) DO NOTHING`);
  } catch (e) {
    console.error(e);
  }
}

// What a `sent_audios` row says, in the shape sendAudioMessage takes.
export const infoOf = (row) => ({
  trackId: row.track_id,
  permalink: row.permalink_url,
  ext: row.ext,
  title: row.title,
  artist: row.artist,
  duration: row.duration,
  artworkUrl: row.artwork_url,
  coverFileId: row.cover_file_id,
  coverThumbId: row.cover_thumb_id,
});
