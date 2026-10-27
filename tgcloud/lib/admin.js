// The admin's commands (handlers/message.js routes to them). Each returns a
// promise; a failure is reported to the admin as "⚠️ Command failed".

import { api, db, InputFile, BotApiError } from 'sdk';
import { sql } from 'sdk/db';
import { ADMIN_ID } from './config.js';
import { toCsv, utf8Encode } from './files.js';
import { fa } from './html.js';
import { setSetting } from './settings.js';
import { downloadStats } from './download.js';
import { searchStats } from './search.js';
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

// /stats — the bot's users, then what they downloaded (and how they asked) and why it failed.
export async function sendStats() {
  const s = await userStats();
  const d = await downloadStats();
  const q = await searchStats();
  const errors = d.errors.map((e) => `${e.error}: ${fa(e.n)}`).join(' · ') || '—';
  await tell(
    `👥 Users: ${fa(s.users)}\n▶️ Started: ${fa(s.started)}\n⛔️ Blocked: ${fa(s.blocked)}\n` +
    `🆕 Last 24h: ${fa(s.new_1d)} · last 7 days: ${fa(s.new_7d)}\n\n` +
    `🔗 Asked: ${fa(d.links)} from ${fa(d.users)} users · last 24h: ${fa(d.links_1d)} from ${fa(d.users_1d)}\n` +
    `   by search: ${fa(d.from_search)} · inline: ${fa(d.from_inline)} · t_ deep link: ${fa(d.from_deeplink)} · the rest by link\n` +
    `🔎 Searches: ${fa(q.searches)} from ${fa(q.users)} users · last 24h: ${fa(q.searches_1d)}\n` +
    `⬇️ Downloaded: ${fa(d.sent)} · ♻️ from cache: ${fa(d.cached)} · ❌ failed: ${fa(d.failed)}\n` +
    `🎵 Tracks on Telegram: ${fa(d.tracks)} · in the storage channel: ${fa(d.stored)}\n` +
    `✏️ Edited copies: ${fa(d.edits)} by ${fa(d.edit_users)} users\n` +
    `⚠️ Errors: ${errors}`);
}

// Tables in /backup. `settings` is left out on purpose: it holds secrets that
// should not sit in a chat as a file.
const BACKUP_TABLES = ['users', 'tracks', 'downloads', 'sent_audios', 'searches'];

// /backup — every table as a CSV file (run on a schedule by
// .github/workflows/scheduled.yml).
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

// /setclientid <32 characters> — use this SoundCloud client_id instead of the
// scraped one (lib/soundcloud.js), e.g. while scraping is broken. The id is
// public (every visitor of soundcloud.com gets it), so the message stays.
export async function setClientId(text) {
  const id = text.replace(/^\/setclientid(@\w+)?\s*/, '').trim();
  if (!/^[a-zA-Z0-9]{32}$/.test(id)) return tell('Usage: /setclientid <the 32-character client_id>');
  await setSetting('sc:client_id', id);
  await tell('client_id saved ✅ — check it with /sc');
}

// The lists Telegram suggests after typing "/". Everyone sees the public
// commands; the admin's own chat also lists the admin ones.
const PUBLIC_COMMANDS = [
  { command: 'start', description: 'شروع و منوی ربات' },
  { command: 'help', description: 'راهنمای دانلود از ساندکلاد' },
];
const ADMIN_COMMANDS = [
  ...PUBLIC_COMMANDS,
  { command: 'stats', description: 'آمار کاربران و دانلودها' },
  { command: 'sc', description: 'بررسی دسترسی به ساندکلاد (لینک اختیاری)' },
  { command: 'setclientid', description: 'تنظیم دستی client_id ساندکلاد' },
  { command: 'backup', description: 'بکاپ جدول‌ها (CSV)' },
  { command: 'ping', description: 'ربات زنده است؟' },
  { command: 'setcommands', description: 'به‌روزرسانی همین لیست' },
];

// Sends both lists to Telegram. Runs on every deploy (.github/workflows/deploy.yml
// → endpoints/adminSyncCommands.js) and on the admin's /start, so the "/" menu
// never waits for /setcommands. The admin's list needs a chat with the admin:
// before their first /start it fails, and that is reported, not thrown.
// → { public: true, admin: true | '<why not>' }
export async function syncCommands() {
  await api.setMyCommands({ commands: PUBLIC_COMMANDS });
  try {
    await api.setMyCommands({ scope: { type: 'chat', chat_id: ADMIN_ID }, commands: ADMIN_COMMANDS });
    return { public: true, admin: true };
  } catch (e) {
    if (!(e instanceof BotApiError)) throw e;
    return { public: true, admin: `${e.description} (the admin hasn't started the bot yet?)` };
  }
}

// /setcommands — the same, by hand.
export async function setCommands() {
  const r = await syncCommands();
  await tell(r.admin === true ? 'Commands updated ✅' : `Public commands updated ✅\nAdmin commands: ${r.admin}`);
}
