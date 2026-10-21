// The ✏️ 🎤 🖼 buttons under every audio the bot sends (lib/audio.js): change
// its title, its artist or its cover.
//
// 1. A button asks for the new value — text, or a photo for the cover — with
//    a ❌ button to cancel. users.pending_action holds
//    `meta:<field>:<sent_audios.id>:<question message id>`.
// 2. The next message answers it (handlers/message.js → applyMetaEdit).
// 3. A new copy of the audio comes back, with the new metadata and the same
//    buttons, so the edits can go on.
//
// Telegram keeps an audio's title, performer and thumbnail with its file:
// changing them means uploading the bytes again. They come back from Telegram
// (getFileContent, up to 20 MB), or from SoundCloud for a bigger file. The
// metadata is also written into the file (lib/tags.js), so a music player
// shows it once the file is saved.

import { api, db, InputFile, BotApiError } from 'sdk';
import { sql } from 'sdk/db';
import { esc } from './html.js';
import { askFor, cancelPending } from './users.js';
import { fileName, mimeOf, sendAudioMessage, infoOf, withTags } from './audio.js';
import { findSoundcloudUrl, getTrack, downloadAudio, coverBytes } from './soundcloud.js';

const QUESTIONS = {
  title: '✏️ اسم جدید آهنگ رو بفرست.',
  artist: '🎤 اسم جدید خواننده رو بفرست.',
  cover: '🖼 عکس کاور جدید رو بفرست (به‌صورت عکس، نه فایل).',
};
const CANCEL = { inline_keyboard: [[{ text: '❌ انصراف', callback_data: 'meta:cancel' }]] };
const TOO_OLD = '⌛️ این فایل قدیمیه و قابل ویرایش نیست. لینکش رو دوباره بفرست.';
const FAILED = '⚠️ نتونستم فایل جدید رو بسازم. کمی بعد دوباره امتحان کن.';

// Longer titles and names are cut: Telegram shows one line of each.
const MAX_TEXT = 100;

const rowOf = (chatId, messageId) => db.get(sql`
  SELECT * FROM sent_audios WHERE chat_id = ${chatId} AND message_id = ${messageId}`);

// Asks for the field's new value under `replyTo`, and waits for it.
async function ask(user, chatId, field, rowId, text, replyTo) {
  const question = await api.sendMessage({
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
    reply_markup: CANCEL,
  });
  await askFor(user, `meta:${field}:${rowId}:${question.message_id}`);
}

// A press on ✏️ 🎤 🖼 under an audio, or on ❌ under the question.
// true when the button was one of these.
export async function handleMetaCallback(query) {
  const m = /^meta:(title|artist|cover|cancel)$/.exec(query.data ?? '');
  if (!m) return false;
  const chatId = query.message?.chat?.id;

  if (m[1] === 'cancel') {
    await cancelPending(query.from.id, 'meta:');
    await api.answerCallbackQuery({ callback_query_id: query.id, text: 'لغو شد' }).catch(console.error);
    if (query.message) {
      await api.editMessageText({ chat_id: chatId, message_id: query.message.message_id, text: '❌ ویرایش لغو شد.' })
        .catch(console.error);
    }
    return true;
  }

  // Only the chat's own user edits its audios (in a private chat, they are the chat).
  const row = query.message && chatId === query.from.id ? await rowOf(chatId, query.message.message_id) : null;
  if (!row) {
    await api.answerCallbackQuery({ callback_query_id: query.id, text: TOO_OLD, show_alert: true }).catch(console.error);
    return true;
  }
  await api.answerCallbackQuery({ callback_query_id: query.id }).catch(console.error);
  const now = m[1] === 'title' ? row.title : m[1] === 'artist' ? row.artist : null;
  const text = `${QUESTIONS[m[1]]}${now ? `\nالان: <b>${esc(now)}</b>` : ''}`;
  await ask(query.from, chatId, m[1], row.id, text, query.message.message_id);
  return true;
}

// The largest size of a photo whose longer side is at most `max` px (Telegram
// sends several, smallest first), or the smallest one.
function photoSize(photo, max) {
  const fits = photo.filter((p) => Math.max(p.width, p.height) <= max);
  return (fits.length ? fits[fits.length - 1] : photo[0]).file_id;
}

// The cover for the new copy: the user's photo, or SoundCloud's artwork.
// `thumb`: for the Telegram thumbnail (≤ 320 px, < 200 KB); otherwise the
// bigger one written into the file. null when there is none.
async function cover(info, thumb) {
  if (info.coverFileId) {
    return api.getFileContent(thumb ? info.coverThumbId ?? info.coverFileId : info.coverFileId).catch((e) => {
      console.error(e);
      return null;
    });
  }
  return thumb ? coverBytes(info.artworkUrl, 't300x300', 200 * 1024) : coverBytes(info.artworkUrl, 't500x500', 1024 * 1024);
}

// The audio's bytes again: from Telegram (getFile goes up to 20 MB), or
// downloaded again from SoundCloud for a bigger file. → { bytes, ext }
async function audioBytes(row) {
  try {
    // An AAC copy from before the rename (.m4a) comes back as .mp4.
    return { bytes: await api.getFileContent(row.file_id), ext: row.ext === 'm4a' ? 'mp4' : row.ext ?? 'mp3' };
  } catch (e) {
    if (!(e instanceof BotApiError) || !row.permalink_url) throw e;
    const file = await downloadAudio(await getTrack(row.permalink_url));
    return { bytes: file.bytes, ext: file.ext };
  }
}

// The answer to a ✏️ 🎤 🖼 question (`pending`, from takePending): a new copy
// of the audio with it. false when the message is not an answer after all —
// a SoundCloud link is downloaded instead (handlers/message.js goes on).
export async function applyMetaEdit(message, pending) {
  const m = /^meta:(title|artist|cover):(\d+):(\d+)$/.exec(pending ?? '');
  if (!m) return false;
  const [, field, rowId, questionId] = m;
  const text = (message.text ?? '').trim();
  if (findSoundcloudUrl(text)) return false;

  const chatId = message.chat.id;
  const row = await db.get(sql`SELECT * FROM sent_audios WHERE id = ${Number(rowId)} AND chat_id = ${chatId}`);
  if (!row) {
    await api.sendMessage({ chat_id: chatId, text: TOO_OLD });
    return true;
  }

  const info = { ...infoOf(row), edited: true };
  if (field === 'cover') {
    if (!message.photo?.length) {
      await api.deleteMessage({ chat_id: chatId, message_id: Number(questionId) }).catch(() => {});
      await ask(message.from, chatId, field, row.id, '🖼 یه عکس بفرست؛ به‌صورت عکس، نه فایل.', message.message_id);
      return true;
    }
    info.coverFileId = photoSize(message.photo, 1280);
    info.coverThumbId = photoSize(message.photo, 320);
  } else {
    if (!text || text.startsWith('/')) {
      await api.deleteMessage({ chat_id: chatId, message_id: Number(questionId) }).catch(() => {});
      await ask(message.from, chatId, field, row.id, `✍️ ${field === 'title' ? 'اسم آهنگ' : 'اسم خواننده'} رو به‌صورت متن بفرست.`, message.message_id);
      return true;
    }
    info[field] = text.slice(0, MAX_TEXT);
  }

  // The question is answered: its ❌ goes away with it.
  await api.deleteMessage({ chat_id: chatId, message_id: Number(questionId) }).catch(() => {});
  const status = await api.sendMessage({
    chat_id: chatId,
    text: '⏳ دارم فایل رو با اطلاعات جدید می‌سازم…',
    reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
  });
  try {
    await api.sendChatAction({ chat_id: chatId, action: 'upload_voice' }).catch(console.error);
    const file = await audioBytes(row);
    const [embedded, thumbnail] = await Promise.all([cover(info, false), cover(info, true)]);
    const bytes = withTags(file.bytes, file.ext, { title: info.title, artist: info.artist, cover: embedded });
    info.ext = file.ext;
    const upload = new InputFile(bytes, fileName({ id: row.track_id, ...info }, file.ext), { type: mimeOf(file.ext) });
    await sendAudioMessage(chatId, upload, info, { thumbnail, replyTo: message.message_id });
    await api.deleteMessage({ chat_id: chatId, message_id: status.message_id }).catch(console.error);
  } catch (e) {
    console.error(e);
    await api.editMessageText({ chat_id: chatId, message_id: status.message_id, text: FAILED }).catch(console.error);
  }
  return true;
}
