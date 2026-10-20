# SoundCloud: how a link becomes an audio message

The bot's one feature, end to end. Code: `tgcloud/lib/soundcloud.js` (the
SoundCloud side), `tgcloud/lib/download.js` (the Telegram side),
`tgcloud/lib/probe.js` (checking it from the cloud). Project conventions are in
[ARCHITECTURE.md](ARCHITECTURE.md); keep this file true when the flow changes.

## 1. The flow

```
private chat: "https://on.soundcloud.com/AbC"
  │ handlers/message.js → replyDownload(message, text)          lib/download.js
  ├─ findSoundcloudUrl(text) → { url, short }                   lib/soundcloud.js
  ├─ sendMessage "⏳ …" (the status message, a reply to the link)
  ├─ getTrack(link)
  │    ├─ short link → fetch it, follow redirects, res.url = the soundcloud.com link
  │    └─ GET api-v2 /resolve?url=…&client_id=…  → kind: track | playlist | user
  ├─ tracks has this track_id?  ── yes → sendAudio(file_id) ──────────────┐
  │                               (400 → forget it, go on below)          │
  ├─ sendChatAction upload_voice                                          │
  ├─ downloadAudio(track)                                                 │
  │    ├─ policy / duration checks (nothing downloaded when refused)      │
  │    ├─ pickTranscoding → progressive MP3 › HLS MP3 › HLS AAC           │
  │    ├─ GET <transcoding.url>?client_id&track_authorization → { url }   │
  │    └─ one file, or the HLS segments joined (with the fMP4 init first) │
  ├─ artwork(track) → 300×300 JPEG thumbnail (best effort)                │
  ├─ sendAudio(InputFile "Artist - Title.mp3", title, performer, …)       │
  └─ tracks ← file_id ◀───────────────────────────────────────────────────┘
  downloads ← { status: sent | cached | failed, error, ms }; status message deleted
  (on failure: edited into the reason, ERRORS in lib/download.js)
```

## 2. api-v2 and the client_id

SoundCloud closed its official API to new apps, so the bot talks to
`api-v2.soundcloud.com` the way soundcloud.com's own player does, with the
public `client_id` every visitor gets:

1. `clientId()` returns the id kept in `settings` (`sc:client_id`).
2. None kept: `scrapeClientId()` loads `https://soundcloud.com/` and reads it
   from the page's hydration data
   (`{"hydratable":"apiClient","data":{"id":"…"}}`). If the page has none, it
   reads the `a-v2.sndcdn.com/assets/*.js` bundles, last first, for
   `client_id:"…"`.
3. api-v2 answers **401/403** → the id is scraped again **once** and the call
   retried (`apiGet`). Ids rotate every few weeks; this is the normal path.
4. Scraping broken → `/setclientid <id>` sets one by hand (copy it from any
   `api-v2` request in the browser's network tab on soundcloud.com).

The browser-like `user-agent` in `HEADERS` is deliberate: soundcloud.com serves
its page to browsers.

### Endpoints used

| Call | Answer |
|---|---|
| `GET https://soundcloud.com/` | HTML with the client_id |
| `GET /resolve?url=<soundcloud.com link>` | the track / playlist / user (`kind`) |
| `GET <transcoding.url>?track_authorization=…` | `{ url }`: the signed media or playlist URL (expires within minutes) |
| `GET <media url>` / `<m3u8>` / segments | the audio, on `cf-media.sndcdn.com` / `cf-hls-media.sndcdn.com` |
| `GET <artwork_url with -t300x300>` | the cover, on `i1.sndcdn.com` |

All with `client_id`. Fields the bot reads from a track: `id`, `title`,
`publisher_metadata.artist` / `user.username`, `full_duration` (ms),
`permalink_url`, `artwork_url`, `policy`, `track_authorization`,
`media.transcodings[]` (`url`, `snipped`, `format.protocol`,
`format.mime_type`).

## 3. Streams

`media.transcodings` lists what a track can be played as. `pickTranscoding`
takes the first usable one, in this order:

| # | `format.protocol` | `format.mime_type` | Becomes |
|---|---|---|---|
| 1 | `progressive` | `audio/mpeg` | one GET → `.mp3` |
| 2 | `hls` | `audio/mpeg` | the segments joined → `.mp3` (MP3 frames join cleanly) |
| 3 | `hls` | `audio/mp4; codecs="mp4a.40.2"` | `#EXT-X-MAP` init + segments → fragmented `.m4a` |
| — | `ctr-encrypted-hls`, `cbc-encrypted-hls` | any | never: DRM (`NO_STREAM`) |
| — | `hls` | `audio/ogg; codecs="opus"` | not yet (Telegram's audio player wants MP3/M4A) |
| — | any, `snipped: true` | | never: a 30-second Go+ preview (`PREVIEW_ONLY`) |

SoundCloud has been moving tracks from progressive MP3 to HLS AAC, and many to
encrypted HLS only. Which formats tracks really have, seen from the cloud, is
in `/sc`'s report (`📼 …`) and in `downloads.error = 'NO_STREAM'` counts in
`/stats`. Row 3 (fMP4 joined into one file) is **not yet confirmed** to play in
every Telegram client: check one with `/sc` + a real link before relying on it.

## 4. Limits

| Limit | Value | Where |
|---|---|---|
| Bot API upload | 50 MB per file | `MAX_AUDIO_BYTES` = 49 MB (room for the multipart envelope) |
| Length checked before downloading | 50 min (128 kbps MP3 ≈ 47 MB) | `MAX_DURATION_SECONDS` |
| Thumbnail | JPEG, ≤ 320 px, < 200 KB | `artwork()` asks for `-t300x300`, caps at 200 KB |
| Download stopped as soon as it passes the limit | `content-length` first, then counted while streaming | `download()` → `TOO_BIG` |

**Not known yet** (measure with the probe — `ms` of each step — before
building on them):

- how long one handler run may take on Telegram Serverless (a 10 MB track is
  one download plus one upload inside the webhook's run);
- how much memory a run gets (the whole file is held as one `Uint8Array`);
- whether `*.sndcdn.com` and `api-v2.soundcloud.com` answer Telegram's servers
  at all, and from which country (geo-blocked tracks come back as
  `policy: BLOCK` or 403 → `BLOCKED`).

## 5. Errors

`SoundcloudError.code` → the user's message (`ERRORS` in `lib/download.js`) →
`downloads.error`:

| Code | Means | Typical cause |
|---|---|---|
| `NOT_FOUND` | 404 from resolve; a share link that led nowhere | deleted, private without the secret link, typo |
| `NOT_TRACK` | resolve gave a playlist / user | `/sets/…`, a profile link |
| `BLOCKED` | `policy: BLOCK`, or 403 after a fresh client_id | geo restriction, takedown |
| `PREVIEW_ONLY` | only snipped streams / `policy: SNIP` | SoundCloud Go+ track |
| `NO_STREAM` | nothing in the table above is usable | encrypted-only track |
| `TOO_LONG` / `TOO_BIG` | over the limits above | mixes, podcasts |
| `RATE_LIMITED` | 429 from api-v2 | too many requests from the cloud's IPs |
| `NO_CLIENT_ID` | no id in the page or its scripts | soundcloud.com changed its markup → fix `CLIENT_ID_PATTERNS`, or `/setclientid` |
| `UNREACHABLE` | network error, 5xx, not JSON | SoundCloud down or unreachable from the cloud |
| `INTERNAL` | anything else (a bug); logged with `console.error` | read it with `tgcloud run` |

## 6. Checking it from the cloud

The local tests (`npm test`) run on a fake SoundCloud and say nothing about the
real one. The real check runs where the bot runs:

- **In the bot:** the admin sends `/sc` (the default track,
  `PROBE_TRACK_URL`) or `/sc <link>`.
- **From GitHub:** Actions → *Run in cloud* → `endpoints/adminProbe` with `{}`
  or `{ url: "…" }`. `check.yml` runs it on every branch other than `main`.
- **From a terminal:**
  `npx tgcloud run endpoints/adminProbe '{ url: "https://soundcloud.com/…" }' --ctx '{ initData: { user: { id: 199419831 } } }'`

Each step reports `ok`, `ms` and its value or error: `client_id (kept|scraped)`
→ `resolve` → `stream` (the format picked) → `download` (bytes). The audio is
downloaded but never sent.

## 7. Roadmap

Roughly in order; each is a `lib/` module + tests + a line in this file.

1. **First deploy, then `/sc`**: confirm reachability, formats and timings
   from the cloud; adjust the limits and the format order to what it shows.
2. **Playlists and albums** (`NOT_TRACK` today): list the tracks
   (`/resolve` gives the first ~5 in full, the rest as ids →
   `GET /tracks?ids=1,2,3`), then send them one by one with a progress
   message — or as buttons to pick from. Needs a cap per request.
3. **Per-user limits**: N downloads per hour from `downloads`, to stay under
   SoundCloud's rate limits.
4. **Inline mode** (`@bot <search>`): `GET /search/tracks?q=…`, results from
   `tracks` (already on Telegram) as cached audio. Needs a private storage
   channel to upload new ones to (see the calculator bot's `IMAGE_CHAT_ID`)
   and `handlers/inline_query.js`, `chosen_inline_result.js`.
5. **Groups**: answer a link when the bot is mentioned or replied to.
6. **Quality / format choice** (buttons under the status message) once the
   formats seen in the cloud are known.
7. **Opus** streams → `sendVoice`/`sendDocument`, if many tracks have only those.
