// handlers/inline_query.js — someone typed `@bot <song>` in a chat: the
// SoundCloud search results (lib/inline.js). Inline mode must be on for the
// bot: BotFather → /setinline.

import { answerInline } from '../lib/inline.js';

export default async function (query, ctx) {
  await answerInline(query);
}
