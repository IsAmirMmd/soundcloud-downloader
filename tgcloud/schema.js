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

// The tracks already on Telegram (lib/download.js): a SoundCloud track id → the
// file_id of its audio, so the next request for it is sent again without
// downloading anything.
export const tracks = table('tracks', {
  track_id:       integer('track_id').primaryKey(),     // SoundCloud's id
  permalink_url:  text('permalink_url'),
  title:          text('title'),
  artist:         text('artist'),
  duration:       integer('duration'),                  // seconds
  file_id:        text('file_id').notNull(),
  file_unique_id: text('file_unique_id'),
  size:           integer('size'),                      // bytes uploaded
  format:         text('format'),                       // which stream it came from, e.g. 'progressive audio/mpeg'
  sends:          integer('sends').default(0),          // times delivered, the first upload included
  created_at:     integer('created_at').default(sql`(unixepoch())`),
  last_sent_at:   integer('last_sent_at').default(sql`(unixepoch())`),
});

// Every link someone sent (lib/download.js): what came of it, for /stats and
// for finding out why downloads fail (logs are visible only through `tgcloud run`).
export const downloads = table('downloads', {
  id:         integer('id').primaryKey({ autoIncrement: true }),
  user_id:    integer('user_id').notNull(),
  url:        text('url').notNull(),                    // the link as normalized by lib/soundcloud.js
  track_id:   integer('track_id'),                      // null when it never resolved
  status:     text('status').notNull(),                 // 'sent' (downloaded) | 'cached' (file_id reused) | 'failed'
  error:      text('error'),                            // SoundcloudError code, or INTERNAL
  ms:         integer('ms'),                            // from the link to the audio (or the error)
  created_at: integer('created_at').default(sql`(unixepoch())`),
}, (t) => ({
  created: index('idx_downloads_created').on(t.created_at),
  user:    index('idx_downloads_user').on(t.user_id),
}));
