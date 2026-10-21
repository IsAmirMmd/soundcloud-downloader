// ✏️ 🎤 🖼 under every audio (lib/metadata.js): the button asks, the next
// message answers, a new copy comes back with the new title, artist or cover.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  fresh, take, mockApi, failNext, row, rows, msg, press, soundcloud, scTrack, asText, fakeBytes, ADMIN_ID,
} from './helpers.mjs';
import message from '../tgcloud/handlers/message.js';
import callbackQuery from '../tgcloud/handlers/callback_query.js';
import { META_BUTTONS } from '../tgcloud/lib/audio.js';

const USER = ADMIN_ID + 1;
const LINK = 'https://soundcloud.com/artist/track-1';
const MP3_LINK = 'https://soundcloud.com/artist/track-2';

// A photo as Telegram sends it: the same picture in several sizes, smallest first.
const PHOTO = [[90, 'P90'], [320, 'P320'], [800, 'P800'], [1280, 'P1280'], [2560, 'P2560']]
  .map(([side, id]) => ({ file_id: id, file_unique_id: `u${id}`, width: side, height: side }));

let telegram;
beforeEach(() => {
  fresh();
  soundcloud({ tracks: { [LINK]: scTrack(1), [MP3_LINK]: scTrack(2, { streams: ['progressive'] }) } });
  telegram = fakeTelegram();
});

// Telegram's side: sendAudio keeps each upload under a new file_id and
// getFileContent gives its bytes back (photos too).
function fakeTelegram() {
  const files = Object.fromEntries(PHOTO.map((p) => [p.file_id, fakeBytes(p.file_id)]));
  let nextMessage = 500;
  let nextFile = 1;
  mockApi('sendAudio', (p) => {
    let fileId = p.audio;
    if (typeof p.audio !== 'string') {
      fileId = `F${nextFile++}`;
      files[fileId] = p.audio.data;
    }
    return { message_id: nextMessage++, chat: { id: p.chat_id }, audio: { file_id: fileId, mime_type: p.audio.type ?? 'audio/mp4' } };
  });
  mockApi('sendMessage', (p) => ({ message_id: nextMessage++, chat: { id: p.chat_id } }));
  mockApi('getFileContent', (fileId) => {
    if (!files[fileId]) throw new Error(`no file ${fileId}`);
    return files[fileId];
  });
  return { files };
}

// A track downloaded into USER's chat → its audio message id.
async function download(link = LINK) {
  await message(msg(USER, link), {});
  const audio = take().find((c) => c.method === 'sendAudio');
  return row('SELECT message_id FROM sent_audios ORDER BY id DESC LIMIT 1').message_id ?? audio;
}

// Presses `data` under the audio, then answers the question with `answer`
// (a message's fields). → the Bot API calls of the answer.
async function edit(audioId, data, answer) {
  await callbackQuery(press(USER, data, audioId), {});
  take();
  await message(msg(USER, answer.text, answer), {});
  return take();
}

test('every audio comes with ✏️ 🎤 🖼 buttons and is remembered', async () => {
  await message(msg(USER, LINK), {});
  const audio = take().find((c) => c.method === 'sendAudio');
  assert.deepEqual(audio.params.reply_markup, META_BUTTONS);
  assert.deepEqual(audio.params.reply_markup.inline_keyboard.flat().map((b) => b.text), ['✏️ اسم آهنگ', '🎤 خواننده', '🖼 کاور']);
  const r = row('SELECT * FROM sent_audios');
  assert.deepEqual(
    [r.chat_id, r.track_id, r.file_id, r.ext, r.title, r.artist, r.duration, r.edited],
    [USER, 1, 'F1', 'mp4', 'Track 1', 'artist', 180, 0]);
  assert.equal(r.artwork_url, 'https://i1.sndcdn.com/artworks-1-large.jpg');
  assert.equal(r.permalink_url, 'https://soundcloud.com/artist/track-1');

  // From the cache too.
  await message(msg(USER, LINK), {});
  assert.deepEqual(take().find((c) => c.method === 'sendAudio').params.reply_markup, META_BUTTONS);
  assert.equal(rows('SELECT * FROM sent_audios').length, 2);
});

test('✏️ asks for the new title, showing the current one, with a ❌ button', async () => {
  const audioId = await download();
  await callbackQuery(press(USER, 'meta:title', audioId), {});
  const [answer, question] = take();
  assert.equal(answer.method, 'answerCallbackQuery');
  assert.match(question.params.text, /اسم جدید آهنگ/);
  assert.match(question.params.text, /الان: <b>Track 1<\/b>/);
  assert.equal(question.params.reply_parameters.message_id, audioId);
  assert.deepEqual(question.params.reply_markup.inline_keyboard.flat().map((b) => [b.text, b.callback_data]), [['❌ انصراف', 'meta:cancel']]);
  assert.match(row('SELECT pending_action FROM users WHERE user_id = ?', USER).pending_action, /^meta:title:\d+:\d+$/);
});

test('the new title comes back as a new copy: same sound, new name and file name, the buttons again', async () => {
  const audioId = await download();
  const calls = await edit(audioId, 'meta:title', { text: 'شب‌های تهران' });
  const methods = calls.map((c) => c.method);
  assert.deepEqual(methods.slice(0, 3), ['deleteMessage', 'sendMessage', 'sendChatAction']);   // the question goes, ⏳ comes
  assert.ok(calls.some((c) => c.method === 'getFileContent' && c.params === 'F1'));
  const upload = calls.find((c) => c.method === 'sendAudio');
  assert.equal(upload.params.title, 'شب‌های تهران');
  assert.equal(upload.params.performer, 'artist');
  assert.equal(upload.params.audio.name, 'artist - شب‌های تهران.mp4');
  assert.equal(upload.params.audio.type, 'audio/mp4');
  assert.deepEqual([...upload.params.audio.data], [...telegram.files.F1]);   // fake bytes: no MP4 to tag
  assert.equal(asText(upload.params.thumbnail.data), '<artworks-1-t300x300.jpg>');
  assert.deepEqual(upload.params.reply_markup, META_BUTTONS);
  assert.equal(methods.at(-1), 'deleteMessage');                               // ⏳ goes too

  const copy = row('SELECT * FROM sent_audios WHERE edited = 1');
  assert.deepEqual([copy.title, copy.artist, copy.file_id, copy.track_id], ['شب‌های تهران', 'artist', 'F2', 1]);
  assert.equal(row('SELECT pending_action FROM users WHERE user_id = ?', USER).pending_action, null);
});

test('🎤 then ✏️ on the copy: the edits add up, and the MP3 gets them written inside', async () => {
  const audioId = await download(MP3_LINK);
  await edit(audioId, 'meta:artist', { text: 'خواننده' });
  const copyId = row('SELECT message_id FROM sent_audios WHERE edited = 1').message_id;
  const calls = await edit(copyId, 'meta:title', { text: 'New Title' });
  const upload = calls.find((c) => c.method === 'sendAudio');
  assert.deepEqual([upload.params.title, upload.params.performer, upload.params.audio.name],
    ['New Title', 'خواننده', 'خواننده - New Title.mp3']);
  const file = Buffer.from(upload.params.audio.data);
  assert.equal(file.toString('latin1', 0, 3), 'ID3');
  assert.ok(file.includes(Buffer.from('New Title', 'utf16le')));
  assert.ok(file.includes(Buffer.from('خواننده', 'utf16le')));
  assert.ok(file.includes(Buffer.from('<artworks-2-t500x500.jpg>')), 'the 500 px artwork inside');
  assert.ok(file.subarray(-'<t2.mp3>'.length).equals(Buffer.from('<t2.mp3>')), 'then the same audio');
});

test('🖼 a photo becomes the thumbnail (320 px) and the cover in the file (1280 px)', async () => {
  const audioId = await download(MP3_LINK);
  const calls = await edit(audioId, 'meta:cover', { photo: PHOTO });
  const upload = calls.find((c) => c.method === 'sendAudio');
  assert.equal(asText(upload.params.thumbnail.data), '<P320>');
  assert.ok(Buffer.from(upload.params.audio.data).includes(Buffer.from('<P1280>')));
  assert.equal(upload.params.title, 'Track 2');
  const copy = row('SELECT * FROM sent_audios WHERE edited = 1');
  assert.deepEqual([copy.cover_file_id, copy.cover_thumb_id], ['P1280', 'P320']);

  // The next edit keeps that cover.
  const next = await edit(copy.message_id, 'meta:title', { text: 'X' });
  assert.equal(asText(next.find((c) => c.method === 'sendAudio').params.thumbnail.data), '<P320>');
});

test('a wrong answer asks again: text for 🖼, a photo or a command for ✏️', async () => {
  const audioId = await download();
  let calls = await edit(audioId, 'meta:cover', { text: 'here it is' });
  assert.ok(!calls.some((c) => c.method === 'sendAudio'));
  assert.match(calls.find((c) => c.method === 'sendMessage').params.text, /یه عکس بفرست/);
  assert.match(row('SELECT pending_action FROM users WHERE user_id = ?', USER).pending_action, /^meta:cover:/);
  await message(msg(USER, undefined, { photo: PHOTO }), {});
  assert.ok(take().some((c) => c.method === 'sendAudio'));

  calls = await edit(audioId, 'meta:title', { text: '/oops' });
  assert.match(calls.find((c) => c.method === 'sendMessage').params.text, /به‌صورت متن/);
  assert.match(row('SELECT pending_action FROM users WHERE user_id = ?', USER).pending_action, /^meta:title:/);
});

test('❌ cancels: the question says so, and the next message is no answer', async () => {
  const audioId = await download();
  await callbackQuery(press(USER, 'meta:title', audioId), {});
  const questionId = 500 + 2;   // after the ⏳ status and the audio
  take();
  await callbackQuery(press(USER, 'meta:cancel', questionId), {});
  const [answer, edited] = take();
  assert.equal(answer.params.text, 'لغو شد');
  assert.equal(edited.params.text, '❌ ویرایش لغو شد.');
  assert.equal(row('SELECT pending_action FROM users WHERE user_id = ?', USER).pending_action, null);

  await message(msg(USER, 'hello'), {});
  assert.match(take()[0].params.text, /لینک یه ترک ساندکلاد/);
  assert.equal(rows('SELECT * FROM sent_audios WHERE edited = 1').length, 0);
});

test('a SoundCloud link instead of an answer is downloaded, not used as a title', async () => {
  const audioId = await download();
  const calls = await edit(audioId, 'meta:title', { text: MP3_LINK });
  assert.equal(calls.find((c) => c.method === 'sendAudio').params.title, 'Track 2');
  assert.equal(rows('SELECT * FROM sent_audios WHERE edited = 1').length, 0);
});

test('an audio the bot has no row for, or a press from another chat, gets an alert', async () => {
  await callbackQuery(press(USER, 'meta:title', 99999), {});
  const [alert] = take();
  assert.equal(alert.params.show_alert, true);
  assert.match(alert.params.text, /قدیمیه/);

  const audioId = await download();
  const someoneElse = { ...press(USER + 7, 'meta:title', audioId) };
  someoneElse.message = { ...someoneElse.message, chat: { id: USER, type: 'private' } };
  await callbackQuery(someoneElse, {});
  assert.equal(take()[0].params.show_alert, true);
  assert.equal(row('SELECT pending_action FROM users WHERE user_id = ?', USER + 7), null);
});

test('over 20 MB Telegram gives no file back: the track is downloaded again from SoundCloud', async () => {
  const audioId = await download();
  failNext('getFileContent', 400, 'Bad Request: file is too big');
  const calls = await edit(audioId, 'meta:artist', { text: 'Someone' });
  const upload = calls.find((c) => c.method === 'sendAudio');
  assert.equal(asText(upload.params.audio.data), '<t1/aac_160k/init.mp4><0/10/t1.m4s><10/20/t1.m4s><t1/aac_160k/seg3.m4s>');
  assert.equal(upload.params.performer, 'Someone');
});

test('when the new copy cannot be made, ⏳ turns into the reason', async () => {
  const audioId = await download();
  failNext('sendAudio', 400, 'Bad Request: something went wrong');
  const calls = await edit(audioId, 'meta:title', { text: 'Nope' });
  assert.match(calls.at(-1).params.text, /نتونستم فایل جدید رو بسازم/);
  assert.equal(calls.at(-1).method, 'editMessageText');
  assert.equal(rows('SELECT * FROM sent_audios WHERE edited = 1').length, 0);
});
