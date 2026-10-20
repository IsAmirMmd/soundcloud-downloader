import { table, integer, text, boolean, index, uniqueIndex, sql } from 'sdk/db';

// Database tables, as named exports. `npx tgcloud push` registers the schema;
// `npx tgcloud migrate` applies the changes to the database.
// - No foreign keys (.references() throws): keep integrity in lib/ code.
// - Drop things only with .deprecated('reason'); deleting a line drops nothing.
// - A column added to an existing table stays nullable (or has a default), so
//   `migrate --safe` in CI can always apply it.

// Key/value settings: secrets set by an admin command (API keys), drafts, flags.
// Never sent in backups.
export const settings = table('settings', {
  key:   text('key').primaryKey(),
  value: text('value').notNull(),
});

// Everyone who has started the bot (lib/users.js). The audience for broadcasts,
// the place for per-user state between messages (pending_action).
export const users = table('users', {
  user_id:        integer('user_id').primaryKey(),
  username:       text('username'),
  first_name:     text('first_name'),
  last_name:      text('last_name'),
  language_code:  text('language_code'),
  is_premium:     boolean('is_premium').default(false),
  start_param:    text('start_param'),                  // payload of the first /start (deep link)
  start_count:    integer('start_count').default(0),
  blocked:        boolean('blocked').default(false),    // blocked the bot (my_chat_member, 403)
  unsubscribed:   boolean('unsubscribed').default(false),  // sent /stop
  pending_action: text('pending_action'),               // what the next message answers, e.g. 'feedback'
  pending_at:     integer('pending_at'),
  first_seen_at:  integer('first_seen_at').default(sql`(unixepoch())`),
  last_seen_at:   integer('last_seen_at').default(sql`(unixepoch())`),
}, (t) => ({
  firstSeen: index('idx_users_first_seen').on(t.first_seen_at),
}));

// Example of a feature table — uncomment and adapt:
// export const votes = table('votes', {
//   id:         integer('id').primaryKey({ autoIncrement: true }),
//   user_id:    integer('user_id').notNull(),
//   item_id:    integer('item_id').notNull(),
//   liked:      boolean('liked').notNull(),
//   created_at: integer('created_at').default(sql`(unixepoch())`),
// }, (t) => ({
//   itemUser: uniqueIndex('uidx_votes_item_user').on(t.item_id, t.user_id),
// }));
