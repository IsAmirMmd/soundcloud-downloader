// Shared by the tests: a fresh database per test, update builders, ctx.

import * as schema from '../tgcloud/schema.js';
import { createTables } from './sdk/db.mjs';
import { resetApi } from './sdk/sdk.mjs';
import { ADMIN_ID } from '../tgcloud/lib/config.js';

export { ADMIN_ID };
export { rows, row, exec } from './sdk/db.mjs';
export { calls, take, mockApi, failNext, mockFetch } from './sdk/sdk.mjs';

export function fresh() {
  createTables(schema);
  resetApi();
}

const user = (id, extra = {}) => ({ id, is_bot: false, first_name: `User${id}`, ...extra });

// A private-chat message from `from` (a user id).
export const msg = (from, text, extra = {}) => ({
  message_id: Math.floor(Math.random() * 1e6),
  date: Math.floor(Date.now() / 1000),
  from: user(from),
  chat: { id: from, type: 'private' },
  text,
  ...extra,
});

// A button press by `from` on a message the bot sent them.
export const press = (from, data, messageId = 1) => ({
  id: `q${Math.random()}`,
  from: user(from),
  data,
  message: { message_id: messageId, chat: { id: from, type: 'private' }, text: '…' },
});

// my_chat_member in a private chat: `status` 'kicked' = blocked the bot, 'member' = unblocked.
export const membership = (from, status) => ({
  chat: { id: from, type: 'private' },
  from: user(from),
  date: Math.floor(Date.now() / 1000),
  old_chat_member: { status: status === 'kicked' ? 'member' : 'kicked', user: { id: 1, is_bot: true } },
  new_chat_member: { status, user: { id: 1, is_bot: true } },
});

// ctx for an endpoint call by `id` (verified init data in the cloud).
export const ctxOf = (id) => ({ initData: { user: user(id) } });
