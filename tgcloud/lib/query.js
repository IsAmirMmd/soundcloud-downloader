// Building blocks for list endpoints: pagination, search, sorting, WHERE.
// Values always go through ${} (bound parameters); column names only ever come
// from this code, never from client input.

import { sql } from 'sdk/db';

const toInt = (v, fallback) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : fallback);

// { page, size } from the client (1-based) → clamped values plus the SQL offset.
export function pageParams(input = {}) {
  const size = Math.min(100, Math.max(5, toInt(input.size, 20)));
  const page = Math.max(1, toInt(input.page, 1));
  return { page, size, offset: (page - 1) * size };
}

// The list endpoints' answer: { rows, page, size, total, pages }.
export const pageResult = (rows, total, { page, size }) =>
  ({ rows, page, size, total, pages: Math.max(1, Math.ceil(total / size)) });

// WHERE from a list of conditions (nulls skipped), or nothing.
export function whereOf(conds) {
  const list = conds.filter(Boolean);
  return list.length ? sql`WHERE ${list.reduce((a, b) => sql`${a} AND ${b}`)}` : sql``;
}

// The search box: text matches the `names` columns; a number also the `ids`.
export function searchCondition(q, { names, ids = [] }) {
  const text = typeof q === 'string' ? q.trim().slice(0, 100) : '';
  if (!text) return null;
  const parts = names.map((col) => sql`${sql.raw(col)} LIKE ${`%${text}%`}`);
  if (/^-?\d+$/.test(text)) parts.push(...ids.map((col) => sql`${sql.raw(col)} = ${Number(text)}`));
  return sql`(${parts.reduce((a, b) => sql`${a} OR ${b}`)})`;
}

// ORDER BY from the client's { sort, dir }. `columns` maps each allowed sort key
// to an SQL expression written here — the client's value is only a lookup key.
// Empty values sort last; `tiebreak` keeps pages stable.
export function orderBy(input, columns, fallback, tiebreak) {
  const key = Object.hasOwn(columns, input?.sort ?? '') ? input.sort : fallback;
  const dir = sql.raw(input?.dir === 'asc' ? 'ASC' : 'DESC');
  const expr = sql.raw(columns[key]);
  return sql`ORDER BY (${expr}) IS NULL, ${expr} ${dir}, ${sql.raw(tiebreak)}`;
}

// `column IN (…)` for a list of values (an empty list matches nothing).
export function inList(column, values) {
  if (!values.length) return sql`0`;
  return sql`${sql.raw(column)} IN (${values.map((v) => sql`${v}`).reduce((a, b) => sql`${a}, ${b}`)})`;
}

// Raw SQL rows come back unconverted: aggregates may be strings, booleans 0/1.
export const num = (v) => Number(v ?? 0);
