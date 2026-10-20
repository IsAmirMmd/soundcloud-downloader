import { db, EndpointError } from 'sdk';
import { ADMIN_ID } from '../lib/config.js';

// Runs raw SQL against the bot's database — for `npm run sql -- "<query>"`
// (scripts/sql.mjs). Admin only: once deployed it is reachable from the
// Mini App, so anyone else is refused.
export default async function ({ q } = {}, ctx) {
  if (ctx.initData?.user?.id !== ADMIN_ID) {
    throw new EndpointError('Forbidden', { code: 'FORBIDDEN' });
  }
  if (typeof q !== 'string' || !q.trim()) {
    throw new EndpointError('Pass the query as { q: "..." }', { code: 'NO_QUERY' });
  }
  // Statements that return rows go through all(); the rest (UPDATE, DELETE, …) through run().
  return /^\s*(select|with|pragma|explain)\b/i.test(q) || /\breturning\b/i.test(q)
    ? await db.all(q)
    : await db.run(q);
}
