import { UTC_OFFSET_MINUTES } from './config.js';

export const DAY = 86400;
export const now = () => Math.floor(Date.now() / 1000);   // unix seconds, like unixepoch()

const pad = (n) => String(n).padStart(2, '0');

// Wall-clock time in the bot's timezone (a fixed offset, see config.js).
export function localTime(date = new Date()) {
  const d = new Date(date.getTime() + UTC_OFFSET_MINUTES * 60_000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes() };
}

// "yyyy-MM-dd HH:mm", or "yyyy-MM-dd_HH-mm" for file names.
export function stamp(date = new Date(), forFileName = false) {
  const t = localTime(date);
  const day = `${t.year}-${pad(t.month)}-${pad(t.day)}`;
  return forFileName ? `${day}_${pad(t.hour)}-${pad(t.minute)}` : `${day} ${pad(t.hour)}:${pad(t.minute)}`;
}
