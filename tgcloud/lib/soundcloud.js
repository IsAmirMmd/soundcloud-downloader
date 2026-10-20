// SoundCloud, as its own web player sees it: api-v2 with the public client_id
// that soundcloud.com's scripts carry. SoundCloud no longer registers apps for
// its official API, so the id is scraped from the site, kept in `settings`
// (key `sc:client_id`), and scraped again when api-v2 refuses it (401/403).
//
//   findSoundcloudUrl(text)   the first SoundCloud link in a message, normalized
//   getTrack(url)             resolve a link to a track (SoundcloudError otherwise)
//   downloadAudio(track)      the track's audio bytes, from the best stream it has
//   artwork(track)            a 300×300 JPEG for the audio's thumbnail, or null
//
// The runtime is not a browser: no URL, URLSearchParams or TextDecoder are
// assumed, only `fetch` from the sdk. Whether SoundCloud answers Telegram's
// servers at all is checked by lib/probe.js (/sc, endpoints/adminProbe.js).

import { fetch } from 'sdk';
import { getSetting, setSetting } from './settings.js';
import { MAX_AUDIO_BYTES, MAX_DURATION_SECONDS } from './config.js';

const SITE = 'https://soundcloud.com';
const API = 'https://api-v2.soundcloud.com';
const CLIENT_ID_KEY = 'sc:client_id';

// soundcloud.com serves its page (and the client_id in it) to browsers.
const HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  'accept-language': 'en-US,en;q=0.9',
};

// Why a link gave no audio. `code` picks the user's message (lib/download.js)
// and is what downloads.error records.
//   NOT_FOUND     no such track, or a private one without its secret link
//   NOT_TRACK     a playlist, an album or a profile (kind in `detail`)
//   BLOCKED       not available where Telegram's servers are, or taken down
//   PREVIEW_ONLY  SoundCloud Go+: only a 30-second preview is public
//   NO_STREAM     only encrypted (DRM) or unknown stream formats
//   TOO_LONG      longer than MAX_DURATION_SECONDS
//   TOO_BIG       more than MAX_AUDIO_BYTES once downloaded
//   RATE_LIMITED  api-v2 answered 429
//   NO_CLIENT_ID  soundcloud.com no longer carries a client_id we can find
//   UNREACHABLE   network errors, 5xx, anything unexpected from SoundCloud
export class SoundcloudError extends Error {
  constructor(code, detail = '') {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'SoundcloudError';
    this.code = code;
    this.detail = detail;
  }
}

// ---------- links ----------

// soundcloud.com/<user>/<track>[/s-<secret>], m./www. variants, the share
// short links (on.soundcloud.com/<code>, soundcloud.app.goo.gl/<code>), with
// or without https://. The query (?si=…&utm_…) is dropped: it never matters,
// and the secret of a private track is in the path.
const LINK = /(?<![\w.-])(?:https?:\/\/)?((?:www\.|m\.)?soundcloud\.com|on\.soundcloud\.com|soundcloud\.app\.goo\.gl)(\/[^\s?#<>"']*)?/i;

// → { url, short } for the first SoundCloud link in `text`, or null.
// `short`: a share link, which getTrack() follows to the real one first.
export function findSoundcloudUrl(text) {
  const m = LINK.exec(text ?? '');
  if (!m) return null;
  const host = m[1].toLowerCase().replace(/^(www|m)\./, '');
  const path = (m[2] ?? '').replace(/[.,!?؛،)\]]+$/, '').replace(/\/+$/, '');
  if (!/^\/[^/]+/.test(path)) return null;   // the bare site, no track
  return { url: `https://${host}${path}`, short: host !== 'soundcloud.com' };
}

// A share link → the soundcloud.com link it redirects to (fetch follows
// redirects; res.url is where they ended).
async function expand(url) {
  let res;
  try {
    res = await fetch(url, { headers: HEADERS });
  } catch (e) {
    throw new SoundcloudError('UNREACHABLE', `${url}: ${e.message}`);
  }
  const target = findSoundcloudUrl(res.url ?? '');
  if (!target || target.short) throw new SoundcloudError('NOT_FOUND', `${url} led to ${res.url ?? 'nowhere'}`);
  return target.url;
}

// ---------- client_id ----------

// The id in a page or a script: the page's hydration data first, then the
// bundles' `client_id:"…"` / `?client_id=…`.
const CLIENT_ID_PATTERNS = [
  /"hydratable"\s*:\s*"apiClient"\s*,\s*"data"\s*:\s*\{\s*"id"\s*:\s*"([a-zA-Z0-9]{32})"/,
  /client_id\s*[:=]\s*["']([a-zA-Z0-9]{32})["']/,
  /[?&]client_id=([a-zA-Z0-9]{32})/,
];

export function clientIdIn(text) {
  for (const re of CLIENT_ID_PATTERNS) {
    const m = re.exec(text ?? '');
    if (m) return m[1];
  }
  return null;
}

async function getText(url) {
  let res;
  try {
    res = await fetch(url, { headers: HEADERS });
  } catch (e) {
    throw new SoundcloudError('UNREACHABLE', `${url}: ${e.message}`);
  }
  const body = await res.text();
  if (!res.ok) throw new SoundcloudError('UNREACHABLE', `${url}: HTTP ${res.status}`);
  return body;
}

// A fresh client_id from soundcloud.com. The page's own data has it; if not,
// one of its script bundles does — the app's own code is in the last ones.
export async function scrapeClientId() {
  const page = await getText(`${SITE}/`);
  const inPage = clientIdIn(page);
  if (inPage) return inPage;
  const scripts = [...page.matchAll(/<script[^>]+src="(https:\/\/[^"]*sndcdn\.com\/[^"]+\.js)"/g)].map((m) => m[1]);
  for (const src of scripts.reverse()) {
    const id = clientIdIn(await getText(src).catch(() => ''));
    if (id) return id;
  }
  throw new SoundcloudError('NO_CLIENT_ID', `none in soundcloud.com or its ${scripts.length} scripts`);
}

// The client_id to use: the kept one, or a new one scraped and kept.
// `fresh`: the kept one was refused — scrape again.
export async function clientId({ fresh = false } = {}) {
  if (!fresh) {
    const kept = await getSetting(CLIENT_ID_KEY);
    if (kept) return kept;
  }
  const id = await scrapeClientId();
  await setSetting(CLIENT_ID_KEY, id);
  return id;
}

// ---------- api-v2 ----------

const query = (params) => Object.entries(params)
  .filter(([, v]) => v != null && v !== '')
  .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
  .join('&');

// GET an api-v2 path (or a full api-v2 URL, like a transcoding's) as JSON,
// with the client_id. A refused client_id is scraped again once.
export async function apiGet(pathOrUrl, params = {}) {
  const base = pathOrUrl.startsWith('https://') ? pathOrUrl : `${API}${pathOrUrl}`;
  let id = await clientId();
  for (let attempt = 0; ; attempt++) {
    const url = `${base}${base.includes('?') ? '&' : '?'}${query({ ...params, client_id: id })}`;
    let res;
    try {
      res = await fetch(url, { headers: { ...HEADERS, accept: 'application/json' } });
    } catch (e) {
      throw new SoundcloudError('UNREACHABLE', `${base}: ${e.message}`);
    }
    if ((res.status === 401 || res.status === 403) && attempt === 0) {
      id = await clientId({ fresh: true });
      continue;
    }
    const body = await res.text();
    if (res.status === 404) throw new SoundcloudError('NOT_FOUND', base);
    if (res.status === 403) throw new SoundcloudError('BLOCKED', base);
    if (res.status === 429) throw new SoundcloudError('RATE_LIMITED', base);
    if (!res.ok) throw new SoundcloudError('UNREACHABLE', `${base}: HTTP ${res.status} ${body.slice(0, 120)}`);
    try {
      return JSON.parse(body);
    } catch {
      throw new SoundcloudError('UNREACHABLE', `${base}: not JSON: ${body.slice(0, 120)}`);
    }
  }
}

// A soundcloud.com link → what api-v2 knows about it (a track, playlist or user).
export const resolve = (url) => apiGet('/resolve', { url });

// The fields of a track the bot uses.
function trackOf(t) {
  return {
    id: t.id,
    title: t.title || 'SoundCloud',
    artist: t.publisher_metadata?.artist || t.user?.username || '',
    duration: Math.round((t.full_duration ?? t.duration ?? 0) / 1000),   // seconds
    permalink: t.permalink_url ?? null,
    artworkUrl: t.artwork_url ?? t.user?.avatar_url ?? null,
    policy: t.policy ?? null,                                            // ALLOW | MONETIZE | SNIP | BLOCK
    transcodings: t.media?.transcodings ?? [],
    trackAuthorization: t.track_authorization ?? null,
  };
}

// The track a link points at. Share links are followed first.
export async function getTrack(link) {
  const { url, short } = typeof link === 'string' ? { url: link, short: false } : link;
  const found = await resolve(short ? await expand(url) : url);
  if (found?.kind !== 'track') throw new SoundcloudError('NOT_TRACK', found?.kind ?? 'nothing');
  return trackOf(found);
}

// ---------- streams ----------

// The streams the bot can turn into a file, best first: one MP3 file; MP3
// segments (they join into one MP3); AAC in fragmented MP4 (init + segments
// join into one .m4a). Encrypted streams (ctr-/cbc-encrypted-hls) are DRM and
// never used. A snipped stream is a 30-second preview.
const FORMATS = [
  { protocol: 'progressive', mime: 'audio/mpeg', ext: 'mp3', type: 'audio/mpeg' },
  { protocol: 'hls', mime: 'audio/mpeg', ext: 'mp3', type: 'audio/mpeg' },
  { protocol: 'hls', mime: 'audio/mp4', ext: 'm4a', type: 'audio/mp4' },
];

// → { transcoding, format } for the best usable stream, or null.
export function pickTranscoding(transcodings) {
  for (const format of FORMATS) {
    const transcoding = transcodings.find((t) => !t.snipped
      && t.format?.protocol === format.protocol
      && (t.format?.mime_type ?? '').startsWith(format.mime));
    if (transcoding) return { transcoding, format };
  }
  return null;
}

// "dir/x.m3u8" + "seg.mp3" → absolute URLs for a playlist's entries.
function absolute(ref, base) {
  if (/^https?:\/\//i.test(ref)) return ref;
  const origin = /^https?:\/\/[^/]+/i.exec(base)[0];
  if (ref.startsWith('/')) return origin + ref;
  return base.replace(/[?#].*$/, '').replace(/[^/]*$/, '') + ref;
}

// An HLS media playlist → { map, segments }: the init segment (fMP4), if
// any, and the segments in order, as absolute URLs. Encrypted → NO_STREAM.
export function parseM3u8(text, base) {
  let map = null;
  const segments = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-KEY:') && !/METHOD=NONE/i.test(line)) throw new SoundcloudError('NO_STREAM', 'encrypted HLS');
    if (line.startsWith('#EXT-X-MAP:')) {
      const uri = /URI="([^"]+)"/.exec(line)?.[1];
      if (uri) map = absolute(uri, base);
    } else if (!line.startsWith('#')) {
      segments.push(absolute(line, base));
    }
  }
  return { map, segments };
}

function concat(chunks, total) {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

// Downloads `urls` one after another into one byte array, stopping with
// TOO_BIG as soon as it passes `limit`.
async function download(urls, limit) {
  const chunks = [];
  let total = 0;
  for (const url of urls) {
    let res;
    try {
      res = await fetch(url, { headers: HEADERS });
    } catch (e) {
      throw new SoundcloudError('UNREACHABLE', `${url.slice(0, 80)}: ${e.message}`);
    }
    if (!res.ok) throw new SoundcloudError(res.status === 403 ? 'BLOCKED' : 'UNREACHABLE', `${url.slice(0, 80)}: HTTP ${res.status}`);
    const length = Number(res.headers?.get?.('content-length') ?? 0);
    if (length && total + length > limit) throw new SoundcloudError('TOO_BIG', `${total + length} bytes`);
    for await (const chunk of res.body) {
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      total += bytes.length;
      if (total > limit) throw new SoundcloudError('TOO_BIG', `over ${limit} bytes`);
      chunks.push(bytes);
    }
  }
  return concat(chunks, total);
}

// The track as one audio file → { bytes, ext, type, format }. Throws a
// SoundcloudError that says why when it can't.
export async function downloadAudio(track, { limit = MAX_AUDIO_BYTES } = {}) {
  if (track.policy === 'BLOCK') throw new SoundcloudError('BLOCKED', `policy ${track.policy}`);
  const picked = pickTranscoding(track.transcodings);
  if (!picked) {
    if (track.policy === 'SNIP' || track.transcodings.some((t) => t.snipped)) throw new SoundcloudError('PREVIEW_ONLY');
    const formats = track.transcodings.map((t) => `${t.format?.protocol} ${t.format?.mime_type}`).join(', ');
    throw new SoundcloudError('NO_STREAM', formats || 'no transcodings');
  }
  if (track.duration > MAX_DURATION_SECONDS) throw new SoundcloudError('TOO_LONG', `${track.duration} s`);

  const { transcoding, format } = picked;
  const stream = await apiGet(transcoding.url, { track_authorization: track.trackAuthorization });
  if (!stream?.url) throw new SoundcloudError('UNREACHABLE', 'no stream url');

  let urls = [stream.url];
  if (format.protocol === 'hls') {
    const playlist = parseM3u8(await getText(stream.url), stream.url);
    urls = [...(playlist.map ? [playlist.map] : []), ...playlist.segments];
    if (!playlist.segments.length) throw new SoundcloudError('NO_STREAM', 'empty HLS playlist');
  }
  const bytes = await download(urls, limit);
  return { bytes, ext: format.ext, type: format.type, format: `${format.protocol} ${format.type}` };
}

// The cover as a JPEG small enough for a Telegram thumbnail (≤ 320 px,
// < 200 KB): the `-t300x300` size of the artwork. Never throws.
export async function artwork(track) {
  const url = track.artworkUrl?.replace(/-(large|t\d+x\d+|crop|original)\.(jpg|png)$/, '-t300x300.jpg');
  if (!url) return null;
  try {
    return await download([url], 200 * 1024);
  } catch {
    return null;
  }
}
