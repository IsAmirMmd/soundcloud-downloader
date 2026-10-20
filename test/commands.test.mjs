// The "/" menus (lib/admin.js syncCommands): set on every deploy
// (endpoints/adminSyncCommands.js), on the admin's /start and by /setcommands.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fresh, take, failNext, mockApi, msg, ctxOf, row, ADMIN_ID } from './helpers.mjs';
import message from '../tgcloud/handlers/message.js';
import adminSyncCommands from '../tgcloud/endpoints/adminSyncCommands.js';

const USER = ADMIN_ID + 1;

beforeEach(fresh);

const commandsSet = (calls) => calls.filter((c) => c.method === 'setMyCommands');

test('every deploy sets both menus and reports what Telegram has', async () => {
  mockApi('getMyCommands', (p) => (p.scope ? [{ command: 'start' }, { command: 'sc' }] : [{ command: 'start' }]));
  const result = await adminSyncCommands({}, ctxOf(ADMIN_ID));
  const [everyone, admin] = commandsSet(take());
  assert.deepEqual(everyone.params.commands.map((c) => c.command), ['start', 'help']);
  assert.equal(admin.params.scope.chat_id, ADMIN_ID);
  assert.deepEqual(admin.params.commands.map((c) => c.command), ['start', 'help', 'stats', 'sc', 'setclientid', 'backup', 'ping', 'setcommands']);
  assert.deepEqual(result, { public: true, admin: true, now: { public: ['start'], admin: ['start', 'sc'] } });

  await assert.rejects(adminSyncCommands({}, ctxOf(USER)), (e) => e.parameters?.code === 'FORBIDDEN');
});

test('before the admin starts the bot, their menu is reported, not thrown', async () => {
  mockApi('getMyCommands', () => [{ command: 'start' }]);
  failNext('setMyCommands', 400, 'Bad Request: chat not found', (p) => Boolean(p.scope));
  const result = await adminSyncCommands({}, ctxOf(ADMIN_ID));
  assert.equal(result.public, true);
  assert.match(result.admin, /chat not found/);
});

test("the admin's /start sets the menus; anyone else's doesn't", async () => {
  await message(msg(USER, '/start'), {});
  assert.equal(commandsSet(take()).length, 0);
  await message(msg(ADMIN_ID, '/start'), {});
  assert.equal(commandsSet(take()).length, 2);
});

test('/setcommands says when the admin menu could not be set', async () => {
  failNext('setMyCommands', 400, 'Bad Request: chat not found', (p) => Boolean(p.scope));
  await message(msg(ADMIN_ID, '/setcommands'), {});
  const report = take().find((c) => c.method === 'sendMessage');
  assert.match(report.params.text, /Public commands updated ✅\nAdmin commands: Bad Request: chat not found/);
});

test('/setclientid keeps a valid id and refuses anything else', async () => {
  await message(msg(ADMIN_ID, '/setclientid nope'), {});
  assert.match(take()[0].params.text, /Usage/);
  await message(msg(ADMIN_ID, `/setclientid ${'b'.repeat(32)}`), {});
  assert.match(take()[0].params.text, /saved/);
  assert.equal(row("SELECT value FROM settings WHERE key = 'sc:client_id'").value, 'b'.repeat(32));

  await message(msg(USER, `/setclientid ${'c'.repeat(32)}`), {});
  assert.equal(row("SELECT value FROM settings WHERE key = 'sc:client_id'").value, 'b'.repeat(32));
});
