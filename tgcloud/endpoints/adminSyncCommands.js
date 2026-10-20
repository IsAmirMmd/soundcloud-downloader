// endpoints/adminSyncCommands.js — admin only: sends the "/" command lists to
// Telegram (lib/admin.js syncCommands) and returns what Telegram now has.
// .github/workflows/deploy.yml runs it after every deploy.

import { api } from 'sdk';
import { requireAdmin } from '../lib/access.js';
import { syncCommands } from '../lib/admin.js';
import { ADMIN_ID } from '../lib/config.js';

export default async function (input, ctx) {
  requireAdmin(ctx);
  const result = await syncCommands();
  const now = { public: (await api.getMyCommands({})).map((c) => c.command) };
  if (result.admin === true) {
    now.admin = (await api.getMyCommands({ scope: { type: 'chat', chat_id: ADMIN_ID } })).map((c) => c.command);
  }
  return { ...result, now };
}
