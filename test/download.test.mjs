// The bot's job end to end: a SoundCloud link in a private chat → an audio
// message (lib/download.js), through handlers/message.js, on a fake SoundCloud.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  fresh, take, failNext, mockApi, row, rows, exec, msg, groupMsg, ctxOf, soundcloud, scTrack, asText, ADMIN_ID,
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
  // A track of today: AAC only, joined into one .mp4 (not .m4a: the same container).
  assert.equal(audio.params.audio.name, 'artist - Track 1.mp4');
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

// The ilst items of an uploaded MP4: { '©nam': text, '©ART': text, covr: bytes }.
function mp4Tags(bytes) {
  const b = Buffer.from(bytes);
  const kids = (start, end) => {
    const out = [];
    for (let i = start; i < end;) {
      const size = b.readUInt32BE(i);
      out.push({ type: b.toString('latin1', i + 4, i + 8), start: i + 8, end: i + size });
      i += size;
    }
    return out;
  };
  const get = (list, type) => list.find((x) => x.type === type);
  const moov = get(kids(0, b.length), 'moov');
  const meta = get(kids(moov.start, moov.end), 'udta');
  const ilst = get(kids(get(kids(meta.start, meta.end), 'meta').start + 4, meta.end), 'ilst');
  return Object.fromEntries(kids(ilst.start, ilst.end).map((item) => {
    const data = kids(item.start, item.end)[0];
    const payload = b.subarray(data.start + 8, data.end);
    return [item.type, item.type === 'covr' ? payload.toString() : payload.toString('utf8')];
  }));
}

test('the saved file shows the cover too: title, artist and the 500 px artwork are written into the mp4', async () => {
  soundcloud({ tracks: { [LINK]: scTrack(1) }, mp4: true });
  telegramKeepsAudio();
  await message(msg(USER, LINK), {});
  const audio = take().find((c) => c.method === 'sendAudio');
  assert.deepEqual(mp4Tags(audio.params.audio.data), {
    '\u00a9nam': 'Track 1',
    '\u00a9ART': 'artist',
    covr: '<artworks-1-t500x500.jpg>',
  });
  // The audio itself, after the tags, as it came: the segments in order.
  const file = Buffer.from(audio.params.audio.data);
  for (const name of ['0/10/t1.m4s', '10/20/t1.m4s', 't1/aac_160k/seg3.m4s']) assert.ok(file.includes(Buffer.from(`<${name}>`)), name);
  assert.equal(asText(audio.params.thumbnail.data), '<artworks-1-t300x300.jpg>');   // Telegram's own, as before
  assert.equal(row('SELECT tags_version FROM tracks WHERE track_id = 1').tags_version, 2);
});

test('and into the mp3, as an ID3 tag before the audio', async () => {
  const mp3Link = 'https://soundcloud.com/artist/track-2';
  soundcloud({ tracks: { [mp3Link]: scTrack(2, { streams: ['progressive'] }) } });
  telegramKeepsAudio();
  await message(msg(USER, mp3Link), {});
  const file = Buffer.from(take().find((c) => c.method === 'sendAudio').params.audio.data);
  assert.equal(file.toString('latin1', 0, 3), 'ID3');
  assert.ok(file.includes(Buffer.from('Track 2', 'utf16le')));
  assert.ok(file.includes(Buffer.from('<artworks-2-t500x500.jpg>')));
  assert.ok(file.subarray(-'<t2.mp3>'.length).equals(Buffer.from('<t2.mp3>')));
});

test('a track kept from before the tags is uploaded again once, then sent from the cache', async () => {
  const asked = soundcloud({ tracks: { [LINK]: scTrack(1) } });
  const issued = telegramKeepsAudio();
  exec("INSERT INTO tracks (track_id, permalink_url, title, artist, duration, file_id, format, sends) VALUES (1, 'x', 'Track 1', 'artist', 180, 'UNTAGGED', 'hls audio/mp4 (aac_160k)', 3)");

  await message(msg(USER, LINK), {});
  const first = take().find((c) => c.method === 'sendAudio');
  assert.equal(typeof first.params.audio, 'object', 'uploaded, not the old file_id');
  assert.ok(asked.some((u) => u.includes('/stream/')));
  const kept = row('SELECT file_id, tags_version, sends FROM tracks WHERE track_id = 1');
  assert.deepEqual([kept.file_id, kept.tags_version, kept.sends], [issued[0], 2, 4]);

  asked.length = 0;
  await message(msg(OTHER, LINK), {});
  assert.equal(take().find((c) => c.method === 'sendAudio').params.audio, issued[0]);
  assert.ok(!asked.some((u) => u.includes('/stream/')));
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

test('the probe tries the original upload when the artist offers it; search lists such tracks', async () => {
  soundcloud({ tracks: {
    'https://soundcloud.com/forss/flickermood': scTrack(7, { original: 'flac' }),
    'https://soundcloud.com/a/plain': scTrack(8),
  } });
  const report = await adminProbe({}, ctxOf(ADMIN_ID));
  assert.equal(report.track.downloadable, true);
  const original = report.steps.find((s) => s.name === 'original');
  assert.equal(original.ok, true);
  assert.match(original.value, /^FLAC, \d+ bytes, lossless$/);

  const found = await adminProbe({ search: 'anything' }, ctxOf(ADMIN_ID));
  assert.deepEqual(found.map((t) => t.url), ['https://soundcloud.com/artist/track-7']);
});

test('fileName: artist and title, without characters file systems refuse', () => {
  assert.equal(fileName({ id: 1, artist: 'A/C', title: 'Mix: "Live" <1>' }, 'mp3'), 'A C - Mix Live 1.mp3');
  assert.equal(fileName({ id: 5, artist: '', title: '' }, 'mp4'), 'soundcloud-5.mp4');
});
