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
  │                               not in the channel yet → post it there  │
  │                               by that file_id (no new upload)         │
  ├─ sendChatAction upload_voice                                          │
  ├─ downloadAudio(track)                                                 │
  │    ├─ policy / duration checks (nothing downloaded when refused)      │
  │    ├─ pickTranscoding → MP3 (if left) › AAC 160k › AAC 96k; no abr_sq │
  │    ├─ GET <transcoding.url>?client_id&track_authorization[&secret_token] │
  │    │     → { url } (a /0/30/ preview URL → PREVIEW_ONLY)              │
  │    └─ one file, or the HLS segments joined, 4 fetched at a time       │
  │       (master playlist → best variant; fMP4 init segment first)       │
  ├─ artwork(track) → 300×300 JPEG thumbnail (best effort)                │
  ├─ withTags: title, artist, 500×500 cover written into the file         │
  │     (ID3 / iTunes ilst, lib/tags.js) — a saved file shows them too    │
  ├─ storeTrack: sendAudio(InputFile "Artist - Title.mp4" or .mp3, …) to   │
  │     the storage channel (STORAGE_CHAT_ID) — caption: name, artist,     │
  │     link, #t<id>; refused → the upload goes straight to the user       │
  ├─ sendAudio(the channel post's file_id) to the user, ✏️ 🎤 🖼 under it  │
  └─ tracks ← file_id, storage_message_id ◀───────────────────────────────┘
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
| `GET <transcoding.url>?track_authorization=…[&secret_token=s-…]` | `{ url }`: the signed media or playlist URL (expires within minutes); `secret_token` for a private track |
| `GET <m3u8>` / segments (or one media URL) | the audio: AAC on `playback.media-streaming.soundcloud.cloud`, MP3 HLS on `cf-hls-media.sndcdn.com` (the code assumes no host) |
| `GET <artwork_url with -t300x300>` | the cover, on `i1.sndcdn.com` |

All with `client_id`. Fields the bot reads from a track: `id`, `title`,
`publisher_metadata.artist` / `user.username`, `full_duration` (ms),
`permalink_url`, `artwork_url`, `policy`, `track_authorization`,
`secret_token` (or the `/s-…` of the link), `media.transcodings[]` (`url`,
`preset`, `snipped`, `format.protocol`, `format.mime_type`).

## 3. Streams

`media.transcodings` lists what a track can be played as. SoundCloud is
moving everything to AAC ([soundcloud/api#441](https://github.com/soundcloud/api/issues/441)):
progressive MP3 was removed on 2026-08-12, HLS MP3 stays only on tracks not
yet converted (some for up to a year), and Opus is gone. A track of today
lists `aac_160k`, `aac_96k` (HLS, fMP4) and `abr_sq`. `pickTranscoding`
takes the first row the track has, at the highest bitrate its preset names:

| # | `format.protocol` | `format.mime_type` | `preset` | Becomes |
|---|---|---|---|---|
| 1 | `progressive` | `audio/mpeg` | `mp3_*` | one GET → `.mp3` (gone since 2026-08) |
| 2 | `hls` | `audio/mpeg` | `mp3_*` | the segments joined → `.mp3` (MP3 frames join cleanly) |
| 3 | `hls` | `audio/mp4; codecs="mp4a.40.2"` | `aac_160k` › `aac_96k` | `#EXT-X-MAP` init + segments → fragmented `.mp4` — **the usual case now** |
| — | `hls` | AAC | `abr_*` | never: adaptive, often 404 (yt-dlp skips it as broken) |
| — | `ctr-`/`cbc-encrypted-hls`, `encrypted-hls` | any | | never: DRM (`NO_STREAM`) |
| — | any | | `snipped: true`, or a `/preview/` URL | never: a 30-second Go+ preview (`PREVIEW_ONLY`) |

MP3 goes first where it is still there because every Telegram client plays it
as music; AAC 160k sounds better than MP3 128k, so swap rows if the `.mp4`
files prove fine everywhere. A stream URL with `/0/30/` in it (a 30-second
playlist) is refused as `PREVIEW_ONLY` before any segment is fetched. A master
playlist (`#EXT-X-STREAM-INF`) is followed to its highest-bandwidth variant.

Which formats tracks really have, seen from the cloud, is in `/sc`'s report
(`📼 …`) and in `downloads.error = 'NO_STREAM'` counts in `/stats`.

The AAC file is named `.mp4`, not `.m4a` (users asked; it is the same
container). Telegram takes it as audio through `sendAudio` — checked from the
cloud on 2026-10-21: the reply carries an `audio` object, so the player, the
buttons and the file_id cache work — and iOS shows its embedded cover once
saved.

### No FLAC

SoundCloud streams no lossless audio: AAC 160k is the best (AAC 256k for Go+
accounts). Turning that into FLAC would make a file ~5× bigger with the same
sound, so the bot doesn't. The one lossless source is the **original upload**,
when its artist allows downloads (`downloadable` + `has_downloads_left` →
`GET /tracks/{id}/download` → `redirectUri`); `downloadOriginal` in
`lib/soundcloud.js` gets it and `originalFormat` names it from its first bytes.
But SoundCloud gives it **only to signed-in users**: from the cloud, with the
anonymous client_id, two such tracks of different artists both answered 401
(`LOGIN_REQUIRED`, 2026-10-21). So there is no "original" button: it would
need a SoundCloud account's OAuth token, the admin's own, to fetch files for
everyone. The probe still tries it (`original` step; `adminProbe { search }`
lists tracks that offer one), so a change on SoundCloud's side would show.

## 4. Limits

| Limit | Value | Where |
|---|---|---|
| Bot API upload | 50 MB per file | `MAX_AUDIO_BYTES` = 49 MB (room for the multipart envelope) |
| Length checked before downloading | 50 min (128 kbps MP3 ≈ 47 MB) | `MAX_DURATION_SECONDS` |
| Thumbnail | JPEG, ≤ 320 px, < 200 KB | `artwork()` asks for `-t300x300`, caps at 200 KB |
| Download stopped as soon as it passes the limit | `content-length` first, then counted while streaming | `download()` → `TOO_BIG` |
| HLS segments fetched at once | 4, joined in playlist order | `PARALLEL` in `lib/soundcloud.js` |

**Seen from the cloud** (first deploy, 2026-10-20):

- `api-v2.soundcloud.com`, the stream URLs and the AAC segments all answer
  Telegram's servers; the scraped client_id works.
- The probe track (Forss — Flickermood, 214 s, `policy: MONETIZE`) lists
  `aac_160k`, `aac_96k` (`audio/mp4; codecs="mp4a.40.2"`) and `abr_sq`
  (`audio/mpegurl`); resolve took 86 ms, downloading `aac_160k` (4.3 MB) 502 ms.
- The first real link (an `on.soundcloud.com` share link) went from the
  message to the uploaded audio in 2.8 s: 3.7 MB of `aac_160k`.

**Not known yet:**

- the longest a handler run may take, and the memory it gets (the whole file
  is held as one `Uint8Array`): long tracks near `MAX_DURATION_SECONDS` are
  untried;
- whether the joined fMP4 `.m4a` plays and seeks well in every Telegram client.

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
| `NO_ORIGINAL` | the artist offers no original upload | most tracks (only the probe asks today) |
| `LOGIN_REQUIRED` | the original needs a signed-in user (401) | every original seen so far, anonymously |
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

1. ~~**First deploy, then `/sc`**~~ — done (§4, *Seen from the cloud*). Still
   to try: a track near 50 minutes.
2. **Playlists and albums** (`NOT_TRACK` today): list the tracks
   (`/resolve` gives the first ~5 in full, the rest as ids →
   `GET /tracks?ids=1,2,3`), then send them one by one with a progress
   message — or as buttons to pick from. Needs a cap per request.
3. **Per-user limits**: N downloads per hour from `downloads`, to stay under
   SoundCloud's rate limits.
4. **Inline mode** (`@bot <search>`): `GET /search/tracks?q=…`, results from
   `tracks` (already on Telegram) as cached audio. New ones can be uploaded to
   the storage channel (`lib/storage.js`, there since 2026-10-21) for a
   file_id; needs `handlers/inline_query.js`, `chosen_inline_result.js`.
5. **Groups**: answer a link when the bot is mentioned or replied to.
6. **Quality / format choice** (buttons under the status message) once the
   formats seen in the cloud are known.
7. **Opus** streams → `sendVoice`/`sendDocument`, if many tracks have only those.
8. **Original uploads (lossless)** — only with a signed-in account (§3, *No
   FLAC*): an admin-set OAuth token used for `/tracks/{id}/download`, sent as
   a document. The admin's call: it uses their account for every user.
