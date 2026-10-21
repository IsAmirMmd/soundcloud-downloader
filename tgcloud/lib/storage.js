// The storage channel (config.js STORAGE_CHAT_ID): each track is uploaded
// there once, and users get it by that post's file_id (lib/download.js). The
// channel is the cache's archive: one post per track, with its name, artist,
// SoundCloud link and #t<id> to search by. Edited copies (✏️ 🎤 🖼) are
// personal and never go there.
//
// The channel failing (the bot removed, its rights taken) must not cost a
// user their track: these return null instead, the caller uploads straight
// to the user, and the admin hears of it at most once an hour.

import { api, BotApiError, InputFile } from 'sdk';
import { ADMIN_ID, STORAGE_CHAT_ID } from './config.js';
import { esc } from './html.js';
import { getSetting, setSetting } from './settings.js';
import { now } from './time.js';

const WARN_EVERY = 3600;

function caption(track) {
  const lines = [`🎵 <b>${esc(track.title)}</b>`];
  if (track.artist) lines.push(`🎤 ${esc(track.artist)}`);
  if (track.permalink) lines.push(`🔗 <a href="${esc(track.permalink)}">SoundCloud</a>`);
  lines.push(`#t${track.id}`);
  return lines.join('\n');
}

async function warnAdmin(e) {
  try {
    if (Number(await getSetting('storage:warned_at') ?? 0) > now() - WARN_EVERY) return;
    await setSetting('storage:warned_at', String(now()));
    await api.sendMessage({
      chat_id: ADMIN_ID,
      text: `⚠️ Storage channel ${STORAGE_CHAT_ID}: ${e.description ?? e.message}\n` +
        'Tracks go straight to users meanwhile. Is the bot still its admin, allowed to post? Check with /sc.',
    });
  } catch (err) {
    console.error(err);
  }
}

// Posts `audio` (an InputFile, or a file_id already on Telegram) to the
// channel, with `thumbnail` (JPEG bytes) when it is an upload. → { file_id, file_unique_id, message_id }, or null when there is
// no channel or it refused.
export async function storeTrack(track, audio, { thumbnail = null, duration } = {}) {
  if (!STORAGE_CHAT_ID) return null;
  try {
    const post = await api.sendAudio({
      chat_id: STORAGE_CHAT_ID,
      audio,
      title: track.title,
      performer: track.artist || undefined,
      duration: duration || track.duration || undefined,
      ...(thumbnail ? { thumbnail: new InputFile(thumbnail, 'cover.jpg', { type: 'image/jpeg' }) } : {}),
      caption: caption(track),
      parse_mode: 'HTML',
      disable_notification: true,
    });
    if (!post?.audio?.file_id) return null;
    return { file_id: post.audio.file_id, file_unique_id: post.audio.file_unique_id ?? null, message_id: post.message_id };
  } catch (e) {
    if (!(e instanceof BotApiError)) throw e;
    console.error(e);
    await warnAdmin(e);
    return null;
  }
}

// Can the bot post there? For /sc and endpoints/adminProbe.
// → { title, status, canPost }
export async function storageStatus() {
  if (!STORAGE_CHAT_ID) return null;
  const [chat, me] = await Promise.all([api.getChat({ chat_id: STORAGE_CHAT_ID }), api.getMe()]);
  const member = await api.getChatMember({ chat_id: STORAGE_CHAT_ID, user_id: me.id });
  const canPost = member.status === 'creator' || (member.status === 'administrator' && member.can_post_messages !== false);
  return { title: chat.title ?? '', status: member.status, canPost };
}
