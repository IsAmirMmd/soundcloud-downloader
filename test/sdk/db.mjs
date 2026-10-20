// A stand-in for `sdk/db` on node:sqlite (Node 22+), for tests that run the
// bot's modules locally. It covers the parts of the SDK a typical bot uses —
// the schema DSL, the query builder, raw SQL, the operators — with the same
// conversions: table-bound queries convert boolean/json/timestamp columns,
// raw SQL returns raw values. Not the real thing: when it disagrees with
// `npx tgcloud run`, the cloud is right.

import { DatabaseSync } from 'node:sqlite';

let sqlite = new DatabaseSync(':memory:');

// ---------- schema DSL ----------

const TABLE = Symbol('table');

class Column {
  constructor(type, name, opts = {}) {
    this.type = type;
    this.name = name;
    this.mode = opts.mode ?? (type === 'boolean' ? 'boolean' : type === 'json' ? 'json' : undefined);
  }
  primaryKey(opts = {}) { this.pk = opts; return this; }
  notNull() { this.notNullable = true; return this; }
  unique() { this.isUnique = true; return this; }
  default(value) { this.defaultValue = value; return this; }
  deprecated() { this.isDeprecated = true; return this; }
  references() { throw new Error('Foreign keys are not supported (.references())'); }
}

const column = (type) => (name, opts) => new Column(type, name, opts);
export const integer = column('integer');
export const text = column('text');
export const real = column('real');
export const float = real;
export const blob = column('blob');
export const boolean = column('boolean');
export const json = column('json');

function indexBuilder(unique) {
  return (name) => ({
    name, unique, columns: [],
    on(...columns) { this.columns = columns; return this; },
    where(cond) { this.partial = cond; return this; },
    deprecated() { this.isDeprecated = true; return this; },
  });
}
export const index = indexBuilder(false);
export const uniqueIndex = indexBuilder(true);
export const unique = indexBuilder(true);
export const primaryKey = ({ columns }) => ({ primaryKey: columns });
export const check = (name, cond) => ({ check: cond, name });
export function foreignKey() { throw new Error('Foreign keys are not supported (foreignKey())'); }

export function table(name, columns, extras) {
  const t = {};
  for (const [key, col] of Object.entries(columns)) {
    col.name ??= key;
    col.key = key;
    t[key] = col;
  }
  t[TABLE] = { name, columns, extras: extras ? extras(t) : {} };
  for (const m of ['strict', 'withoutRowid', 'constraint', 'deprecated']) t[m] = () => t;
  return t;
}

const isTable = (t) => Boolean(t?.[TABLE]);
const tableName = (t) => t[TABLE].name;
const liveColumns = (t) => Object.values(t[TABLE].columns).filter((c) => !c.isDeprecated);

// ---------- sql ----------

export function sql(strings, ...values) {
  return { isSql: true, strings: [...strings], values };
}
sql.raw = (s) => ({ isSql: true, strings: [String(s)], values: [] });

function toDb(value, col) {
  if (value === undefined) return null;
  if (value?.isSql) return value;
  if (col?.mode === 'json' && value !== null) return JSON.stringify(value);
  if (col?.mode === 'timestamp_ms' && value instanceof Date) return value.getTime();
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

function fromDb(value, col) {
  if (value == null) return value;
  if (col.mode === 'boolean') return Boolean(value);
  if (col.mode === 'json') return JSON.parse(value);
  if (col.mode === 'timestamp') return new Date(value * 1000);
  if (col.mode === 'timestamp_ms') return new Date(value);
  return value;
}

// sql object → { query, params } with positional ?s.
function compile(s) {
  let query = '';
  const params = [];
  s.strings.forEach((str, i) => {
    query += str;
    if (i >= s.values.length) return;
    const v = s.values[i];
    if (v instanceof Column) query += v.name;
    else if (isTable(v)) query += tableName(v);
    else if (v?.isSql) {
      const c = compile(v);
      query += c.query;
      params.push(...c.params);
    } else {
      query += '?';
      params.push(toDb(v));
    }
  });
  return { query, params };
}

// ---------- operators ----------

export const eq = (a, b) => sql`${a} = ${b}`;
export const ne = (a, b) => sql`${a} <> ${b}`;
export const gt = (a, b) => sql`${a} > ${b}`;
export const gte = (a, b) => sql`${a} >= ${b}`;
export const lt = (a, b) => sql`${a} < ${b}`;
export const lte = (a, b) => sql`${a} <= ${b}`;
export const like = (a, b) => sql`${a} LIKE ${b}`;
export const notLike = (a, b) => sql`${a} NOT LIKE ${b}`;
export const isNull = (a) => sql`${a} IS NULL`;
export const isNotNull = (a) => sql`${a} IS NOT NULL`;
export const between = (a, x, y) => sql`${a} BETWEEN ${x} AND ${y}`;
export const notBetween = (a, x, y) => sql`${a} NOT BETWEEN ${x} AND ${y}`;
const list = (values) => (values.length ? values.map((v) => sql`${v}`).reduce((x, y) => sql`${x}, ${y}`) : sql`NULL`);
export const inArray = (a, values) => sql`${a} IN (${list(values)})`;
export const notInArray = (a, values) => sql`${a} NOT IN (${list(values)})`;
export const and = (...conds) => conds.filter(Boolean).reduce((x, y) => sql`(${x}) AND (${y})`);
export const or = (...conds) => conds.filter(Boolean).reduce((x, y) => sql`(${x}) OR (${y})`);
export const not = (cond) => sql`NOT (${cond})`;
export const asc = (c) => sql`${c} ASC`;
export const desc = (c) => sql`${c} DESC`;
export const count = (c) => (c ? sql`count(${c})` : sql`count(*)`);
export const sum = (c) => sql`sum(${c})`;
export const avg = (c) => sql`avg(${c})`;
export const min = (c) => sql`min(${c})`;
export const max = (c) => sql`max(${c})`;

// ---------- DDL (tests create the schema with createTables) ----------

function defaultSql(value) {
  if (value?.isSql) return compile(value).query;
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number') return String(value);
  if (value === null) return 'NULL';
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return `'${s.replace(/'/g, "''")}'`;
}

const SQL_TYPES = { integer: 'INTEGER', boolean: 'INTEGER', text: 'TEXT', json: 'TEXT', real: 'REAL', blob: 'BLOB' };

export function ddl(t) {
  const { name, extras } = t[TABLE];
  const defs = liveColumns(t).map((c) => {
    let d = `${c.name} ${SQL_TYPES[c.type]}`;
    if (c.pk) d += ' PRIMARY KEY' + (c.pk.autoIncrement ? ' AUTOINCREMENT' : '');
    if (c.notNullable) d += ' NOT NULL';
    if (c.isUnique) d += ' UNIQUE';
    if (c.defaultValue !== undefined) d += ` DEFAULT ${defaultSql(c.defaultValue)}`;
    return d;
  });
  const statements = [];
  const indexes = [];
  for (const x of Object.values(extras)) {
    if (x.primaryKey) defs.push(`PRIMARY KEY (${x.primaryKey.map((c) => c.name).join(', ')})`);
    else if (x.check) defs.push(`CHECK (${compile(x.check).query})`);
    else if (x.columns && !x.isDeprecated) {
      const cols = x.columns.map((c) => (c.isSql ? compile(c).query : c.name)).join(', ');
      const where = x.partial ? ` WHERE ${compile(x.partial).query}` : '';
      indexes.push(`CREATE ${x.unique ? 'UNIQUE ' : ''}INDEX ${x.name} ON ${name} (${cols})${where}`);
    }
  }
  statements.push(`CREATE TABLE ${name} (${defs.join(', ')})`, ...indexes);
  return statements;
}

// A fresh, empty database with every table exported by `schema` (the module
// namespace of tgcloud/schema.js). Call it at the start of each test.
export function createTables(schema) {
  sqlite = new DatabaseSync(':memory:');
  for (const t of Object.values(schema)) {
    if (isTable(t)) for (const statement of ddl(t)) sqlite.exec(statement);
  }
}

// Direct access for assertions: rows('SELECT * FROM users WHERE user_id = ?', 1).
export const rows = (query, ...params) => sqlite.prepare(query).all(...params).map((r) => ({ ...r }));
export const row = (query, ...params) => rows(query, ...params)[0] ?? null;
export const exec = (query) => sqlite.exec(query);

// ---------- query builder ----------

function runResult(r, extraRows = []) {
  return { rowsAffected: Number(r.changes ?? 0), lastInsertRowid: Number(r.lastInsertRowid ?? 0), rows: extraRows };
}

function convertRow(t, r) {
  if (!r) return null;
  const out = {};
  for (const c of liveColumns(t)) if (c.name in r) out[c.key] = fromDb(r[c.name], c);
  for (const k of Object.keys(r)) if (!(k in out) && !liveColumns(t).some((c) => c.name === k)) out[k] = r[k];
  return out;
}

class Builder {
  then(resolve, reject) { return this.execute().then(resolve, reject); }
}

class Select extends Builder {
  constructor(projection, t) {
    super();
    Object.assign(this, { projection, t, conds: [], orders: [], groups: [] });
  }
  where(...c) { this.conds.push(...c.filter(Boolean)); return this; }
  orderBy(...o) { this.orders.push(...o.map((x) => (x instanceof Column ? sql`${x}` : x))); return this; }
  groupBy(...g) { this.groups.push(...g); return this; }
  having(h) { this.havingCond = h; return this; }
  limit(n) { this.limitN = n; return this; }
  offset(n) { this.offsetN = n; return this; }
  distinct() { this.isDistinct = true; return this; }
  build() {
    const fields = this.projection
      ? Object.entries(this.projection).map(([alias, v]) => sql`${v} AS ${sql.raw(alias)}`).reduce((a, b) => sql`${a}, ${b}`)
      : sql.raw('*');
    let q = sql`SELECT ${sql.raw(this.isDistinct ? 'DISTINCT ' : '')}${fields} FROM ${sql.raw(tableName(this.t))}`;
    if (this.conds.length) q = sql`${q} WHERE ${and(...this.conds)}`;
    if (this.groups.length) q = sql`${q} GROUP BY ${this.groups.map((g) => sql`${g}`).reduce((a, b) => sql`${a}, ${b}`)}`;
    if (this.havingCond) q = sql`${q} HAVING ${this.havingCond}`;
    if (this.orders.length) q = sql`${q} ORDER BY ${this.orders.reduce((a, b) => sql`${a}, ${b}`)}`;
    if (this.limitN != null) q = sql`${q} LIMIT ${this.limitN}`;
    if (this.offsetN != null) q = sql`${q} OFFSET ${this.offsetN}`;
    return compile(q);
  }
  convert(r) {
    if (!this.projection) return convertRow(this.t, r);
    const out = {};
    for (const [alias, v] of Object.entries(this.projection)) out[alias] = v instanceof Column ? fromDb(r[alias], v) : r[alias];
    return out;
  }
  async all() { const { query, params } = this.build(); return sqlite.prepare(query).all(...params).map((r) => this.convert(r)); }
  async get() { const { query, params } = this.build(); const r = sqlite.prepare(query).get(...params); return r ? this.convert(r) : null; }
  async values() { return (await this.all()).map((r) => Object.values(r)); }
  execute() { return this.all(); }
}

function setClause(t, set) {
  return Object.entries(set)
    .map(([key, value]) => {
      const col = t[key];
      if (!(col instanceof Column)) throw new Error(`No column "${key}" in ${tableName(t)}`);
      return sql`${sql.raw(col.name)} = ${toDb(value, col)}`;
    })
    .reduce((a, b) => sql`${a}, ${b}`);
}

class Mutation extends Builder {
  returning(projection) { this.returningAll = true; this.returningProjection = projection; return this; }
  finish(q) {
    if (!this.returningAll) {
      const { query, params } = compile(q);
      return runResult(sqlite.prepare(query).run(...params));
    }
    const { query, params } = compile(sql`${q} RETURNING *`);
    const out = sqlite.prepare(query).all(...params).map((r) => convertRow(this.t, r));
    if (!this.returningProjection) return out;
    return out.map((r) => Object.fromEntries(Object.entries(this.returningProjection).map(([alias, c]) => [alias, r[c.key]])));
  }
  run() { return this.execute(); }
}

class Insert extends Mutation {
  constructor(t) { super(); this.t = t; }
  values(v) { this.list = Array.isArray(v) ? v : [v]; return this; }
  onConflictDoNothing(opts = {}) { this.conflict = { target: opts.target, nothing: true }; return this; }
  onConflictDoUpdate({ target, set }) { this.conflict = { target, set }; return this; }
  // One statement for rows with the same keys; a key left out (or undefined)
  // takes the column default.
  statement(list) {
    const keys = Object.keys(list[0]).filter((k) => list[0][k] !== undefined);
    const cols = keys.map((k) => {
      if (!(this.t[k] instanceof Column)) throw new Error(`No column "${k}" in ${tableName(this.t)}`);
      return this.t[k];
    });
    const tuples = list
      .map((r) => sql`(${cols.map((c) => sql`${toDb(r[c.key], c)}`).reduce((a, b) => sql`${a}, ${b}`)})`)
      .reduce((a, b) => sql`${a}, ${b}`);
    let q = sql`INSERT INTO ${sql.raw(tableName(this.t))} (${sql.raw(cols.map((c) => c.name).join(', '))}) VALUES ${tuples}`;
    if (this.conflict) {
      const target = this.conflict.target ? `(${[].concat(this.conflict.target).map((c) => c.name).join(', ')})` : '';
      q = this.conflict.nothing
        ? sql`${q} ON CONFLICT ${sql.raw(target)} DO NOTHING`
        : sql`${q} ON CONFLICT ${sql.raw(target)} DO UPDATE SET ${setClause(this.t, this.conflict.set)}`;
    }
    return q;
  }
  async execute() {
    const shape = (r) => Object.keys(r).filter((k) => r[k] !== undefined).join();
    if (this.list.every((r) => shape(r) === shape(this.list[0]))) return this.finish(this.statement(this.list));
    const results = this.list.map((r) => this.finish(this.statement([r])));
    if (this.returningAll) return results.flat();
    return results.reduce((a, b) => ({ rowsAffected: a.rowsAffected + b.rowsAffected, lastInsertRowid: b.lastInsertRowid, rows: [] }));
  }
}

class Update extends Mutation {
  constructor(t) { super(); this.t = t; this.conds = []; }
  set(values) { this.values = values; return this; }
  where(...c) { this.conds.push(...c.filter(Boolean)); return this; }
  async execute() {
    let q = sql`UPDATE ${sql.raw(tableName(this.t))} SET ${setClause(this.t, this.values)}`;
    if (this.conds.length) q = sql`${q} WHERE ${and(...this.conds)}`;
    return this.finish(q);
  }
}

class Delete extends Mutation {
  constructor(t) { super(); this.t = t; this.conds = []; }
  where(...c) { this.conds.push(...c.filter(Boolean)); return this; }
  async execute() {
    let q = sql`DELETE FROM ${sql.raw(tableName(this.t))}`;
    if (this.conds.length) q = sql`${q} WHERE ${and(...this.conds)}`;
    return this.finish(q);
  }
}

function rawArgs(q, params) {
  if (q?.isSql) { const c = compile(q); return [c.query, c.params]; }
  return [q, params ? [params] : []];
}

export const db = {
  select: (projection) => ({ from: (t) => new Select(projection, t) }),
  insert: (t) => new Insert(t),
  update: (t) => new Update(t),
  delete: (t) => new Delete(t),
  async $count(t, where) {
    const q = where ? sql`SELECT count(*) AS n FROM ${sql.raw(tableName(t))} WHERE ${where}` : sql`SELECT count(*) AS n FROM ${sql.raw(tableName(t))}`;
    const { query, params } = compile(q);
    return Number(sqlite.prepare(query).get(...params).n);
  },
  async run(q, params) {
    const [query, args] = rawArgs(q, params);
    if (/\breturning\b/i.test(query)) {
      const stmt = sqlite.prepare(query);
      const out = stmt.all(...args).map((r) => ({ ...r }));
      return { rowsAffected: out.length, lastInsertRowid: 0, rows: out };
    }
    return runResult(sqlite.prepare(query).run(...args));
  },
  async all(q, params) { const [query, args] = rawArgs(q, params); return sqlite.prepare(query).all(...args).map((r) => ({ ...r })); },
  async get(q, params) { const [query, args] = rawArgs(q, params); const r = sqlite.prepare(query).get(...args); return r ? { ...r } : null; },
  async values(q, params) { const [query, args] = rawArgs(q, params); return sqlite.prepare(query).all(...args).map((r) => Object.values(r)); },
};

export default db;
