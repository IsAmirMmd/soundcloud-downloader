// Inline mode (lib/inline.js): `@bot <song>` → results; a track already on
// Telegram is the audio itself, any other a "⏳" message that becomes the
// audio once sent (chosen_inline_result) or its button pressed.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fresh, take, mockApi, failNext, row, rows, exec, soundcloud, scTrack, ADMIN_ID, STORAGE_CHAT_ID } from './helpers.mjs';
import inlineQuery from '../tgcloud/handlers/inline_query.js';
import chosenInlineResult from '../tgcloud/handlers/chosen_inline_result.js';
import callbackQuery from '../tgcloud/handlers/callback_query.js';

const USER = ADMIN_ID + 1;
const user = { id: USER, is_bot: false, first_name: 'U' };
const ask = (text, offset = '') => ({ id: `iq${Math.random()}`, from: user, query: text, offset, chat_type: 'sender' });
const chosen = (resultId, inlineMessageId = 'IM1') => ({ result_id: resultId, from: user, query: 'shab', inline_message_id: inlineMessageId });
const pressInline = (data, inlineMessageId = 'IM1') => ({ id: `q${Math.random()}`, from: user, data, inline_message_id: inlineMessageId, chat_instance: '1' });

const TRACKS = Object.fromEntries(Array.from({ length: 20 }, (_, i) => i + 1)
  .map((id) => [`https://soundcloud.com/a/t${id}`, scTrack(id, { title: `Song ${id}` })]));

beforeEach(() => {
  fresh();
  soundcloud({ tracks: TRACKS });
  let n = 0;
  mockApi('sendAudio', (p) => ({ message_id: 800 + n, chat: { id: p.chat_id }, audio: { file_id: typeof p.audio === 'string' ? p.audio : `F${++n}` } }));
});

const answerOf = (calls) => calls.find((c) => c.method === 'answerInlineQuery').params;
const keep = (trackId, fileId) => exec(`INSERT INTO tracks (track_id, permalink_url, title, artist, duration, file_id, format, tags_version, storage_message_id, sends)
  VALUES (${trackId}, 'https://soundcloud.com/artist/track-${trackId}', 'Song ${trackId}', 'artist', 180, '${fileId}', 'hls audio/mp4 (aac_160k)', 2, 1, 1)`);

test('results: a track on Telegram is the audio itself, the others a ⏳ message; more as you scroll', async () => {
  keep(2, 'KEPT2');
  await inlineQuery(ask('shab'), {});
  const answer = answerOf(take());
  assert.equal(answer.results.length, 15);
  const [first, second] = answer.results;
  assert.equal(first.type, 'article');
  assert.equal(first.id, 't:1');
  assert.equal(first.title, 'Song 1');
  assert.equal(first.description, 'artist · ۳:۰۰');
  assert.equal(first.thumbnail_url, 'https://i1.sndcdn.com/artworks-1-t300x300.jpg');
  assert.match(first.input_message_content.message_text, /🎵 <b>Song 1<\/b>\n🎤 artist/);
  assert.deepEqual(first.reply_markup.inline_keyboard.flat().map((b) => b.callback_data), ['il:1']);
  assert.deepEqual([second.type, second.id, second.audio_file_id], ['audio', 'c:2', 'KEPT2']);
  assert.match(second.caption, /soundcloud\.com\/artist\/track-2/);
  assert.equal(answer.next_offset, '15');

  await inlineQuery(ask('shab', '15'), {});
  const more = answerOf(take());
  assert.deepEqual(more.results.map((r) => r.id), ['t:16', 't:17', 't:18', 't:19', 't:20']);
  assert.equal(more.next_offset, '');
});

test('a ⏳ result, once sent, is downloaded, put in the channel and becomes the audio', async () => {
  await chosenInlineResult(chosen('t:7'), {});
  const calls = take();
  const store = calls.find((c) => c.method === 'sendAudio');
  assert.equal(store.params.chat_id, STORAGE_CHAT_ID);
  const edit = calls.find((c) => c.method === 'editMessageMedia');
  assert.equal(edit.params.inline_message_id, 'IM1');
  assert.deepEqual([edit.params.media.type, edit.params.media.media], ['audio', 'F1']);
  assert.match(edit.params.media.caption, /soundcloud\.com\/artist\/track-7/);
  assert.equal(edit.params.reply_markup, undefined, 'no ⏳ button left');
  assert.equal(row('SELECT file_id FROM tracks WHERE track_id = 7').file_id, 'F1');
  const d = row('SELECT status, via, track_id FROM downloads');
  assert.deepEqual([d.status, d.via, d.track_id], ['sent', 'inline', 7]);

  // A cached audio result needs nothing more.
  await chosenInlineResult(chosen('c:7'), {});
  assert.deepEqual(take(), []);
});

test('without inline feedback, pressing ⏳ does the same; a kept track needs no upload', async () => {
  keep(3, 'KEPT3');
  await callbackQuery(pressInline('il:3', 'IM9'), {});
  const calls = take();
  assert.equal(calls[0].method, 'answerCallbackQuery');
  assert.ok(!calls.some((c) => c.method === 'sendAudio'));
  const edit = calls.find((c) => c.method === 'editMessageMedia');
  assert.deepEqual([edit.params.inline_message_id, edit.params.media.media], ['IM9', 'KEPT3']);
  assert.equal(row('SELECT status FROM downloads').status, 'cached');
});

test('a kept file_id Telegram no longer knows is uploaded again, once', async () => {
  keep(4, 'STALE');
  failNext('editMessageMedia', 400, 'Bad Request: wrong file identifier/HTTP URL specified');
  await chosenInlineResult(chosen('t:4'), {});
  const edits = take().filter((c) => c.method === 'editMessageMedia');
  assert.deepEqual(edits.map((e) => e.params.media.media), ['STALE', 'F1']);
  assert.equal(row('SELECT file_id FROM tracks WHERE track_id = 4').file_id, 'F1');
});

test('when the channel refuses, the ⏳ message says to send the link to the bot', async () => {
  failNext('sendAudio', 403, 'Forbidden: bot is not a member of the channel chat', (p) => p.chat_id === STORAGE_CHAT_ID);
  await chosenInlineResult(chosen('t:5'), {});
  const calls = take();
  assert.ok(!calls.some((c) => c.method === 'editMessageMedia'));
  const edit = calls.find((c) => c.method === 'editMessageText');
  assert.match(edit.params.text, /Song 5[\s\S]*لینکش رو توی خود ربات بفرست/);
  assert.equal(row('SELECT error FROM downloads').error, 'NO_STORAGE');
  assert.equal(rows('SELECT * FROM tracks').length, 0);
});

test('a short query or no results: no list, a button to the bot', async () => {
  await inlineQuery(ask('a'), {});
  let answer = answerOf(take());
  assert.deepEqual(answer.results, []);
  assert.equal(answer.button.start_parameter, 'help');

  soundcloud({ tracks: {} });
  await inlineQuery(ask('nothing like it'), {});
  answer = answerOf(take());
  assert.deepEqual(answer.results, []);
  assert.match(answer.button.text, /پیدا نشد/);
});

test('an answer Telegram no longer waits for is not an error', async () => {
  failNext('answerInlineQuery', 400, 'Bad Request: query is too old and response timeout expired or query ID is invalid');
  await inlineQuery(ask('shab'), {});
  assert.equal(take().filter((c) => c.method === 'answerInlineQuery').length, 1);
});
