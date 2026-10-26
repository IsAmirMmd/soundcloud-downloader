// handlers/chosen_inline_result.js — an inline result was sent to a chat: a
// "⏳" message becomes the track's audio (lib/inline.js). Telegram sends these
// only with inline feedback on: BotFather → /setinlinefeedback → 100%.

import { completeChosen } from '../lib/inline.js';

export default async function (chosen, ctx) {
  await completeChosen(chosen);
}
