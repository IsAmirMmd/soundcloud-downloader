// handlers/message.js — runs on each `message` update (private chats, groups).
// The platform calls the default export with the Message; the full update is
// `ctx.update`. Keep this file a router: the work happens in lib/.
//
// Order matters: payments → /start (with deep-link payloads) → /stop → admin
// commands → public commands → the answer to a pending question → ignore.

import { api } from 'sdk';
import { ADMIN_ID } from '../lib/config.js';
import { trackStart, unsubscribe, takePending } from '../lib/users.js';
import { sendHome } from '../lib/menu.js';
import { sendStats, sendBackup, setCommands } from '../lib/admin.js';

// The admin command in `text`, started; or null when it is not one.
// Scheduled jobs call these too (.github/workflows/scheduled.yml).
function adminCommand(message, text) {
  if (text === '/ping') return api.sendMessage({ chat_id: message.chat.id, text: 'pong' });
  if (text === '/stats') return sendStats();
  if (text === '/backup') return sendBackup();
  if (text === '/setcommands') return setCommands();
  return null;
}

// /start <payload> from a deep link (t.me/<bot>?start=<payload>): route by
// prefix, e.g. `ref_<user id>`, `inv_<code>`. true when handled.
// The first payload a user came with is kept in users.start_param (attribution).
async function startPayload(message, payload) {
  // const invite = /^inv_(\w+)$/.exec(payload);
  // if (invite) { await acceptInvite(message, invite[1]); return true; }
  return false;
}

export default async function (message, ctx) {
  const text = (message.text ?? message.caption ?? '').trim();
  const isPrivate = message.chat.type === 'private';

  // if (message.successful_payment) return recordPayment(message);   // Telegram Stars — tgcloud-growth skill

  if (isPrivate && /^\/start(\s|$)/.test(text)) {
    await trackStart(message);
    const payload = /^\/start\s+(\S+)$/.exec(text)?.[1];
    if (payload && (await startPayload(message, payload))) return;
    return sendHome(message);
  }
  if (isPrivate && text === '/stop') return unsubscribe(message);

  if (message.from?.id === ADMIN_ID) {
    const command = adminCommand(message, text);
    if (command) {
      try {
        await command;
      } catch (e) {
        // Otherwise a failed command is silent: logs are only visible through `tgcloud run`.
        console.error(e);
        await api.sendMessage({ chat_id: ADMIN_ID, text: `⚠️ Command failed:\n${e.message}` });
      }
      return;
    }
  }

  // The answer to a question the bot asked (lib/users.js askFor).
  const pending = await takePending(message);
  if (pending === 'feedback') {
    await api.sendMessage({ chat_id: ADMIN_ID, text: `💬 Feedback from ${message.from.id}:\n${text}` });
    return api.sendMessage({ chat_id: message.chat.id, text: 'ممنون، رسید 🙏' });
  }

  // Anything else (unknown commands, free text in groups) gets no reply.
}
