// Title, artist and cover written into the audio file itself, so a music
// player shows them once the file is saved (Telegram shows its own fields,
// the ones sendAudio sets). Plain JavaScript: no npm packages at runtime.
//
//   tagAudio(bytes, ext, { title, artist, cover }) → the file with the tags,
//   or null when its layout is not one this module can rewrite safely.
//
// - mp3: one ID3v2.3 tag (TIT2, TPE1, APIC) replaces any ID3v2 tag at the
//   start and an ID3v1 tag at the end.
// - m4a: an iTunes-style moov/udta/meta/ilst (©nam, ©ART, covr) replaces any
//   moov/udta. Only fragmented MP4 is rewritten — what SoundCloud's AAC HLS
//   joins into: growing moov moves every byte after it, and a file whose
//   boxes point at absolute positions (stco/co64 entries, a tfhd
//   base-data-offset) would no longer play.

import { utf8Encode } from './files.js';

function concat(parts) {
  const arrays = parts.map((p) => (p instanceof Uint8Array ? p : new Uint8Array(p)));
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}

const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const readU32 = (b, i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
// Latin-1 / box types ("©nam" is A9 6E 61 6D).
const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0) & 255);
const typeAt = (b, i) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);

const isPng = (img) => img[0] === 0x89 && img[1] === 0x50 && img[2] === 0x4e && img[3] === 0x47;

// ---------- mp3: ID3v2.3 ----------

const synchsafe = (n) => [(n >>> 21) & 127, (n >>> 14) & 127, (n >>> 7) & 127, n & 127];
const readSynchsafe = (b, i) => (b[i] << 21) | (b[i + 1] << 14) | (b[i + 2] << 7) | b[i + 3];

// UTF-16 with a byte order mark: ID3v2.3's only Unicode text encoding (1).
function utf16(text) {
  const out = [0xff, 0xfe];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    out.push(c & 255, c >>> 8);
  }
  return out;
}

function frame(id, parts) {
  const body = concat(parts);
  return concat([ascii(id), u32(body.length), [0, 0], body]);
}

function id3(meta) {
  const frames = [];
  if (meta.title) frames.push(frame('TIT2', [[1], utf16(meta.title)]));
  if (meta.artist) frames.push(frame('TPE1', [[1], utf16(meta.artist)]));
  // APIC: text encoding, MIME type, 0, picture type 3 (front cover), empty description, 0, the image.
  if (meta.cover) frames.push(frame('APIC', [[0], ascii(isPng(meta.cover) ? 'image/png' : 'image/jpeg'), [0, 3, 0], meta.cover]));
  const body = concat(frames);
  return concat([ascii('ID3'), [3, 0, 0], synchsafe(body.length), body]);
}

export function tagMp3(bytes, meta) {
  let start = 0;
  while (start + 10 <= bytes.length && bytes[start] === 0x49 && bytes[start + 1] === 0x44 && bytes[start + 2] === 0x33) {
    const footer = bytes[start + 5] & 0x10 ? 10 : 0;   // ID3v2.4 footer
    start += 10 + readSynchsafe(bytes, start + 6) + footer;
  }
  let end = bytes.length;
  if (end - start >= 128 && bytes[end - 128] === 0x54 && bytes[end - 127] === 0x41 && bytes[end - 126] === 0x47) end -= 128;
  if (start >= end) return null;
  return concat([id3(meta), bytes.subarray(start, end)]);
}

// ---------- m4a: MP4 boxes ----------

// The boxes between `start` and `end` → [{ type, start, size, header }], or
// null when they don't tile that range exactly (not a file to rewrite).
function boxes(b, start, end) {
  const list = [];
  let i = start;
  while (i + 8 <= end) {
    let size = readU32(b, i);
    let header = 8;
    if (size === 1) {
      if (i + 16 > end) return null;
      size = readU32(b, i + 8) * 2 ** 32 + readU32(b, i + 12);
      header = 16;
    } else if (size === 0) {
      size = end - i;
    }
    if (size < header || i + size > end) return null;
    list.push({ type: typeAt(b, i + 4), start: i, size, header });
    i += size;
  }
  return i === end ? list : null;
}

const children = (b, box, skip = 0) => boxes(b, box.start + box.header + skip, box.start + box.size);
const find = (list, type) => list?.filter((x) => x.type === type) ?? [];

// stco / co64 with entries: chunk offsets counted from the start of the file.
function hasChunkOffsets(b, moov) {
  for (const trak of find(children(b, moov), 'trak')) {
    for (const mdia of find(children(b, trak), 'mdia')) {
      for (const minf of find(children(b, mdia), 'minf')) {
        for (const stbl of find(children(b, minf), 'stbl')) {
          for (const t of find(children(b, stbl), 'stco').concat(find(children(b, stbl), 'co64'))) {
            if (readU32(b, t.start + t.header + 4) > 0) return true;
          }
        }
      }
    }
  }
  return false;
}

// tfhd with base-data-offset-present (flag 0x000001): an absolute position.
function hasBaseDataOffset(b, moof) {
  for (const traf of find(children(b, moof), 'traf')) {
    for (const tfhd of find(children(b, traf), 'tfhd')) {
      if (b[tfhd.start + tfhd.header + 3] & 0x01) return true;
    }
  }
  return false;
}

function box(type, parts) {
  const body = concat(parts);
  return concat([u32(body.length + 8), ascii(type), body]);
}

// iTunes "data": type 1 = UTF-8 text, 13 = JPEG, 14 = PNG; locale 0.
const data = (kind, payload) => box('data', [u32(kind), u32(0), payload]);

function udta(meta) {
  const items = [];
  if (meta.title) items.push(box('©nam', [data(1, utf8Encode(meta.title))]));
  if (meta.artist) items.push(box('©ART', [data(1, utf8Encode(meta.artist))]));
  if (meta.cover) items.push(box('covr', [data(isPng(meta.cover) ? 14 : 13, meta.cover)]));
  // hdlr: version/flags, pre_defined, handler "mdir", reserved ("appl", 0, 0), empty name.
  const hdlr = box('hdlr', [u32(0), u32(0), ascii('mdir'), ascii('appl'), u32(0), u32(0), [0]]);
  return box('udta', [box('meta', [u32(0), hdlr, box('ilst', items)])]);
}

export function tagM4a(bytes, meta) {
  const top = boxes(bytes, 0, bytes.length);
  if (!top || top[0]?.type !== 'ftyp') return null;
  const moov = top.find((x) => x.type === 'moov');
  if (!moov || moov.header !== 8 || !top.some((x) => x.type === 'moof')) return null;
  if (hasChunkOffsets(bytes, moov)) return null;
  if (top.some((x) => x.type === 'moof' && hasBaseDataOffset(bytes, x))) return null;
  const inside = children(bytes, moov);
  if (!inside) return null;
  const kept = inside.filter((x) => x.type !== 'udta').map((x) => bytes.subarray(x.start, x.start + x.size));
  const newMoov = box('moov', [...kept, udta(meta)]);
  // mfra (the optional random-access index at the end) holds absolute moof
  // positions that just moved: drop it.
  return concat(top.filter((x) => x.type !== 'mfra').map((x) => (x === moov ? newMoov : bytes.subarray(x.start, x.start + x.size))));
}

export function tagAudio(bytes, ext, meta) {
  try {
    if (ext === 'mp3') return tagMp3(bytes, meta);
    if (ext === 'm4a') return tagM4a(bytes, meta);
  } catch (e) {
    console.error(e);
  }
  return null;
}
