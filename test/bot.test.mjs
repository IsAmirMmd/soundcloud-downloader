// Runs the bot's handlers and endpoints locally against an in-memory database
// and a recorded Bot API (test/sdk/). `npm test` — no deploy, no network.
// Each test starts from an empty database. Add a test next to every feature.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fresh, take, failNext, row, msg, press, membership, ctxOf, ADMIN_ID } from './helpers.mjs';
import message from '../tgcloud/handlers/message.js';
import callbackQuery from '../tgcloud/handlers/callback_query.js';
import myChatMember from '../tgcloud/handlers/my_chat_member.js';
import me from '../tgcloud/endpoints/me.js';
import sqlEndpoint from '../tgcloud/endpoints/sql.js';

const USER = ADMIN_ID + 1;   // anyone but the admin

beforeEach(fresh);

test('/start records the user, keeps the first deep-link payload, and sends the menu', async () => {
  await message(msg(USER, '/start ref_42'), {});
  const [sent] = take();
  assert.equal(sent.method, 'sendMessage');
  assert.equal(sent.params.chat_id, USER);
  assert.ok(sent.params.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'menu:help'));

  await message(msg(USER, '/start other'), {});
  const u = row('SELECT * FROM users WHERE user_id = ?', USER);
  assert.equal(u.start_count, 2);
  assert.equal(u.start_param, 'ref_42');
});

test('menu buttons edit the message into the next screen', async () => {
  await callbackQuery(press(USER, 'menu:help', 7), {});
  const [answer, edit] = take();
  assert.equal(answer.method, 'answerCallbackQuery');
  assert.equal(edit.method, 'editMessageText');
  assert.equal(edit.params.message_id, 7);
  assert.match(edit.params.text, /راهنما/);
  assert.match(edit.params.text, /توسعه‌دهنده: <a href="https:\/\/t\.me\/isAmirMmd">@isAmirMmd<\/a>/);
});

test('admin commands answer the admin only', async () => {
  await message(msg(USER, '/ping'), {});
  assert.deepEqual(take(), []);

  await message(msg(ADMIN_ID, '/ping'), {});
  const [sent] = take();
  assert.equal(sent.params.text, 'pong');
});

test('a failing admin command is reported to the admin', async () => {
  failNext('sendMessage', 400, 'Bad Request: chat not found');
  await message(msg(ADMIN_ID, '/stats'), {});
  const [, report] = take();
  assert.equal(report.params.chat_id, ADMIN_ID);
  assert.match(report.params.text, /Command failed/);
});

test('feedback: the button asks, the next message is forwarded to the admin', async () => {
  await callbackQuery(press(USER, 'feedback'), {});
  take();
  await message(msg(USER, 'Great bot'), {});
  const [forward, thanks] = take();
  assert.equal(forward.params.chat_id, ADMIN_ID);
  assert.match(forward.params.text, /Great bot/);
  assert.equal(thanks.params.chat_id, USER);

  // The question was answered: the next message is not forwarded (it only
  // gets the hint about links, test/download.test.mjs).
  await message(msg(USER, 'hello?'), {});
  assert.ok(take().every((c) => c.params.chat_id === USER));
});

test('/stop and blocking are recorded', async () => {
  await message(msg(USER, '/start'), {});
  await message(msg(USER, '/stop'), {});
  assert.equal(row('SELECT unsubscribed FROM users WHERE user_id = ?', USER).unsubscribed, 1);

  await myChatMember(membership(USER, 'kicked'), {});
  assert.equal(row('SELECT blocked FROM users WHERE user_id = ?', USER).blocked, 1);
  await myChatMember(membership(USER, 'member'), {});
  assert.equal(row('SELECT blocked FROM users WHERE user_id = ?', USER).blocked, 0);
});

test('endpoints: me says who is calling; sql is admin-only', async () => {
  assert.equal((await me({}, ctxOf(USER))).isAdmin, false);
  assert.equal((await me({}, ctxOf(ADMIN_ID))).isAdmin, true);

  await assert.rejects(sqlEndpoint({ q: 'SELECT 1' }, ctxOf(USER)), (e) => e.parameters?.code === 'FORBIDDEN');
  await message(msg(USER, '/start'), {});
  const result = await sqlEndpoint({ q: 'SELECT count(*) AS n FROM users' }, ctxOf(ADMIN_ID));
  assert.deepEqual(result, [{ n: 1 }]);
});
