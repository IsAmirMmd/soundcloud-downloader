// The storage channel (lib/storage.js): every track goes there once, users
// get it by that post's file_id, and a channel that fails costs nobody their
// track.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  fresh, take, mockApi, failNext, row, rows, exec, msg, ctxOf, soundcloud, scTrack, ADMIN_ID, STORAGE_CHAT_ID,
} from './helpers.mjs';
import message from '../tgcloud/handlers/message.js';
import adminProbe from '../tgcloud/endpoints/adminProbe.js';

const USER = ADMIN_ID + 1;
const OTHER = ADMIN_ID + 2;
const LINK = 'https://soundcloud.com/artist/track-1';
const LINK2 = 'https://soundcloud.com/artist/track-2';

let uploads;
beforeEach(() => {
  fresh();
  soundcloud({ tracks: { [LINK]: scTrack(1), [LINK2]: scTrack(2) } });
  uploads = 0;
  let nextMessage = 900;
  mockApi('sendAudio', (p) => ({
    message_id: nextMessage++,
    chat: { id: p.chat_id },
    audio: { file_id: typeof p.audio === 'string' ? p.audio : `F${++uploads}` },
  }));
});

const audios = (calls) => calls.filter((c) => c.method === 'sendAudio');
const refuseChannel = () => failNext('sendAudio', 403, 'Forbidden: bot is not a member of the channel chat', (p) => p.chat_id === STORAGE_CHAT_ID);

test('a track cached before the channel goes there by its file_id on its next request, once', async () => {
  exec(`INSERT INTO tracks (track_id, permalink_url, title, artist, duration, file_id, format, tags_version, sends)
        VALUES (1, 'https://soundcloud.com/artist/track-1', 'Track 1', 'artist', 180, 'OLD', 'hls audio/mp4 (aac_160k)', 2, 1)`);
  await message(msg(USER, LINK), {});
  const [toUser, toChannel] = audios(take());
  assert.deepEqual([toUser.params.chat_id, toUser.params.audio], [USER, 'OLD']);      // the user first
  assert.deepEqual([toChannel.params.chat_id, toChannel.params.audio], [STORAGE_CHAT_ID, 'OLD']);
  assert.equal(uploads, 0, 'nothing uploaded again');
  assert.equal(row('SELECT storage_message_id FROM tracks WHERE track_id = 1').storage_message_id, 901);

  await message(msg(OTHER, LINK), {});
  assert.deepEqual(audios(take()).map((c) => c.params.chat_id), [OTHER]);
});

test('when the channel refuses, the user still gets the track, and the admin hears of it once an hour', async () => {
  refuseChannel();
  await message(msg(USER, LINK), {});
  let calls = take();
  const sent = audios(calls);
  assert.deepEqual(sent.map((c) => c.params.chat_id), [STORAGE_CHAT_ID, USER]);
  assert.equal(typeof sent[1].params.audio, 'object', 'uploaded straight to the user');
  const warning = calls.find((c) => c.method === 'sendMessage' && c.params.chat_id === ADMIN_ID);
  assert.match(warning.params.text, /Storage channel -1004440110907: Forbidden: bot is not a member/);
  const t = row('SELECT file_id, storage_message_id FROM tracks WHERE track_id = 1');
  assert.deepEqual([t.file_id, t.storage_message_id], ['F1', null]);
  assert.equal(row('SELECT status FROM downloads').status, 'sent');

  refuseChannel();
  await message(msg(USER, LINK2), {});
  calls = take();
  assert.ok(audios(calls).some((c) => c.params.chat_id === USER));
  assert.ok(!calls.some((c) => c.method === 'sendMessage' && c.params.chat_id === ADMIN_ID), 'not warned twice in an hour');

  // Working again: the track kept meanwhile goes into the channel on its next request.
  await message(msg(OTHER, LINK), {});
  assert.deepEqual(audios(take()).map((c) => [c.params.chat_id, c.params.audio]), [[OTHER, 'F1'], [STORAGE_CHAT_ID, 'F1']]);
  assert.notEqual(row('SELECT storage_message_id FROM tracks WHERE track_id = 1').storage_message_id, null);
});

test('the probe says when the bot cannot post in the channel', async () => {
  mockApi('getChat', () => ({ id: STORAGE_CHAT_ID, type: 'channel', title: 'Archive' }));
  mockApi('getChatMember', () => ({ status: 'administrator', can_post_messages: false }));
  const report = await adminProbe({ download: false }, ctxOf(ADMIN_ID));
  const step = report.steps.find((s) => s.name === 'storage channel');
  assert.equal(step.ok, false);
  assert.match(step.error, /Archive: administrator, can't post/);
  assert.equal(report.ok, false);
});

test('/stats counts the tracks in the channel', async () => {
  await message(msg(USER, LINK), {});
  refuseChannel();
  await message(msg(USER, LINK2), {});
  take();
  await message(msg(ADMIN_ID, '/stats'), {});
  const stats = take().find((c) => c.method === 'sendMessage' && /Users:/.test(c.params.text));
  assert.match(stats.params.text, /Tracks on Telegram: ۲ · in the storage channel: ۱/);
  assert.equal(rows('SELECT * FROM tracks').length, 2);
});
