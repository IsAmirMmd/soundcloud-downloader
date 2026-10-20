// lib/tags.js: title, artist and cover written into the file, read back here
// with small parsers of the same formats. Checked against ffmpeg and mutagen
// too when the module was written (real MP3, and AAC HLS joined like the bot
// joins it: same decoded audio, new tags read back).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tagAudio, tagMp3, tagM4a } from '../tgcloud/lib/tags.js';

const bytes = (s) => new Uint8Array(Buffer.from(s, 'latin1'));
const cat = (...parts) => new Uint8Array(Buffer.concat(parts.map((p) => Buffer.from(p))));
const COVER = cat([0xff, 0xd8, 0xff, 0xe0], bytes('jpeg-bytes'));
const META = { title: 'شب‌های تهران', artist: 'Artist ✓', cover: COVER };

// ---------- ID3v2.3 ----------

function readId3(b) {
  const buf = Buffer.from(b);
  assert.equal(buf.toString('latin1', 0, 3), 'ID3');
  assert.equal(buf[3], 3);
  const size = (buf[6] << 21) | (buf[7] << 14) | (buf[8] << 7) | buf[9];
  const frames = {};
  for (let i = 10; i < 10 + size;) {
    const id = buf.toString('latin1', i, i + 4);
    const len = buf.readUInt32BE(i + 4);
    frames[id] = buf.subarray(i + 10, i + 10 + len);
    i += 10 + len;
  }
  return { frames, rest: buf.subarray(10 + size) };
}
const text16 = (f) => {
  assert.equal(f[0], 1);
  assert.deepEqual([...f.subarray(1, 3)], [0xff, 0xfe]);
  return f.subarray(3).toString('utf16le');
};

test('mp3: one ID3v2.3 tag with title, artist and cover; old ID3v2 and ID3v1 tags gone', () => {
  const old = cat(bytes('ID3'), [3, 0, 0, 0, 0, 0, 12], bytes('TIT2'), [0, 0, 0, 2, 0, 0, 0], bytes('x'));
  const audio = bytes('\xff\xfbMP3-FRAMES');
  const v1 = cat(bytes('TAG'), Buffer.alloc(125, 0x41));
  const { frames, rest } = readId3(tagMp3(cat(old, audio, v1), META));
  assert.equal(text16(frames.TIT2), 'شب‌های تهران');
  assert.equal(text16(frames.TPE1), 'Artist ✓');
  const apic = frames.APIC;
  assert.equal(apic.toString('latin1', 1, 11), 'image/jpeg');
  assert.deepEqual([...apic.subarray(11, 14)], [0, 3, 0]);   // end of MIME, front cover, empty description
  assert.deepEqual([...apic.subarray(14)], [...COVER]);
  assert.deepEqual([...rest], [...audio]);
});

test('mp3: a field left out is not written', () => {
  const { frames } = readId3(tagMp3(bytes('\xff\xfbAUDIO'), { title: 'Only title' }));
  assert.deepEqual(Object.keys(frames), ['TIT2']);
});

// ---------- MP4 ----------

const box = (type, ...parts) => {
  const body = Buffer.concat(parts.map((p) => Buffer.from(p)));
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length + 8);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
};
const full = (type, flags, ...parts) => box(type, [0, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255], ...parts);
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };

// A fragmented MP4 like an HLS init segment + one media segment.
function fmp4({ chunkOffsets = 0, tfhdFlags = 0x020000, oldUdta = true, mfra = true } = {}) {
  const stbl = box('stbl', full('stco', 0, u32(chunkOffsets), ...Array.from({ length: chunkOffsets }, () => u32(1234))));
  const moov = box('moov', full('mvhd', 0, Buffer.alloc(96)),
    box('trak', box('mdia', box('minf', stbl))),
    ...(oldUdta ? [box('udta', box('XTRA', 'old'))] : []));
  const moof = box('moof', full('mfhd', 0, u32(1)), box('traf', full('tfhd', tfhdFlags, u32(1))));
  return new Uint8Array(Buffer.concat([box('ftyp', 'iso6mp41'), moov, moof, box('mdat', 'SOUND'), ...(mfra ? [box('mfra', 'index')] : [])]));
}

function readBoxes(b, start = 0, end = b.length) {
  const out = [];
  for (let i = start; i < end;) {
    const size = b.readUInt32BE(i);
    out.push({ type: b.toString('latin1', i + 4, i + 8), body: b.subarray(i + 8, i + size), raw: b.subarray(i, i + size) });
    i += size;
  }
  return out;
}
const child = (boxes, type) => boxes.find((x) => x.type === type);

test('m4a: moov/udta/meta/ilst with ©nam, ©ART and covr; the old udta and mfra go, the rest is untouched', () => {
  const input = Buffer.from(fmp4());
  const out = Buffer.from(tagM4a(new Uint8Array(input), META));
  const top = readBoxes(out);
  assert.deepEqual(top.map((x) => x.type), ['ftyp', 'moov', 'moof', 'mdat']);
  const inTop = readBoxes(input);
  for (const type of ['ftyp', 'moof', 'mdat']) assert.ok(child(top, type).raw.equals(child(inTop, type).raw), type);

  const moov = readBoxes(child(top, 'moov').body);
  assert.deepEqual(moov.map((x) => x.type), ['mvhd', 'trak', 'udta']);
  const meta = readBoxes(child(moov, 'udta').body);
  assert.equal(meta[0].type, 'meta');
  const inMeta = readBoxes(meta[0].body.subarray(4));                 // after version/flags
  assert.equal(child(inMeta, 'hdlr').body.toString('latin1', 8, 12), 'mdir');
  const items = readBoxes(child(inMeta, 'ilst').body);
  const value = (type) => {
    const data = readBoxes(child(items, type).body)[0];
    assert.equal(data.type, 'data');
    return { kind: data.body.readUInt32BE(0), payload: data.body.subarray(8) };
  };
  assert.deepEqual(items.map((x) => x.type), ['©nam', '©ART', 'covr']);
  assert.equal(value('©nam').payload.toString('utf8'), 'شب‌های تهران');
  assert.equal(value('©ART').payload.toString('utf8'), 'Artist ✓');
  assert.equal(value('covr').kind, 13);
  assert.deepEqual([...value('covr').payload], [...COVER]);

  // Tagging again replaces the tags instead of adding more.
  const again = readBoxes(Buffer.from(tagM4a(new Uint8Array(out), { title: 'Two' })));
  const udtas = readBoxes(child(again, 'moov').body).filter((x) => x.type === 'udta');
  assert.equal(udtas.length, 1);
});

test('m4a: refused when bytes after moov are addressed absolutely, or it is no fragmented MP4', () => {
  assert.equal(tagM4a(fmp4({ chunkOffsets: 1 }), META), null);         // stco entries
  assert.equal(tagM4a(fmp4({ tfhdFlags: 0x000001 }), META), null);     // tfhd base-data-offset
  const plain = Buffer.concat([box('ftyp', 'M4A '), box('moov', full('mvhd', 0, Buffer.alloc(96))), box('mdat', 'x')]);
  assert.equal(tagM4a(new Uint8Array(plain), META), null);            // not fragmented
  assert.equal(tagM4a(bytes('not an mp4 file at all'), META), null);
  assert.ok(tagM4a(fmp4({ oldUdta: false, mfra: false }), META));
});

test('tagAudio: by extension; anything else, or a broken file, is null', () => {
  assert.ok(tagAudio(bytes('\xff\xfbAUDIO'), 'mp3', META));
  assert.ok(tagAudio(fmp4(), 'm4a', META));
  assert.equal(tagAudio(bytes('x'), 'ogg', META), null);
  assert.equal(tagAudio(bytes('<fake>'), 'm4a', META), null);
});
