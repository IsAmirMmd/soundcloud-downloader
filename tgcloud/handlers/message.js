// handlers/message.js — runs on each `message` update (private chats, groups).
// The platform calls the default export with the Message; the full update is
// `ctx.update`. Keep this file a router: the work happens in lib/.
//
// Order matters: payments → /start (with deep-link payloads) → /stop → admin
// commands → public commands → the answer to a pending question (feedback,
// or a new title / artist / cover for an audio) → a SoundCloud link to
// download → any other text, searched (private chats) → a hint → ignore.

import { api } from 'sdk';
import { ADMIN_ID } from '../lib/config.js';
import { trackStart, unsubscribe, takePending } from '../lib/users.js';
import { sendHome, sendScreen } from '../lib/menu.js';
import { sendStats, sendBackup, setCommands, syncCommands, setClientId } from '../lib/admin.js';
import { sendProbe } from '../lib/probe.js';
import { replyDownload } from '../lib/download.js';
import { applyMetaEdit } from '../lib/metadata.js';
import { replySearch } from '../lib/search.js';

// The admin command in `text`, started; or null when it is not one.
// Scheduled jobs call these too (.github/workflows/scheduled.yml).
function adminCommand(message, text) {
  if (text === '/ping') return api.sendMessage({ chat_id: message.chat.id, text: 'pong' });
  if (text === '/stats') return sendStats();
  if (text === '/backup') return sendBackup();
  if (text === '/setcommands') return setCommands();
  if (/^\/sc(@\w+)?(\s|$)/.test(text)) return sendProbe(text);
  if (/^\/setclientid(@\w+)?(\s|$)/.test(text)) return setClientId(text);
  return null;
}

// /start <payload> from a deep link (t.me/<bot>?start=<payload>): route by
// prefix, e.g. `ref_<user id>`, `inv_<code>`. true when handled.
// The first payload a user came with is kept in users.start_param (attribution).
async function startPayload(message, payload) {
  if (payload === 'help') { await sendScreen(message, 'help'); return true; }
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
    // The admin's "/" menu can be set only once they have a chat with the bot.
    if (message.from?.id === ADMIN_ID) await syncCommands().catch(console.error);
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

  if (isPrivate && text === '/help') return sendScreen(message, 'help');

  // The answer to a question the bot asked (lib/users.js askFor).
  const pending = await takePending(message);
  if (pending === 'feedback') {
    await api.sendMessage({ chat_id: ADMIN_ID, text: `💬 Feedback from ${message.from.id}:\n${text}` });
    return api.sendMessage({ chat_id: message.chat.id, text: 'ممنون، رسید 🙏' });
  }
  // ✏️ 🎤 🖼 under an audio asked for this: a copy with the new metadata.
  if (pending?.startsWith('meta:') && (await applyMetaEdit(message, pending))) return;

  // A SoundCloud link sent to the bot itself: the track comes back as audio.
  // Groups are left alone for now (docs/SOUNDCLOUD.md, roadmap).
  if (isPrivate && (await replyDownload(message, text))) return;

  // Other text sent to the bot: the name of a song, searched (lib/search.js).
  // Not a photo's caption.
  if (isPrivate && message.text && !text.startsWith('/') && (await replySearch(message, text))) return;

  // Anything else in the private chat: say what the bot takes. Unknown
  // commands and everything in groups get no reply.
  if (isPrivate && text && !text.startsWith('/')) {
    return api.sendMessage({ chat_id: message.chat.id, text: '🔗 لینک یه ترک ساندکلاد یا اسم آهنگ رو بفرست تا برات پیداش کنم.\nراهنما: /help' });
  }
}
