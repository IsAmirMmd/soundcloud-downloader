// handlers/callback_query.js — an inline button was pressed. Routed by the
// prefix of callback_data, one lib module per prefix:
//   menu:<screen>   the /start menu (lib/menu.js)
//   feedback        ask for a message; handlers/message.js takes the answer
//   meta:<field>    ✏️ 🎤 🖼 under an audio, ❌ under its question (lib/metadata.js)
//   dl:, sr:        a search result, ◀️ ▶️ under the results (lib/search.js)
//   il:<track id>   "⏳" under an inline result: bring the audio (lib/inline.js)
// callback_data is at most 64 bytes, and it comes from the client: check who
// pressed (query.from.id) before acting, and always answer the query.

import { api } from 'sdk';
import { handleMenuCallback } from '../lib/menu.js';
import { handleMetaCallback } from '../lib/metadata.js';
import { handleSearchCallback } from '../lib/search.js';
import { handleInlineCallback } from '../lib/inline.js';
import { askFor } from '../lib/users.js';

export default async function (query, ctx) {
  if (await handleMenuCallback(query)) return;
  if (await handleMetaCallback(query)) return;
  if (await handleSearchCallback(query)) return;
  if (await handleInlineCallback(query)) return;

  if (query.data === 'feedback') {
    await askFor(query.from, 'feedback');
    await api.answerCallbackQuery({ callback_query_id: query.id });
    return api.sendMessage({ chat_id: query.from.id, text: '💬 پیامت رو بنویس 👇' });
  }

  // Unknown or stale button: stop the spinner anyway.
  await api.answerCallbackQuery({ callback_query_id: query.id }).catch(console.error);
}
