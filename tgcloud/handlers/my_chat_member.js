// handlers/my_chat_member.js — the bot's own membership changed in a chat.
// In a private chat that means the user blocked ('kicked') or unblocked the
// bot: keep users.blocked right so broadcasts skip them.
// In groups/channels: the bot was added, promoted or removed (see the
// tgcloud-growth skill, references/multi-tenant.md).

import { setBlocked } from '../lib/users.js';

export default async function (update, ctx) {
  if (update.chat.type === 'private') {
    await setBlocked(update.chat.id, update.new_chat_member?.status === 'kicked');
  }
}
