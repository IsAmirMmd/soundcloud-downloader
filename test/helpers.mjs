// Shared by the tests: a fresh database per test, update builders, ctx, and a
// fake SoundCloud.

import * as schema from '../tgcloud/schema.js';
import { createTables } from './sdk/db.mjs';
import { resetApi, take as takeAll, mockFetch } from './sdk/sdk.mjs';
import { ADMIN_ID } from '../tgcloud/lib/config.js';

export { ADMIN_ID };
export { rows, row, exec } from './sdk/db.mjs';
export { calls, mockApi, failNext, mockFetch } from './sdk/sdk.mjs';

// The Bot API calls since the last take(), [{ method, params }]. Without getMe:
// lib/bot.js asks it once and keeps it, so whether it shows depends on test order.
export const take = () => takeAll().filter((c) => c.method !== 'getMe');

export function fresh() {
  createTables(schema);
  resetApi();
  mockFetch(async (url) => { throw new Error(`fetch(${url}) in a test: mock it with mockFetch() or soundcloud()`); });
}

const user = (id, extra = {}) => ({ id, is_bot: false, first_name: `User${id}`, ...extra });

// A private-chat message from `from` (a user id).
export const msg = (from, text, extra = {}) => ({
  message_id: Math.floor(Math.random() * 1e6),
  date: Math.floor(Date.now() / 1000),
  from: user(from),
  chat: { id: from, type: 'private' },
  text,
  ...extra,
});

// The same in a group.
export const groupMsg = (from, text, chatId = -1001234) => msg(from, text, { chat: { id: chatId, type: 'supergroup', title: 'Group' } });

// A button press by `from` on a message the bot sent them.
export const press = (from, data, messageId = 1) => ({
  id: `q${Math.random()}`,
  from: user(from),
  data,
  message: { message_id: messageId, chat: { id: from, type: 'private' }, text: '…' },
});

// my_chat_member in a private chat: `status` 'kicked' = blocked the bot, 'member' = unblocked.
export const membership = (from, status) => ({
  chat: { id: from, type: 'private' },
  from: user(from),
  date: Math.floor(Date.now() / 1000),
  old_chat_member: { status: status === 'kicked' ? 'member' : 'kicked', user: { id: 1, is_bot: true } },
  new_chat_member: { status, user: { id: 1, is_bot: true } },
});

// ctx for an endpoint call by `id` (verified init data in the cloud).
export const ctxOf = (id) => ({ initData: { user: user(id) } });

// ---------- a fake SoundCloud (lib/soundcloud.js) ----------

export const CLIENT_ID = 'a'.repeat(32);

// What api-v2 lists in media.transcodings, by the name a test uses. Since
// SoundCloud dropped progressive MP3 (August 2026) most tracks have only
// aac_160k, aac_96k and abr_sq; HLS MP3 is left on tracks not moved yet.
const AAC = 'audio/mp4; codecs="mp4a.40.2"';
const STREAMS = {
  progressive: { preset: 'mp3_0_0', protocol: 'progressive', mime_type: 'audio/mpeg' },
  'hls-mp3': { preset: 'mp3_1_0', protocol: 'hls', mime_type: 'audio/mpeg' },
  aac_160k: { preset: 'aac_160k', protocol: 'hls', mime_type: AAC },
  aac_96k: { preset: 'aac_96k', protocol: 'hls', mime_type: AAC },
  abr_sq: { preset: 'abr_sq', protocol: 'hls', mime_type: AAC },              // its stream URL 404s
  opus: { preset: 'opus_0_0', protocol: 'hls', mime_type: 'audio/ogg; codecs="opus"' },
  drm: { preset: 'aac_160k', protocol: 'ctr-encrypted-hls', mime_type: AAC },
  aac_master: { preset: 'aac_256k', protocol: 'hls', mime_type: AAC },        // a master playlist
  aac_preview: { preset: 'aac_160k', protocol: 'hls', mime_type: AAC },       // the stream is the 30-second one
};

// A track as api-v2's /resolve returns it. `streams` are keys of STREAMS;
// `secret`: a private track's secret_token, which its streams then require.
export function scTrack(id, { streams = ['aac_160k', 'aac_96k', 'abr_sq'], policy = 'ALLOW', seconds = 180, snipped = false, secret = null, ...extra } = {}) {
  return {
    kind: 'track',
    id,
    title: `Track ${id}`,
    user: { username: 'artist', avatar_url: `https://i1.sndcdn.com/avatars-${id}-large.jpg` },
    duration: snipped ? 30_000 : seconds * 1000,
    full_duration: seconds * 1000,
    permalink_url: `https://soundcloud.com/artist/track-${id}`,
    artwork_url: `https://i1.sndcdn.com/artworks-${id}-large.jpg`,
    policy,
    track_authorization: `auth-${id}`,
    ...(secret ? { secret_token: secret } : {}),
    media: {
      transcodings: streams.map((s) => ({
        url: `https://api-v2.soundcloud.com/media/soundcloud:tracks:${id}/${s}/stream/${STREAMS[s].protocol}`,
        preset: STREAMS[s].preset,
        snipped,
        format: { protocol: STREAMS[s].protocol, mime_type: STREAMS[s].mime_type },
        quality: 'sq',
      })),
    },
    ...extra,
  };
}

// The bytes of a file the fake serves: its name, so a test can tell what was joined.
export const fakeBytes = (name) => new Uint8Array(Buffer.from(`<${name}>`));

// MP4 boxes, for a fake that serves real fragmented MP4 (soundcloud({ mp4: true })).
export function mp4Box(type, ...parts) {
  const body = Buffer.concat(parts.map((p) => Buffer.from(p)));
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length + 8);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
}
// An HLS init segment (ftyp + moov), and a media segment (moof with
// default-base-is-moof + mdat holding `name`), like SoundCloud's AAC.
const fmp4Init = () => new Uint8Array(Buffer.concat([mp4Box('ftyp', 'iso6mp41'), mp4Box('moov', mp4Box('mvhd', Buffer.alloc(100)))]));
const fmp4Segment = (name) => new Uint8Array(Buffer.concat([
  mp4Box('moof', mp4Box('mfhd', Buffer.alloc(8)), mp4Box('traf', mp4Box('tfhd', [0, 2, 0, 0, 0, 0, 0, 1]))),
  mp4Box('mdat', `<${name}>`),
]));
export const asText = (bytes) => Buffer.from(bytes).toString();

function reply(status, body, { url, headers = {} } = {}) {
  const bytes = body instanceof Uint8Array ? body : null;
  const text = bytes ? Buffer.from(bytes).toString() : typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => text,
    json: async () => JSON.parse(text),
    // Two chunks, the way a real body streams.
    body: (async function* () {
      const all = bytes ?? new Uint8Array(Buffer.from(text));
      yield all.subarray(0, Math.ceil(all.length / 2));
      yield all.subarray(Math.ceil(all.length / 2));
    })(),
  };
}

const paramsOf = (query = '') => Object.fromEntries(query.split('&').filter(Boolean)
  .map((kv) => kv.split('=').map(decodeURIComponent)));

// Routes every fetch to a fake soundcloud.com, api-v2 and media CDN.
//   tracks   { '<soundcloud.com link>': scTrack(…) | { kind: 'playlist' } }
//   short    { '<share link>': '<where it redirects>' }
//   clientId the id the site hands out and api-v2 accepts
//   pageId   false: the page carries no id, only its script does
//   down     substrings of URLs that answer 503
//   mp4      AAC segments as real fragmented MP4 boxes, not just their names
// Returns the URLs asked, in order.
export function soundcloud({ tracks = {}, short = {}, clientId = CLIENT_ID, pageId = true, down = [], mp4 = false } = {}) {
  const asked = [];
  mockFetch(async (url) => {
    asked.push(url);
    if (down.some((d) => url.includes(d))) return reply(503, 'Service Unavailable');
    const [base, query] = url.split('?');
    const params = paramsOf(query);

    if (url === 'https://soundcloud.com/') {
      const hydration = pageId ? `{"hydratable":"apiClient","data":{"id":"${clientId}","isExpiring":false}}` : '{"hydratable":"features","data":{}}';
      return reply(200, `<html><script>window.__sc_hydration = [${hydration}];</script>` +
        '<script crossorigin src="https://a-v2.sndcdn.com/assets/0-vendor.js"></script>' +
        '<script crossorigin src="https://a-v2.sndcdn.com/assets/49-app.js"></script></html>');
    }
    if (base === 'https://a-v2.sndcdn.com/assets/49-app.js') return reply(200, `n.push({client_id:"${clientId}",env:"production"})`);
    if (base.startsWith('https://a-v2.sndcdn.com/assets/')) return reply(200, 'var vendor=1;');
    if (short[url]) return reply(200, '<html></html>', { url: short[url] });

    if (base.startsWith('https://api-v2.soundcloud.com/')) {
      if (params.client_id !== clientId) return reply(401, '{"error":"invalid client_id"}');
      if (base === 'https://api-v2.soundcloud.com/resolve') {
        return tracks[params.url] ? reply(200, tracks[params.url]) : reply(404, '{}');
      }
      const m = /\/media\/soundcloud:tracks:(\d+)\/([\w-]+)\/stream\/([\w-]+)$/.exec(base);
      if (m) {
        const [, id, key, protocol] = m;
        const track = Object.values(tracks).find((t) => t.id === Number(id));
        if (params.track_authorization !== `auth-${id}`) return reply(403, '{}');
        if (track?.secret_token && params.secret_token !== track.secret_token) return reply(404, '{}');
        if (key === 'abr_sq') return reply(404, '{}');
        if (protocol === 'progressive') return reply(200, { url: `https://cf-media.sndcdn.com/t${id}.mp3?Policy=p&Signature=s` });
        if (key === 'aac_preview') return reply(200, { url: `https://cf-preview-media.sndcdn.com/playlist/0/30/t${id}/playlist.m3u8?expires=1` });
        const host = key === 'hls-mp3' ? 'https://cf-hls-media.sndcdn.com/playlist' : 'https://playback.media-streaming.soundcloud.cloud';
        return reply(200, { url: `${host}/t${id}/${key}/playlist.m3u8?expires=1` });
      }
    }

    const media = /^https:\/\/cf-media\.sndcdn\.com\/(t\d+\.mp3)$/.exec(base);
    if (media) return reply(200, fakeBytes(media[1]), { headers: { 'content-length': String(fakeBytes(media[1]).length) } });
    const HLS = /^(https:\/\/(?:cf-hls-media\.sndcdn\.com\/playlist|playback\.media-streaming\.soundcloud\.cloud))\/(t\d+)\/([\w-]+)(\/v\d)?\/playlist\.m3u8$/;
    const playlist = HLS.exec(base);
    if (playlist) {
      const [, host, t, key, variant] = playlist;
      if (key === 'aac_master' && !variant) {
        return reply(200, '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=96000,CODECS="mp4a.40.2"\nv1/playlist.m3u8\n' +
          '#EXT-X-STREAM-INF:BANDWIDTH=256000,CODECS="mp4a.40.2"\nv2/playlist.m3u8\n');
      }
      const origin = /^https:\/\/[^/]+/.exec(host)[0];
      const ext = key === 'hls-mp3' ? 'mp3' : 'm4s';
      return reply(200, [
        '#EXTM3U',
        '#EXT-X-VERSION:6',
        '#EXT-X-TARGETDURATION:10',
        ...(ext === 'm4s' ? ['#EXT-X-MAP:URI="init.mp4"'] : []),
        '#EXTINF:10.0,',
        `${origin}/media/0/10/${t}.${ext}?Policy=p`,   // absolute
        '#EXTINF:10.0,',
        `/media/10/20/${t}.${ext}?Policy=p`,          // from the host's root
        '#EXTINF:5.0,',
        `seg3.${ext}`,                               // next to the playlist
        '#EXT-X-ENDLIST',
      ].join('\n'));
    }
    if (/^https:\/\/(cf-hls-media\.sndcdn\.com|playback\.media-streaming\.soundcloud\.cloud)\//.test(base)) {
      const name = base.split('/').slice(-3).join('/');
      if (mp4 && name.endsWith('init.mp4')) return reply(200, fmp4Init());
      if (mp4 && name.endsWith('.m4s')) return reply(200, fmp4Segment(name));
      return reply(200, fakeBytes(name));
    }
    const art = /^https:\/\/i1\.sndcdn\.com\/((?:artworks|avatars)-\d+-t\d+x\d+\.jpg)$/.exec(base);
    if (art) return reply(200, fakeBytes(art[1]));
    throw new Error(`unexpected fetch ${url}`);
  });
  return asked;
}
