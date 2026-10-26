// Search inside the bot (lib/search.js): a song's name → the results as
// buttons → a press downloads it, like a link.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fresh, take, mockApi, row, rows, msg, press, soundcloud, scTrack, ADMIN_ID, STORAGE_CHAT_ID } from './helpers.mjs';
import message from '../tgcloud/handlers/message.js';
import callbackQuery from '../tgcloud/handlers/callback_query.js';

const USER = ADMIN_ID + 1;

// Ten results in SoundCloud's order, two of which the bot can't deliver.
const RESULTS = {
  'https://soundcloud.com/a/one': scTrack(1, { title: 'Shab', seconds: 214 }),
  'https://soundcloud.com/a/goplus': scTrack(2, { policy: 'SNIP', snipped: true }),
  'https://soundcloud.com/a/blocked': scTrack(3, { policy: 'BLOCK' }),
  ...Object.fromEntries([4, 5, 6, 7, 8, 9, 10].map((id) => [`https://soundcloud.com/a/t${id}`, scTrack(id)])),
};

beforeEach(() => {
  fresh();
  soundcloud({ tracks: RESULTS });
  let n = 700;
  mockApi('sendMessage', (p) => ({ message_id: n++, chat: { id: p.chat_id } }));
  mockApi('sendAudio', (p) => ({ message_id: n++, chat: { id: p.chat_id }, audio: { file_id: typeof p.audio === 'string' ? p.audio : `F${n}` } }));
});

const buttons = (call) => call.params.reply_markup?.inline_keyboard.flat() ?? [];

test('a name brings the results as buttons, without what the bot can\'t deliver, and ▶️ for more', async () => {
  const m = msg(USER, '  shab   tehran ');
  await message(m, {});
  const reply = take().find((c) => c.method === 'sendMessage');
  assert.match(reply.params.text, /نتیجه‌های «shab tehran»/);
  assert.equal(reply.params.reply_parameters.message_id, m.message_id);
  const list = buttons(reply);
  // The first 8 asked: 1–8, minus the Go+ preview and the blocked one.
  assert.deepEqual(list.filter((b) => b.callback_data.startsWith('dl:')).map((b) => b.callback_data),
    ['dl:1', 'dl:4', 'dl:5', 'dl:6', 'dl:7', 'dl:8']);
  assert.equal(list[0].text, '🎵 Shab — artist · ۳:۳۴');
  // …and the two left out are named, with why.
  assert.match(reply.params.text, /این‌ها پیدا شدن ولی قابل دانلود نیستن:<\/b>\n💎 Track 2 — artist · فقط پیش‌نمایش Go\+\n🚫 Track 3 — artist · در دسترس نیست$/);
  const search = row('SELECT * FROM searches');
  assert.deepEqual([search.user_id, search.query], [USER, 'shab tehran']);
  assert.deepEqual(list.slice(-1).map((b) => [b.text, b.callback_data]), [['بعدی ▶️', `sr:${search.id}:8`]]);
});

test('a label\'s original, DRM only, is named and explained; the remixes are the list', async () => {
  soundcloud({ tracks: {
    'https://soundcloud.com/theweeknd/cry-for-me': scTrack(20, { title: 'Cry For Me', user: { username: 'The Weeknd' }, streams: ['drm'] }),
    'https://soundcloud.com/x/remix': scTrack(21, { title: 'The Weeknd - Cry For Me (Remix)' }),
  } });
  await message(msg(USER, 'cry for me'), {});
  const reply = take().find((c) => c.method === 'sendMessage');
  assert.deepEqual(buttons(reply).map((b) => b.callback_data), ['dl:21']);
  assert.match(reply.params.text, /🔒 Cry For Me — The Weeknd · رمزگذاری‌شده \(DRM\)/);
  assert.match(reply.params.text, /لیبل‌های بزرگ/);
});

test('a first page with nothing to download still names what it found, and ▶️ goes on', async () => {
  soundcloud({ tracks: Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map((id) => [`https://soundcloud.com/a/t${id}`, scTrack(id, { streams: id < 9 ? ['drm'] : undefined })])) });
  await message(msg(USER, 'all locked'), {});
  const reply = take().find((c) => c.method === 'sendMessage');
  assert.match(reply.params.text, /پیدا نکردم/);
  assert.match(reply.params.text, /🔒 Track 1 — artist[\s\S]*🔒 Track 4 — artist · رمزگذاری‌شده \(DRM\)\nو ۴ تای دیگه/);
  const id = row('SELECT id FROM searches').id;
  assert.deepEqual(buttons(reply).map((b) => b.callback_data), [`sr:${id}:8`]);
});

test('▶️ and ◀️ page through in the same message', async () => {
  await message(msg(USER, 'shab'), {});
  const id = row('SELECT id FROM searches').id;
  take();
  await callbackQuery(press(USER, `sr:${id}:8`, 700), {});
  const [, edit] = take();
  assert.equal(edit.method, 'editMessageText');
  assert.equal(edit.params.message_id, 700);
  assert.deepEqual(buttons(edit).map((b) => b.callback_data), ['dl:9', 'dl:10', `sr:${id}:0`]);
  assert.equal(buttons(edit).at(-1).text, '◀️ قبلی');
});

test('a result pressed is downloaded like a link: ⏳, the channel, the audio with its buttons', async () => {
  await message(msg(USER, 'shab'), {});
  take();
  await callbackQuery(press(USER, 'dl:1', 700), {});
  const calls = take();
  assert.equal(calls[0].method, 'answerCallbackQuery');
  assert.match(calls.find((c) => c.method === 'sendMessage').params.text, /⏳/);
  const [toChannel, toUser] = calls.filter((c) => c.method === 'sendAudio');
  assert.equal(toChannel.params.chat_id, STORAGE_CHAT_ID);
  assert.equal(toUser.params.chat_id, USER);
  assert.equal(toUser.params.title, 'Shab');
  assert.equal(toUser.params.reply_parameters.message_id, 700);
  assert.ok(buttons(toUser).some((b) => b.callback_data === 'meta:title'));
  const d = row('SELECT * FROM downloads');
  assert.deepEqual([d.user_id, d.track_id, d.status, d.via, d.url], [USER, 1, 'sent', 'search', 'https://soundcloud.com/artist/track-1']);

  await message(msg(ADMIN_ID, '/stats'), {});
  const stats = take().find((c) => /Users:/.test(c.params.text ?? ''));
  assert.match(stats.params.text, /by search: ۱ · inline: ۰/);
  assert.match(stats.params.text, /Searches: ۱ from ۱ users · last 24h: ۱/);
});

test('nothing found, a track gone, an old search, a short text', async () => {
  soundcloud({ tracks: {} });
  await message(msg(USER, 'nothing like it'), {});
  assert.match(take().find((c) => c.method === 'sendMessage').params.text, /پیدا نکردم/);

  await callbackQuery(press(USER, 'dl:404', 700), {});
  assert.match(take().find((c) => c.method === 'editMessageText').params.text, /پیدا نشد/);
  assert.deepEqual([row('SELECT status, error, via FROM downloads').error], ['NOT_FOUND']);

  await callbackQuery(press(USER, 'sr:999:8', 700), {});
  assert.match(take()[0].params.text, /قدیمیه/);

  await message(msg(USER, 'a'), {});
  assert.match(take()[0].params.text, /اسم آهنگ رو بفرست/);
  assert.equal(rows('SELECT * FROM searches').length, 1);
});

test('SoundCloud down: the search says so', async () => {
  soundcloud({ tracks: RESULTS, down: ['api-v2.soundcloud.com'] });
  await message(msg(USER, 'shab'), {});
  assert.match(take().find((c) => c.method === 'sendMessage').params.text, /دسترسی ندارم/);
});

test('someone else\'s ◀️ ▶️ is refused: a search belongs to who made it', async () => {
  await message(msg(USER, 'shab'), {});
  const id = row('SELECT id FROM searches').id;
  take();
  await callbackQuery(press(USER + 5, `sr:${id}:8`, 700), {});
  const calls = take();
  assert.ok(!calls.some((c) => c.method === 'editMessageText'));
  assert.equal(calls[0].params.show_alert, true);
});
