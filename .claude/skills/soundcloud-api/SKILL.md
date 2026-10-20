---
name: soundcloud-api
description: SoundCloud from this bot's side — api-v2 with the scraped public client_id, /resolve, track fields and policies (ALLOW, MONETIZE, SNIP, BLOCK), media.transcodings (progressive, HLS MP3, HLS AAC, encrypted HLS), signed stream URLs, joining HLS segments, share links (on.soundcloud.com), playlists, search, rate limits, and the SoundcloudError codes. Use when changing tgcloud/lib/soundcloud.js or lib/probe.js, adding a SoundCloud-backed feature (playlists, albums, search, inline results, quality choice), debugging a download that fails (NOT_FOUND, NO_STREAM, BLOCKED, NO_CLIENT_ID, UNREACHABLE…), or when SoundCloud changes its site or API.
---

# SoundCloud api-v2 for this bot

The code is `tgcloud/lib/soundcloud.js`; the narrative is `docs/SOUNDCLOUD.md`.
Request and response shapes are in
[references/api-v2.md](references/api-v2.md). Read it before parsing a field
the code doesn't read yet.

## Ground rules

- **No official key.** SoundCloud doesn't register new API apps. The bot uses
  `api-v2.soundcloud.com` with the public `client_id` of soundcloud.com's own
  player: scraped (`scrapeClientId`), kept in `settings` as `sc:client_id`,
  re-scraped once on 401/403 (`apiGet`). Never hard-code an id in code; the
  admin's `/setclientid` is the manual override.
- **Every api-v2 call goes through `apiGet(pathOrUrl, params)`**: it adds the
  client_id, retries once with a fresh one, and maps statuses to
  `SoundcloudError` codes (404 → NOT_FOUND, 403 → BLOCKED, 429 →
  RATE_LIMITED, other → UNREACHABLE). Don't call `fetch` on api-v2 directly.
- **Throw `SoundcloudError(code, detail)`** for anything the user should be
  told about. A new code needs a Persian message in `ERRORS`
  (`lib/download.js`), a row in `docs/SOUNDCLOUD.md` §5, and a test.
  Anything else thrown becomes `INTERNAL` (logged, generic message).
- **No browser globals** in the runtime: no `URL`, `URLSearchParams`,
  `TextDecoder`. Build queries with `encodeURIComponent` (`query()`), resolve
  relative URLs with `absolute()`.
- **`fetch` bodies stream**: `for await (const chunk of res.body)`; there is no
  `arrayBuffer()`. Check `content-length` first and count while reading
  (`download()` does both) so an oversized file stops early.
- **Signed media URLs expire within minutes**: fetch the stream URL right
  before downloading, never store it.

## Links

`findSoundcloudUrl(text)` → `{ url, short }`. Accepts `soundcloud.com`,
`www.`/`m.`, no scheme, a secret `/s-xxxx` path segment; strips the query and
trailing punctuation. Share links (`on.soundcloud.com/<code>`,
`soundcloud.app.goo.gl/<code>`) are `short: true`: `getTrack` fetches them and
uses `res.url` (redirects are followed by the sdk's fetch).

`/resolve` returns `kind: 'track' | 'playlist' | 'user'` for any of these.
Paths like `/discover`, `/you/…` simply fail to resolve (NOT_FOUND).

## Choosing a stream

`pickTranscoding` takes the first match in `FORMATS`, skipping `snipped`:

1. `progressive` + `audio/mpeg` → one GET, `.mp3`
2. `hls` + `audio/mpeg` → segments concatenated, `.mp3`
3. `hls` + `audio/mp4` (AAC) → `#EXT-X-MAP` init + segments, `.m4a` (unconfirmed in Telegram clients)

Never: `ctr-encrypted-hls` / `cbc-encrypted-hls` (DRM; also any
`#EXT-X-KEY` other than `METHOD=NONE` → NO_STREAM). Opus HLS is skipped for
now. To change the order or add a format, edit `FORMATS`, extend
`test/soundcloud.test.mjs` ("pickTranscoding…"), and the table in
`docs/SOUNDCLOUD.md` §3.

Before any download, `downloadAudio` refuses: `policy: BLOCK` → BLOCKED;
only snipped streams or `policy: SNIP` → PREVIEW_ONLY; no usable format →
NO_STREAM (the formats are in `detail`); over `MAX_DURATION_SECONDS` →
TOO_LONG. Nothing is fetched for a refused track — keep it that way.

## Adding a SoundCloud feature

- **Playlists/albums**: `resolve` gives `tracks[]` where only the first few are
  complete; the rest have just `id`. Fill them with
  `apiGet('/tracks', { ids: '1,2,3' })` (≤ 50 ids per call). Cap how many a
  user may pull per request.
- **Search**: `apiGet('/search/tracks', { q, limit: 10, offset })` →
  `{ collection: [track…], next_href }`.
- **Rate limits**: SoundCloud throttles by IP and client_id; the bot shares
  Telegram's IPs with other bots. Prefer the `tracks` file_id cache over new
  requests, and count per-user requests from `downloads`.

## Testing

`soundcloud()` in `test/helpers.mjs` is the fake: extend it when you use a new
endpoint (keep its URL shapes the real ones). `scTrack(id, { streams, policy,
seconds, snipped })` builds tracks; `streams` keys: `progressive`, `hls-mp3`,
`hls-aac`, `hls-opus`, `encrypted`.

The fake is what you *believe* SoundCloud does. Confirm from the cloud with
the probe (`/sc <link>` or `endpoints/adminProbe { url }`), whose report lists
the track's real formats (`📼 …`) and each step's time. When SoundCloud
changes (scraping fails → NO_CLIENT_ID; new format names → NO_STREAM), start
there, then fix `CLIENT_ID_PATTERNS` / `FORMATS` and add a test with the new shape.
