// Text for parse_mode: 'HTML' messages. Escape everything that came from a user.

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const link = (url, text) => (url ? `<a href="${esc(url)}">${esc(text)}</a>` : esc(text));

// Numbers with Persian digits; switch the locale for other languages.
export const fa = (n) => Number(n ?? 0).toLocaleString('fa-IR');

// 0.1234 → "۱۲٫۳٪"
export const faPercent = (ratio) => `${Number((ratio * 100).toFixed(1)).toLocaleString('fa-IR')}٪`;

export const userLabel = (u) => (u?.username ? `@${u.username}` : u?.first_name || String(u?.user_id ?? u?.id ?? ''));

// 214 seconds → "۳:۳۴": a track's length, in Persian digits.
export function clock(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const text = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  return text.replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);
}

// Short enough for a list line.
export function clip(s, n = 60) {
  const t = String(s ?? '').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}
