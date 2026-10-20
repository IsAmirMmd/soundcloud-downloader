// The admin's commands (handlers/message.js routes to them). Each returns a
// promise; a failure is reported to the admin as "⚠️ Command failed".

import { api, db, InputFile } from 'sdk';
import { sql } from 'sdk/db';
import { ADMIN_ID } from './config.js';
import { toCsv, utf8Encode } from './files.js';
import { fa } from './html.js';
import { stamp } from './time.js';

const tell = (text, extra = {}) => api.sendMessage({ chat_id: ADMIN_ID, text, ...extra });

// Counts over the users table — for /stats and the Mini App (endpoints/adminStats.js).
export async function userStats() {
  const s = await db.get(sql`
    SELECT count(*) AS users,
           coalesce(sum(start_count > 0), 0) AS started,
           coalesce(sum(blocked = 1), 0) AS blocked,
           coalesce(sum(first_seen_at > unixepoch() - 86400), 0) AS new_1d,
           coalesce(sum(first_seen_at > unixepoch() - 7 * 86400), 0) AS new_7d
    FROM users`);
  // Raw SQL: aggregates may come back as strings.
  return Object.fromEntries(Object.entries(s ?? {}).map(([k, v]) => [k, Number(v ?? 0)]));
}

// /stats
export async function sendStats() {
  const s = await userStats();
  await tell(
    `👥 Users: ${fa(s.users)}\n▶️ Started: ${fa(s.started)}\n⛔️ Blocked: ${fa(s.blocked)}\n` +
    `🆕 Last 24h: ${fa(s.new_1d)} · last 7 days: ${fa(s.new_7d)}`);
}

// Tables in /backup. `settings` is left out on purpose: it holds secrets that
// should not sit in a chat as a file.
const BACKUP_TABLES = ['users'];

// /backup — every table as a CSV file (run on a schedule by
// .github/workflows/scheduled.yml if you enable it).
export async function sendBackup() {
  const files = [];
  for (const table of BACKUP_TABLES) {
    const rows = await db.all(sql`SELECT * FROM ${sql.raw(table)}`);
    if (rows.length) files.push({ name: `${table}_${stamp(new Date(), true)}.csv`, rows });
  }
  if (!files.length) return tell('Nothing to back up yet.');
  // The BOM makes Excel open the UTF-8 file correctly.
  const media = files.map((f) => ({
    type: 'document',
    media: new InputFile(utf8Encode('﻿' + toCsv(f.rows)), f.name, { type: 'text/csv' }),
  }));
  media[media.length - 1].caption = `🗄 Backup — ${stamp()}`;
  // An album holds 2–10 files; a single file goes as a document.
  if (media.length === 1) {
    await api.sendDocument({ chat_id: ADMIN_ID, document: media[0].media, caption: media[0].caption });
  } else {
    for (let i = 0; i < media.length; i += 10) await api.sendMediaGroup({ chat_id: ADMIN_ID, media: media.slice(i, i + 10) });
  }
}

// /setcommands — the list Telegram suggests after typing "/". Everyone sees
// the public commands; the admin's own chat also lists the admin ones.
// Run it once after deploying, and again whenever the lists change.
export async function setCommands() {
  const everyone = [{ command: 'start', description: 'شروع و منوی ربات' }];
  await api.setMyCommands({ commands: everyone });
  await api.setMyCommands({
    scope: { type: 'chat', chat_id: ADMIN_ID },
    commands: [
      ...everyone,
      { command: 'stats', description: 'آمار کاربران' },
      { command: 'backup', description: 'بکاپ جدول‌ها (CSV)' },
      { command: 'setcommands', description: 'به‌روزرسانی همین لیست' },
    ],
  });
  await tell('Commands updated ✅');
}
