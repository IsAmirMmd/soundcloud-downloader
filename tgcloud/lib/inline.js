// Inline mode: `@bot <song>` in any chat (handlers/inline_query.js) searches
// SoundCloud (lib/soundcloud.js searchTracks).
// - A track already on Telegram (`tracks`) is offered as itself: a cached
//   audio, sent the moment it is picked.
// - Any other is offered as a short "🎵 name / ⏳" message with a button. Once
//   it is sent (handlers/chosen_inline_result.js — needs BotFather
//   /setinlinefeedback), or its button pressed (il:<track id>, the same without
//   feedback), the bot gets the track's file and turns that message into the
//   audio with editMessageMedia.
// An inline message can't take a new upload — a file_id or a URL only — so a
// new track goes to the storage channel first (lib/download.js storedFile).
// The ✏️ 🎤 🖼 buttons are not there: an inline message is in someone else's chat.
// BotFather → /setinline must be on for any of this.

import { api, BotApiError } from 'sdk';
import { esc, clock } from './html.js';
import { captionFor } from './audio.js';
import { ERRORS, storedFile, forgetFile, keptFiles, logDownload } from './download.js';
import { searchTracks, getTrackById, artworkAt, SoundcloudError } from './soundcloud.js';

// Tracks asked of SoundCloud per page of results (Telegram takes up to 50).
const PAGE = 15;
const MIN_QUERY = 2;
// Search results change slowly; a cached answer saves a SoundCloud request a keystroke.
const CACHE_SECONDS = 300;
// The button above the list when there are no results: it opens the bot.
const HINT = '🔎 اسم آهنگ یا خواننده رو بنویس';

const NO_STORAGE = '⚠️ الان نمی‌تونم اینجا بفرستمش. لینکش رو توی خود ربات بفرست.';
const FAILED = '⚠️ نشد این آهنگ رو بیارم. کمی بعد دوباره امتحان کن.';

const heading = (t) => `🎵 <b>${esc(t.title)}</b>${t.artist ? `\n🎤 ${esc(t.artist)}` : ''}`;

async function answer(query, results, extra = {}) {
  try {
    await api.answerInlineQuery({ inline_query_id: query.id, results, cache_time: CACHE_SECONDS, ...extra });
  } catch (e) {
    // The user typed on and Telegram moved to the newer query: nobody waits for this one.
    if (!(e.code === 400 && /query is too old|query id is invalid/i.test(e.description ?? ''))) throw e;
  }
}

export async function answerInline(query) {
  const q = (query.query ?? '').trim().replace(/\s+/g, ' ').slice(0, 100);
  const offset = Math.max(0, Number(query.offset) || 0);
  if (q.length < MIN_QUERY) {
    return answer(query, [], { cache_time: 5, button: { text: HINT, start_parameter: 'help' } });
  }
  let found;
  try {
    found = await searchTracks(q, { offset, limit: PAGE });
  } catch (e) {
    if (!(e instanceof SoundcloudError)) throw e;
    return answer(query, [], { cache_time: 5, button: { text: '📡 الان به ساندکلاد دسترسی ندارم', start_parameter: 'help' } });
  }
  const kept = await keptFiles(found.tracks.map((t) => t.id));
  const results = await Promise.all(found.tracks.map(async (t) => (kept[t.id]
    ? {
      type: 'audio',
      id: `c:${t.id}`,
      audio_file_id: kept[t.id],
      caption: await captionFor(t.permalink),
      parse_mode: 'HTML',
    }
    : {
      type: 'article',
      id: `t:${t.id}`,
      title: t.title,
      description: [t.artist, clock(t.duration)].filter(Boolean).join(' · '),
      ...(t.artworkUrl ? { thumbnail_url: artworkAt(t.artworkUrl, 't300x300') } : {}),
      input_message_content: { message_text: heading(t), parse_mode: 'HTML' },
      // A button is what gives the message an inline_message_id to edit later.
      reply_markup: { inline_keyboard: [[{ text: '⏳ در حال آماده‌سازی…', callback_data: `il:${t.id}` }]] },
    })));
  await answer(query, results, {
    next_offset: found.next != null ? String(found.next) : '',
    ...(!results.length && offset === 0 ? { cache_time: 30, button: { text: '🔍 چیزی پیدا نشد؛ اسم دیگه‌ای امتحان کن', start_parameter: 'help' } } : {}),
  });
}

const fill = (inlineMessageId, track, fileId) => captionFor(track.permalink).then((caption) => api.editMessageMedia({
  inline_message_id: inlineMessageId,
  media: { type: 'audio', media: fileId, caption, parse_mode: 'HTML' },
}));

const notModified = (e) => e instanceof BotApiError && /not modified/i.test(e.description ?? '');

// The "⏳" inline message becomes the audio. Never throws: on failure the
// message says why.
async function complete(inlineMessageId, trackId, userId) {
  const started = Date.now();
  let track = null;
  try {
    track = await getTrackById(trackId);
    let file = await storedFile(track);
    try {
      await fill(inlineMessageId, track, file.fileId);
    } catch (e) {
      // A kept file_id Telegram no longer knows: upload the track again, once.
      if (!(file.cached && e instanceof BotApiError && e.code === 400 && !notModified(e))) throw e;
      await forgetFile(track.id);
      file = await storedFile(track);
      await fill(inlineMessageId, track, file.fileId);
    }
    await logDownload({ userId, url: track.permalink ?? `soundcloud:tracks:${trackId}`, trackId, status: file.cached ? 'cached' : 'sent', via: 'inline', ms: Date.now() - started });
  } catch (e) {
    if (notModified(e)) return;   // filled already: its button was pressed while it was being sent
    const code = e instanceof SoundcloudError || e.code === 'NO_STORAGE' ? e.code : 'INTERNAL';
    if (code === 'INTERNAL') console.error(e);
    await logDownload({ userId, url: track?.permalink ?? `soundcloud:tracks:${trackId}`, trackId, status: 'failed', error: code, via: 'inline', ms: Date.now() - started });
    const why = code === 'NO_STORAGE' ? NO_STORAGE : ERRORS[code] ?? FAILED;
    await api.editMessageText({
      inline_message_id: inlineMessageId,
      text: track ? `${heading(track)}\n\n${esc(why)}` : esc(why),
      parse_mode: 'HTML',
    }).catch(console.error);
  }
}

// An inline result was sent (handlers/chosen_inline_result.js). A cached
// audio is complete as sent; a "⏳" one is filled now.
export async function completeChosen(chosen) {
  const m = /^t:(\d+)$/.exec(chosen.result_id ?? '');
  if (!m || !chosen.inline_message_id) return;
  await complete(chosen.inline_message_id, Number(m[1]), chosen.from.id);
}

// "⏳" pressed (il:<id>): the same, for a bot without inline feedback, or a
// message that waited too long. true when the button was this one.
export async function handleInlineCallback(query) {
  const m = /^il:(\d+)$/.exec(query.data ?? '');
  if (!m) return false;
  await api.answerCallbackQuery({ callback_query_id: query.id, text: '⏳' }).catch(console.error);
  if (query.inline_message_id) await complete(query.inline_message_id, Number(m[1]), query.from.id);
  return true;
}
