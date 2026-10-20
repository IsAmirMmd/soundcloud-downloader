// lib/soundcloud.js against a fake SoundCloud (helpers.mjs soundcloud()):
// links, the client_id, resolving, picking a stream, downloading it.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fresh, soundcloud, scTrack, asText, row, exec, mockFetch, CLIENT_ID } from './helpers.mjs';
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

test('pickTranscoding: MP3 where it is left, else AAC at its best bitrate; never abr, DRM, opus or previews', () => {
  const pick = (streams, opts) => {
    const p = pickTranscoding(scTrack(1, { streams, ...opts }).media.transcodings);
    return p && `${p.transcoding.preset} ${p.format.protocol} ${p.format.ext}`;
  };
  assert.equal(pick(['aac_160k', 'hls-mp3', 'progressive']), 'mp3_0_0 progressive mp3');
  assert.equal(pick(['aac_160k', 'hls-mp3']), 'mp3_1_0 hls mp3');
  // Today's usual track: the 160k AAC, whatever the order, never abr_sq.
  assert.equal(pick(['abr_sq', 'aac_96k', 'aac_160k']), 'aac_160k hls m4a');
  assert.equal(pick(['abr_sq', 'aac_96k']), 'aac_96k hls m4a');
  assert.equal(pick(['abr_sq']), null);
  assert.equal(pick(['drm', 'opus']), null);
  assert.equal(pick(['aac_160k'], { snipped: true }), null);
  const preview = scTrack(1).media.transcodings.map((t) => ({ ...t, url: t.url.replace('/stream/', '/preview/') }));
  assert.equal(pickTranscoding(preview), null);
});

test('parseM3u8: absolute, root and relative segments, the init map; masters; encrypted refused', () => {
  const base = 'https://playback.media-streaming.soundcloud.cloud/t1/aac/playlist.m3u8?expires=1';
  const list = '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:10,\nhttps://x.sndcdn.com/a.m4s\n#EXTINF:10,\n/media/b.m4s\n#EXTINF:5,\nc.m4s\n#EXT-X-ENDLIST\n';
  assert.deepEqual(parseM3u8(list, base), {
    map: 'https://playback.media-streaming.soundcloud.cloud/t1/aac/init.mp4',
    segments: [
      'https://x.sndcdn.com/a.m4s',
      'https://playback.media-streaming.soundcloud.cloud/media/b.m4s',
      'https://playback.media-streaming.soundcloud.cloud/t1/aac/c.m4s',
    ],
    variants: [],
  });
  const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=96000\nlow/p.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=160000,CODECS="mp4a.40.2"\nhigh/p.m3u8\n';
  assert.deepEqual(parseM3u8(master, base), {
    map: null,
    segments: [],
    variants: [
      { bandwidth: 96000, url: 'https://playback.media-streaming.soundcloud.cloud/t1/aac/low/p.m3u8' },
      { bandwidth: 160000, url: 'https://playback.media-streaming.soundcloud.cloud/t1/aac/high/p.m3u8' },
    ],
  });
  assert.deepEqual(parseM3u8('#EXT-X-KEY:METHOD=NONE\nx.mp3', base).segments.length, 1);
  assert.throws(() => parseM3u8('#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://k"\nx.m4s', base), isCode('NO_STREAM'));
});

test('downloadAudio: a track of today — AAC 160k, init segment then the segments in order, abr_sq never asked', async () => {
  const asked = soundcloud({ tracks: { [LINK]: scTrack(1, { streams: ['abr_sq', 'aac_96k', 'aac_160k'] }) } });
  const file = await downloadAudio(await getTrack(LINK));
  assert.equal(asText(file.bytes), '<t1/aac_160k/init.mp4><0/10/t1.m4s><10/20/t1.m4s><t1/aac_160k/seg3.m4s>');
  assert.deepEqual([file.ext, file.type, file.format], ['m4a', 'audio/mp4', 'hls audio/mp4 (aac_160k)']);
  assert.ok(!asked.some((u) => u.includes('/abr_sq/') || u.includes('/aac_96k/')));
});

test('downloadAudio: MP3 where SoundCloud still has it — one file, or HLS segments joined', async () => {
  soundcloud({ tracks: {
    [LINK]: scTrack(1, { streams: ['aac_160k', 'progressive'] }),
    'https://soundcloud.com/artist/track-2': scTrack(2, { streams: ['aac_160k', 'hls-mp3'] }),
  } });
  const one = await downloadAudio(await getTrack(LINK));
  assert.equal(asText(one.bytes), '<t1.mp3>');
  assert.deepEqual([one.ext, one.type, one.format], ['mp3', 'audio/mpeg', 'progressive audio/mpeg (mp3_0_0)']);
  const joined = await downloadAudio(await getTrack('https://soundcloud.com/artist/track-2'));
  assert.equal(asText(joined.bytes), '<0/10/t2.mp3><10/20/t2.mp3><t2/hls-mp3/seg3.mp3>');
});

test('downloadAudio: a master playlist is followed to its best variant', async () => {
  soundcloud({ tracks: { [LINK]: scTrack(1, { streams: ['aac_master'] }) } });
  const file = await downloadAudio(await getTrack(LINK));
  assert.equal(asText(file.bytes), '<aac_master/v2/init.mp4><0/10/t1.m4s><10/20/t1.m4s><aac_master/v2/seg3.m4s>');
});

test('downloadAudio: many segments come back in order, fetched a few at a time', async () => {
  const urls = Array.from({ length: 11 }, (_, i) => `https://playback.media-streaming.soundcloud.cloud/t1/x/s${i}.m4s`);
  const playlist = urls.map((u) => `#EXTINF:10,\n${u}`).join('\n');
  let open = 0;
  let most = 0;
  mockFetch(async (url) => {
    if (url.startsWith('https://soundcloud.com/')) return { ok: true, status: 200, text: async () => `{"hydratable":"apiClient","data":{"id":"${CLIENT_ID}"}}` };
    if (url.startsWith('https://api-v2.soundcloud.com/media/')) return { ok: true, status: 200, text: async () => JSON.stringify({ url: 'https://playback.media-streaming.soundcloud.cloud/t1/x/playlist.m3u8' }) };
    if (url.endsWith('playlist.m3u8')) return { ok: true, status: 200, text: async () => playlist };
    open++;
    most = Math.max(most, open);
    // Later segments answer sooner: the order must still be the playlist's.
    await new Promise((r) => setTimeout(r, 12 - Number(/s(\d+)/.exec(url)[1])));
    open--;
    const bytes = new Uint8Array(Buffer.from(`<${/s\d+/.exec(url)[0]}>`));
    return { ok: true, status: 200, headers: { get: () => null }, body: (async function* () { yield bytes; })() };
  });
  const track = { id: 1, duration: 100, policy: 'ALLOW', trackAuthorization: 'a', transcodings: scTrack(1, { streams: ['aac_160k'] }).media.transcodings };
  const file = await downloadAudio(track);
  assert.equal(asText(file.bytes), urls.map((_, i) => `<s${i}>`).join(''));
  assert.equal(most, 4);
});

test('downloadAudio: a private track sends its secret with the stream request', async () => {
  const secretLink = 'https://soundcloud.com/artist/track-1/s-AbC12';
  const asked = soundcloud({ tracks: { [secretLink]: scTrack(1, { secret: 's-AbC12' }) } });
  const file = await downloadAudio(await getTrack(secretLink));
  assert.equal(file.ext, 'm4a');
  assert.ok(asked.some((u) => u.includes('/stream/') && u.includes('secret_token=s-AbC12')));

  // A public track whose name starts with "s-" is not a secret link.
  soundcloud({ tracks: { 'https://soundcloud.com/artist/s-club': scTrack(2) } });
  assert.equal((await getTrack('https://soundcloud.com/artist/s-club')).secretToken, null);
});

test('downloadAudio: why not — blocked, preview only, DRM only, too long, too big', async () => {
  const tracks = {
    'https://soundcloud.com/a/blocked': scTrack(1, { policy: 'BLOCK' }),
    'https://soundcloud.com/a/goplus': scTrack(2, { policy: 'SNIP', snipped: true }),
    'https://soundcloud.com/a/drm': scTrack(3, { streams: ['drm', 'opus', 'abr_sq'] }),
    'https://soundcloud.com/a/long': scTrack(4, { seconds: 3 * 3600 }),
    'https://soundcloud.com/a/ok': scTrack(5),
    'https://soundcloud.com/a/sneaky': scTrack(6, { streams: ['aac_preview'] }),
  };
  const asked = soundcloud({ tracks });
  const fails = async (url, code, opts) => assert.rejects(downloadAudio(await getTrack(url), opts), isCode(code), url);
  await fails('https://soundcloud.com/a/blocked', 'BLOCKED');
  await fails('https://soundcloud.com/a/goplus', 'PREVIEW_ONLY');
  await fails('https://soundcloud.com/a/drm', 'NO_STREAM');
  await fails('https://soundcloud.com/a/long', 'TOO_LONG');
  assert.ok(!asked.some((u) => u.includes('/stream/')), 'nothing was streamed for a refused track');
  // A stream that turns out to be the 30-second one is refused before downloading it.
  await fails('https://soundcloud.com/a/sneaky', 'PREVIEW_ONLY');
  assert.ok(!asked.some((u) => u.includes('cf-preview-media')));
  await fails('https://soundcloud.com/a/ok', 'TOO_BIG', { limit: 4 });
});

test('artwork: the 300×300 JPEG, or null when there is none', async () => {
  soundcloud({ tracks: { [LINK]: scTrack(1) }, down: ['artworks-404'] });
  const track = await getTrack(LINK);
  assert.equal(asText(await artwork(track)), '<artworks-1-t300x300.jpg>');
  assert.equal(await artwork({ ...track, artworkUrl: null }), null);
  assert.equal(await artwork({ ...track, artworkUrl: 'https://i1.sndcdn.com/artworks-404-large.jpg' }), null);
});
