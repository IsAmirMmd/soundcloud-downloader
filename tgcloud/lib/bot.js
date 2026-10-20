// The bot's own account, asked once and kept: it doesn't change.

import { api } from 'sdk';

let me = null;

// The bot's @username (without @), for the audio captions and the menu.
export async function botUsername() {
  me ??= await api.getMe().catch((e) => { console.error(e); return null; });
  return me?.username ?? 'bot';
}
