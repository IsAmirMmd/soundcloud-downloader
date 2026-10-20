// File formats for reports and backups: UTF-8, CSV, and a minimal .xlsx writer.
// Plain JavaScript only: the runtime has no npm packages, and TextEncoder/
// TextDecoder are not guaranteed to exist.

// ---------- UTF-8 ----------

export function utf8Encode(str) {
  const out = [];
  for (const ch of String(str)) {
    let cp = ch.codePointAt(0);
    if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd; // lone surrogate
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  }
  return new Uint8Array(out);
}

export function utf8Decode(bytes) {
  if (typeof bytes === 'string') return bytes;
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes); // ArrayBuffer, number[]
  let str = '';
  const cps = [];
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i];
    let n = 1;
    let cp = b;
    if (b >= 0xf0) { n = 4; cp = b & 7; }
    else if (b >= 0xe0) { n = 3; cp = b & 15; }
    else if (b >= 0xc0) { n = 2; cp = b & 31; }
    else if (b >= 0x80) cp = 0xfffd; // stray continuation byte
    for (let k = 1; k < n; k++) cp = (cp << 6) | (bytes[i + k] & 63);
    if (cp > 0x10ffff) cp = 0xfffd;
    cps.push(cp);
    i += n;
    if (cps.length >= 4096) {
      str += String.fromCodePoint(...cps);
      cps.length = 0;
    }
  }
  return str + String.fromCodePoint(...cps);
}

// ---------- tables ----------

// Column names in order of first appearance across all rows.
function columnsOf(rows) {
  const cols = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) if (!cols.includes(key)) cols.push(key);
  }
  return cols;
}

// ---------- CSV ----------

function csvField(value) {
  if (value == null) return '';
  const s = value instanceof Date ? value.toISOString() : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows) {
  const cols = columnsOf(rows);
  return [cols, ...rows.map((row) => cols.map((c) => row[c]))]
    .map((values) => values.map(csvField).join(','))
    .join('\n');
}

// RFC 4180 CSV → array of objects keyed by the header row.
export function parseCsv(text) {
  const records = [];
  let record = [];
  let field = '';
  let quoted = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { record.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      record.push(field);
      records.push(record);
      record = [];
      field = '';
    } else field += ch;
  }
  if (field || record.length) { record.push(field); records.push(record); }

  const [header = [], ...data] = records.filter((r) => r.some((f) => f !== ''));
  return data.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), r[i] ?? ''])));
}

// ---------- ZIP (stored, no compression) ----------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function concat(chunks) {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

// files: [{ name, data: Uint8Array }] → zip archive bytes.
function zip(files) {
  const DOS_DATE = 0x21; // 1980-01-01
  const body = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBytes = utf8Encode(name);
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameBytes.length);
    const l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true);
    l.setUint16(4, 20, true);       // version needed
    l.setUint16(6, 0x0800, true);   // flags: UTF-8 names
    l.setUint16(12, DOS_DATE, true);
    l.setUint32(14, crc, true);
    l.setUint32(18, data.length, true);
    l.setUint32(22, data.length, true);
    l.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);

    const entry = new Uint8Array(46 + nameBytes.length);
    const e = new DataView(entry.buffer);
    e.setUint32(0, 0x02014b50, true);
    e.setUint16(4, 20, true);       // version made by
    e.setUint16(6, 20, true);       // version needed
    e.setUint16(8, 0x0800, true);
    e.setUint16(14, DOS_DATE, true);
    e.setUint32(16, crc, true);
    e.setUint32(20, data.length, true);
    e.setUint32(24, data.length, true);
    e.setUint16(28, nameBytes.length, true);
    e.setUint32(42, offset, true);
    entry.set(nameBytes, 46);

    body.push(local, data);
    central.push(entry);
    offset += local.length + data.length;
  }
  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const v = new DataView(end.buffer);
  v.setUint32(0, 0x06054b50, true);
  v.setUint16(8, files.length, true);
  v.setUint16(10, files.length, true);
  v.setUint32(12, centralSize, true);
  v.setUint32(16, offset, true);
  return concat([...body, ...central, end]);
}

// ---------- XLSX ----------

function xmlEscape(value) {
  return String(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function columnLetter(index) {
  let s = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  }
  return s;
}

function xlsxCell(ref, value) {
  if (value == null || value === '') return '';
  if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"><v>${value}</v></c>`;
  if (typeof value === 'boolean') return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
  const text = value instanceof Date ? value.toISOString() : value;
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(text)}</t></is></c>`;
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

// rows (array of objects) → .xlsx bytes: one sheet, header row first.
export function toXlsx(rows, sheetName = 'Sheet1') {
  const cols = columnsOf(rows);
  const table = [cols, ...rows.map((row) => cols.map((c) => row[c]))];
  const sheetRows = table
    .map((values, r) =>
      `<row r="${r + 1}">${values.map((v, c) => xlsxCell(`${columnLetter(c)}${r + 1}`, v)).join('')}</row>`)
    .join('');
  const name = xmlEscape(String(sheetName).replace(/[[\]:*?/\\]/g, ' ').slice(0, 31));

  const parts = {
    '[Content_Types].xml': XML_HEAD +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '</Types>',
    '_rels/.rels': XML_HEAD +
      `<Relationships xmlns="${NS_PKG_REL}">` +
      `<Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/>` +
      '</Relationships>',
    'xl/workbook.xml': XML_HEAD +
      `<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
      `<sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets>` +
      '</workbook>',
    'xl/_rels/workbook.xml.rels': XML_HEAD +
      `<Relationships xmlns="${NS_PKG_REL}">` +
      `<Relationship Id="rId1" Type="${NS_REL}/worksheet" Target="worksheets/sheet1.xml"/>` +
      `<Relationship Id="rId2" Type="${NS_REL}/styles" Target="styles.xml"/>` +
      '</Relationships>',
    'xl/styles.xml': XML_HEAD +
      `<styleSheet xmlns="${NS_MAIN}">` +
      '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
      '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      '</styleSheet>',
    'xl/worksheets/sheet1.xml': XML_HEAD +
      `<worksheet xmlns="${NS_MAIN}"><sheetData>${sheetRows}</sheetData></worksheet>`,
  };
  return zip(Object.entries(parts).map(([partName, xml]) => ({ name: partName, data: utf8Encode(xml) })));
}
