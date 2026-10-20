// The bot's job end to end: a SoundCloud link in a private chat → an audio
// message (lib/download.js), through handlers/message.js, on a fake SoundCloud.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  fresh, take, failNext, mockApi, row, rows, msg, groupMsg, ctxOf, soundcloud, scTrack, asText, ADMIN_ID,
} from './helpers.mjs';
import message from '../tgcloud/handlers/message.js';
import adminProbe from '../tgcloud/endpoints/adminProbe.js';
import { fileName } from '../tgcloud/lib/audio.js';

const USER = ADMIN_ID + 1;
const OTHER = ADMIN_ID + 2;
const LINK = 'https://soundcloud.com/artist/track-1';

beforeEach(fresh);

// sendAudio answers like Telegram: the message with its audio's file_id, a
// new one for each upload. → the file_ids handed out, in order.
function telegramKeepsAudio() {
  const issued = [];
  mockApi('sendAudio', (p) => {
    if (typeof p.audio !== 'string') issued.push(`F${issued.length + 1}`);
    return { message_id: 500, chat: { id: p.chat_id }, audio: { file_id: typeof p.audio === 'string' ? p.audio : issued.at(-1) } };
  });
  return issued;
}

test('a link comes back as audio: status, upload with name, cover and caption; file_id kept', async () => {
  soundcloud({ tracks: { [LINK]: scTrack(1) } });
  const issued = telegramKeepsAudio();
  mockApi('sendMessage', (p) => ({ message_id: 77, chat: { id: p.chat_id } }));
  const m = msg(USER, `listen ${LINK}?si=x`);
  await message(m, {});

  const [status, action, audio, done] = take();
  assert.equal(status.method, 'sendMessage');
  assert.match(status.params.text, /⏳/);
  assert.equal(action.method, 'sendChatAction');
  assert.equal(audio.method, 'sendAudio');
  assert.equal(audio.params.chat_id, USER);
  // A track of today: AAC only, joined into one .m4a.
  assert.equal(audio.params.audio.name, 'artist - Track 1.m4a');
  assert.equal(audio.params.audio.type, 'audio/mp4');
  assert.equal(asText(audio.params.audio.data), '<t1/aac_160k/init.mp4><0/10/t1.m4s><10/20/t1.m4s><t1/aac_160k/seg3.m4s>');
  assert.equal(asText(audio.params.thumbnail.data), '<artworks-1-t300x300.jpg>');
  assert.deepEqual([audio.params.title, audio.params.performer, audio.params.duration], ['Track 1', 'artist', 180]);
  assert.match(audio.params.caption, /href="https:\/\/soundcloud\.com\/artist\/track-1".*@test_bot/);
  assert.equal(audio.params.reply_parameters.message_id, m.message_id);
  assert.equal(done.method, 'deleteMessage');
  assert.equal(done.params.message_id, 77);

  const t = row('SELECT * FROM tracks WHERE track_id = 1');
  assert.equal(t.file_id, issued[0]);
  assert.equal(t.sends, 1);
  assert.equal(t.format, 'hls audio/mp4 (aac_160k)');
  assert.deepEqual(rows('SELECT user_id, url, track_id, status, error FROM downloads'),
    [{ user_id: USER, url: LINK, track_id: 1, status: 'sent', error: null }]);
});

test('the same track again is sent by its file_id, without downloading', async () => {
  const asked = soundcloud({ tracks: { [LINK]: scTrack(1) } });
  telegramKeepsAudio();
  await message(msg(USER, LINK), {});
  const fileId = row('SELECT file_id FROM tracks WHERE track_id = 1').file_id;
  take();
  asked.length = 0;

  await message(msg(OTHER, LINK), {});
  const audio = take().find((c) => c.method === 'sendAudio');
  assert.equal(audio.params.audio, fileId);
  assert.ok(!asked.some((u) => u.includes('/stream/') || u.includes('playlist.m3u8')), 'no stream fetched');
  assert.equal(row('SELECT sends FROM tracks WHERE track_id = 1').sends, 2);
  assert.equal(row('SELECT status FROM downloads WHERE user_id = ?', OTHER).status, 'cached');
});

test('a file_id Telegram no longer knows is forgotten and the track uploaded again', async () => {
  soundcloud({ tracks: { [LINK]: scTrack(1) } });
  telegramKeepsAudio();
  await message(msg(USER, LINK), {});
  const old = row('SELECT file_id FROM tracks WHERE track_id = 1').file_id;
  take();

  failNext('sendAudio', 400, 'Bad Request: wrong file identifier/HTTP URL specified');
  await message(msg(OTHER, LINK), {});
  const [byId, upload] = take().filter((c) => c.method === 'sendAudio');
  assert.equal(byId.params.audio, old);
  assert.equal(typeof upload.params.audio, 'object');
  assert.notEqual(row('SELECT file_id FROM tracks WHERE track_id = 1').file_id, old);
  assert.equal(row('SELECT status FROM downloads WHERE user_id = ?', OTHER).status, 'sent');
});

test('a link that gives no audio edits the status message into the reason', async () => {
  soundcloud({ tracks: {
    'https://soundcloud.com/a/goplus': scTrack(2, { policy: 'SNIP', snipped: true }),
    'https://soundcloud.com/a/sets/album': { kind: 'playlist', id: 9 },
  } });
  const reasons = {
    'https://soundcloud.com/a/goplus': [/Go\+/, 'PREVIEW_ONLY'],
    'https://soundcloud.com/a/sets/album': [/پلی‌لیست/, 'NOT_TRACK'],
    'https://soundcloud.com/a/missing': [/پیدا نشد/, 'NOT_FOUND'],
  };
  for (const [link, [text, code]] of Object.entries(reasons)) {
    await message(msg(USER, link), {});
    const calls = take();
    assert.ok(!calls.some((c) => c.method === 'sendAudio'), link);
    const edit = calls.find((c) => c.method === 'editMessageText');
    assert.match(edit.params.text, text, link);
    assert.equal(row('SELECT error FROM downloads WHERE url = ?', link).error, code);
  }
});

test('SoundCloud down: the user is told to try later, the failure is logged', async () => {
  soundcloud({ down: ['api-v2.soundcloud.com'] });
  await message(msg(USER, LINK), {});
  const edit = take().find((c) => c.method === 'editMessageText');
  assert.match(edit.params.text, /دسترسی ندارم/);
  assert.equal(row('SELECT status, error FROM downloads').error, 'UNREACHABLE');
});

test('other text in private gets a hint; groups and unknown commands get nothing', async () => {
  await message(msg(USER, 'hello'), {});
  assert.match(take()[0].params.text, /لینک یه ترک ساندکلاد/);

  await message(groupMsg(USER, LINK), {});
  await message(msg(USER, '/unknown'), {});
  assert.deepEqual(take(), []);
  assert.deepEqual(rows('SELECT * FROM downloads'), []);
});

test('/stats counts links, downloads, cache hits and failures by reason', async () => {
  soundcloud({ tracks: { [LINK]: scTrack(1) } });
  telegramKeepsAudio();
  await message(msg(USER, LINK), {});
  await message(msg(OTHER, LINK), {});
  await message(msg(OTHER, 'https://soundcloud.com/a/missing'), {});
  take();

  await message(msg(ADMIN_ID, '/stats'), {});
  const [stats] = take();
  assert.match(stats.params.text, /Links: ۳ from ۲ users/);
  assert.match(stats.params.text, /Downloaded: ۱ · ♻️ from cache: ۱ · ❌ failed: ۱/);
  assert.match(stats.params.text, /NOT_FOUND: ۱/);
  assert.match(stats.params.text, /Edited copies: ۰ by ۰ users/);
});

test('the probe: every step from the cloud, for the admin only', async () => {
  soundcloud({ tracks: { 'https://soundcloud.com/forss/flickermood': scTrack(7) } });
  const report = await adminProbe({}, ctxOf(ADMIN_ID));
  assert.equal(report.ok, true);
  assert.deepEqual(report.steps.map((s) => s.name), ['client_id (scraped)', 'resolve', 'stream', 'download']);
  assert.equal(report.steps.find((s) => s.name === 'stream').value, 'aac_160k hls audio/mp4');
  assert.match(report.steps.at(-1).value, /^\d+ bytes \(hls audio\/mp4 \(aac_160k\)\)$/);
  await assert.rejects(adminProbe({}, ctxOf(USER)), (e) => e.parameters?.code === 'FORBIDDEN');

  await message(msg(ADMIN_ID, '/sc https://soundcloud.com/a/missing'), {});
  const [sent] = take();
  assert.equal(sent.params.chat_id, ADMIN_ID);
  assert.match(sent.params.text, /❌ SoundCloud probe[\s\S]*❌ resolve/);
});

test('fileName: artist and title, without characters file systems refuse', () => {
  assert.equal(fileName({ id: 1, artist: 'A/C', title: 'Mix: "Live" <1>' }, 'mp3'), 'A C - Mix Live 1.mp3');
  assert.equal(fileName({ id: 5, artist: '', title: '' }, 'm4a'), 'soundcloud-5.m4a');
});
