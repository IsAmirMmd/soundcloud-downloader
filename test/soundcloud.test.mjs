// lib/soundcloud.js against a fake SoundCloud (helpers.mjs soundcloud()):
// links, the client_id, resolving, picking a stream, downloading it.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fresh, soundcloud, scTrack, asText, row, exec, CLIENT_ID } from './helpers.mjs';
import {
  findSoundcloudUrl, clientIdIn, clientId, getTrack, pickTranscoding, parseM3u8, downloadAudio, artwork, SoundcloudError,
} from '../tgcloud/lib/soundcloud.js';

beforeEach(fresh);

const LINK = 'https://soundcloud.com/artist/track-1';
const isCode = (code) => (e) => e instanceof SoundcloudError && e.code === code;

test('findSoundcloudUrl: track links in any shape, normalized; anything else is null', () => {
  const cases = {
    'https://soundcloud.com/forss/flickermood': 'https://soundcloud.com/forss/flickermood',
    'listen https://m.soundcloud.com/forss/flickermood?si=abc&utm_source=clipboard 🔥': 'https://soundcloud.com/forss/flickermood',
    'soundcloud.com/forss/flickermood/s-AbC12': 'https://soundcloud.com/forss/flickermood/s-AbC12',
    'HTTPS://WWW.SoundCloud.com/forss/flickermood/': 'https://soundcloud.com/forss/flickermood',
    '(https://soundcloud.com/forss/flickermood).': 'https://soundcloud.com/forss/flickermood',
    'https://soundcloud.com/forss/sets/album': 'https://soundcloud.com/forss/sets/album',
  };
  for (const [text, url] of Object.entries(cases)) assert.deepEqual(findSoundcloudUrl(text), { url, short: false }, text);

  assert.deepEqual(findSoundcloudUrl('https://on.soundcloud.com/AbCd123'), { url: 'https://on.soundcloud.com/AbCd123', short: true });
  assert.deepEqual(findSoundcloudUrl('https://soundcloud.app.goo.gl/xyz'), { url: 'https://soundcloud.app.goo.gl/xyz', short: true });
  for (const text of ['https://soundcloud.com/', 'soundcloud.com', 'https://example.com/forss/flickermood', 'https://notsoundcloud.com/a/b', 'hello', '', undefined]) {
    assert.equal(findSoundcloudUrl(text), null, String(text));
  }
});

test('clientIdIn: the page hydration, a bundle, or a ?client_id= in a script', () => {
  const id = 'Ab3'.repeat(10) + 'xy';
  assert.equal(clientIdIn(`[{"hydratable":"apiClient","data":{"id":"${id}","isExpiring":false}}]`), id);
  assert.equal(clientIdIn(`e.exports={client_id:"${id}"}`), id);
  assert.equal(clientIdIn(`fetch("https://api-v2.soundcloud.com/x?client_id=${id}&app_version=1")`), id);
  assert.equal(clientIdIn('client_id:"tooshort"'), null);
});

test('clientId: scraped once from the page, then kept in settings', async () => {
  const asked = soundcloud();
  assert.equal(await clientId(), CLIENT_ID);
  assert.equal(await clientId(), CLIENT_ID);
  assert.deepEqual(asked, ['https://soundcloud.com/']);
  assert.equal(row("SELECT value FROM settings WHERE key = 'sc:client_id'").value, CLIENT_ID);
});

test('clientId: from the scripts, last first, when the page has none', async () => {
  const asked = soundcloud({ pageId: false });
  assert.equal(await clientId(), CLIENT_ID);
  assert.deepEqual(asked, ['https://soundcloud.com/', 'https://a-v2.sndcdn.com/assets/49-app.js']);
});

test('clientId: NO_CLIENT_ID when neither has one; UNREACHABLE when the site is down', async () => {
  soundcloud({ pageId: false, clientId: 'short' });
  await assert.rejects(clientId(), isCode('NO_CLIENT_ID'));
  soundcloud({ down: ['soundcloud.com/'] });
  await assert.rejects(clientId(), isCode('UNREACHABLE'));
});

test('a refused client_id is scraped again once, and the new one kept', async () => {
  exec(`INSERT INTO settings (key, value) VALUES ('sc:client_id', '${'z'.repeat(32)}')`);
  const asked = soundcloud({ tracks: { [LINK]: scTrack(1) } });
  const track = await getTrack(LINK);
  assert.equal(track.id, 1);
  assert.equal(asked.filter((u) => u.startsWith('https://api-v2.soundcloud.com/resolve')).length, 2);
  assert.equal(row("SELECT value FROM settings WHERE key = 'sc:client_id'").value, CLIENT_ID);
});

test('getTrack: the fields the bot uses; share links followed; NOT_FOUND and NOT_TRACK', async () => {
  soundcloud({
    tracks: {
      [LINK]: scTrack(1, { publisher_metadata: { artist: 'Real Artist' } }),
      'https://soundcloud.com/artist/sets/album': { kind: 'playlist', id: 9 },
    },
    short: { 'https://on.soundcloud.com/AbC': `${LINK}?si=123&utm_medium=text` },
  });
  const track = await getTrack(LINK);
  assert.deepEqual(
    { id: track.id, title: track.title, artist: track.artist, duration: track.duration, policy: track.policy },
    { id: 1, title: 'Track 1', artist: 'Real Artist', duration: 180, policy: 'ALLOW' });
  assert.equal((await getTrack(findSoundcloudUrl('https://on.soundcloud.com/AbC'))).id, 1);
  await assert.rejects(getTrack('https://soundcloud.com/artist/gone'), isCode('NOT_FOUND'));
  await assert.rejects(getTrack('https://soundcloud.com/artist/sets/album'), (e) => isCode('NOT_TRACK')(e) && e.detail === 'playlist');
});

test('pickTranscoding: one MP3 file, then MP3 segments, then AAC; never DRM, opus or previews', () => {
  const pick = (streams, opts) => {
    const p = pickTranscoding(scTrack(1, { streams, ...opts }).media.transcodings);
    return p && `${p.format.protocol} ${p.format.ext}`;
  };
  assert.equal(pick(['hls-aac', 'hls-mp3', 'progressive']), 'progressive mp3');
  assert.equal(pick(['hls-aac', 'hls-mp3']), 'hls mp3');
  assert.equal(pick(['encrypted', 'hls-aac']), 'hls m4a');
  assert.equal(pick(['encrypted', 'hls-opus']), null);
  assert.equal(pick(['progressive'], { snipped: true }), null);
});

test('parseM3u8: absolute, root and relative segments, the init map; encrypted refused', () => {
  const base = 'https://cf-hls-media.sndcdn.com/playlist/t1/aac/playlist.m3u8?Policy=p';
  const list = '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:10,\nhttps://x.sndcdn.com/a.m4s\n#EXTINF:10,\n/media/b.m4s\n#EXTINF:5,\nc.m4s\n#EXT-X-ENDLIST\n';
  assert.deepEqual(parseM3u8(list, base), {
    map: 'https://cf-hls-media.sndcdn.com/playlist/t1/aac/init.mp4',
    segments: [
      'https://x.sndcdn.com/a.m4s',
      'https://cf-hls-media.sndcdn.com/media/b.m4s',
      'https://cf-hls-media.sndcdn.com/playlist/t1/aac/c.m4s',
    ],
  });
  assert.deepEqual(parseM3u8('#EXT-X-KEY:METHOD=NONE\nx.mp3', base).segments.length, 1);
  assert.throws(() => parseM3u8('#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://k"\nx.m4s', base), isCode('NO_STREAM'));
});

test('downloadAudio: a progressive MP3 is one file', async () => {
  soundcloud({ tracks: { [LINK]: scTrack(1) } });
  const file = await downloadAudio(await getTrack(LINK));
  assert.equal(asText(file.bytes), '<t1.mp3>');
  assert.deepEqual([file.ext, file.type, file.format], ['mp3', 'audio/mpeg', 'progressive audio/mpeg']);
});

test('downloadAudio: HLS segments are joined in order, after the init segment for AAC', async () => {
  soundcloud({ tracks: { [LINK]: scTrack(1, { streams: ['hls-mp3'] }), 'https://soundcloud.com/artist/track-2': scTrack(2, { streams: ['encrypted', 'hls-aac'] }) } });
  const mp3 = await downloadAudio(await getTrack(LINK));
  assert.equal(asText(mp3.bytes), '<0/10/t1.mp3><10/20/t1.mp3><t1/hls-mp3/seg3.mp3>');
  const aac = await downloadAudio(await getTrack('https://soundcloud.com/artist/track-2'));
  assert.equal(asText(aac.bytes), '<t2/hls-aac/init.mp4><0/10/t2.m4s><10/20/t2.m4s><t2/hls-aac/seg3.m4s>');
  assert.deepEqual([aac.ext, aac.type], ['m4a', 'audio/mp4']);
});

test('downloadAudio: why not — blocked, preview only, DRM only, too long, too big', async () => {
  const tracks = {
    'https://soundcloud.com/a/blocked': scTrack(1, { policy: 'BLOCK' }),
    'https://soundcloud.com/a/goplus': scTrack(2, { policy: 'SNIP', snipped: true }),
    'https://soundcloud.com/a/drm': scTrack(3, { streams: ['encrypted', 'hls-opus'] }),
    'https://soundcloud.com/a/long': scTrack(4, { seconds: 3 * 3600 }),
    'https://soundcloud.com/a/ok': scTrack(5),
  };
  const asked = soundcloud({ tracks });
  const fails = async (url, code, opts) => assert.rejects(downloadAudio(await getTrack(url), opts), isCode(code), url);
  await fails('https://soundcloud.com/a/blocked', 'BLOCKED');
  await fails('https://soundcloud.com/a/goplus', 'PREVIEW_ONLY');
  await fails('https://soundcloud.com/a/drm', 'NO_STREAM');
  await fails('https://soundcloud.com/a/long', 'TOO_LONG');
  assert.ok(!asked.some((u) => u.includes('/stream/')), 'nothing was streamed for a refused track');
  await fails('https://soundcloud.com/a/ok', 'TOO_BIG', { limit: 4 });
});

test('artwork: the 300×300 JPEG, or null when there is none', async () => {
  soundcloud({ tracks: { [LINK]: scTrack(1) }, down: ['artworks-404'] });
  const track = await getTrack(LINK);
  assert.equal(asText(await artwork(track)), '<artworks-1-t300x300.jpg>');
  assert.equal(await artwork({ ...track, artworkUrl: null }), null);
  assert.equal(await artwork({ ...track, artworkUrl: 'https://i1.sndcdn.com/artworks-404-large.jpg' }), null);
});
