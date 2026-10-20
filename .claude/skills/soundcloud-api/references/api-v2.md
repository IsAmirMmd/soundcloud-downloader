# api-v2 shapes used (and about to be used) by the bot

Unofficial: this is what soundcloud.com's own player sends and receives. Every
request carries `client_id=<32 chars>`; fields not listed are ignored. When the
cloud's probe shows something different, the probe is right — update this file.

## The client_id on soundcloud.com

```html
<script>window.__sc_hydration = [
  {"hydratable":"anonymousId","data":"…"},
  {"hydratable":"apiClient","data":{"id":"<client_id>","isExpiring":false}},
  …
];</script>
<script crossorigin src="https://a-v2.sndcdn.com/assets/0-xxxxxxxx.js"></script>
…
<script crossorigin src="https://a-v2.sndcdn.com/assets/49-xxxxxxxx.js"></script>
```

In a bundle: `…{client_id:"<client_id>",…}` or `…?client_id=<client_id>&…`.

## GET /resolve?url=<soundcloud.com link>

A track (`kind: "track"`):

```json
{
  "kind": "track",
  "id": 293,
  "title": "Flickermood",
  "permalink_url": "https://soundcloud.com/forss/flickermood",
  "duration": 213000,
  "full_duration": 213000,
  "artwork_url": "https://i1.sndcdn.com/artworks-000000000293-abcdef-large.jpg",
  "user": { "id": 183, "username": "Forss", "avatar_url": "https://i1.sndcdn.com/avatars-…-large.jpg" },
  "publisher_metadata": { "artist": "Forss" },
  "policy": "ALLOW",
  "monetization_model": "NOT_APPLICABLE",
  "streamable": true,
  "downloadable": false,
  "track_authorization": "eyJ0eXAiOi…",
  "media": {
    "transcodings": [
      {
        "url": "https://api-v2.soundcloud.com/media/soundcloud:tracks:293/<uuid>/stream/hls",
        "preset": "aac_160k",
        "duration": 213000,
        "snipped": false,
        "format": { "protocol": "hls", "mime_type": "audio/mp4; codecs=\"mp4a.40.2\"" },
        "quality": "sq"
      },
      {
        "url": "https://api-v2.soundcloud.com/media/soundcloud:tracks:293/<uuid>/stream/hls",
        "preset": "aac_96k",
        "snipped": false,
        "format": { "protocol": "hls", "mime_type": "audio/mp4; codecs=\"mp4a.40.2\"" },
        "quality": "sq"
      },
      {
        "url": "…/stream/hls",
        "preset": "abr_sq",
        "format": { "protocol": "hls", "mime_type": "audio/mp4; codecs=\"mp4a.40.2\"" }
      }
    ]
  }
}
```

That is a track of today (October 2026). SoundCloud is moving every track to
AAC ([soundcloud/api#441](https://github.com/soundcloud/api/issues/441)):
- progressive MP3 (`"protocol": "progressive"`, `audio/mpeg`) was removed on
  2026-08-12;
- HLS MP3 (`"preset": "mp3_…"`, `"protocol": "hls"`, `audio/mpeg`) stays on
  tracks not converted yet, some for up to a year;
- Opus HLS is gone;
- `abr_sq` is adaptive and often 404s: never use it (yt-dlp skips it too);
- DRM variants carry `"protocol": "ctr-encrypted-hls"` / `"cbc-encrypted-hls"`
  (or `encrypted-hls`).
- `"quality": "hq"` (AAC 256k) only appears for Go+ subscribers' tokens.

- `duration` is the playable length (30 000 for a Go+ preview);
  `full_duration` the real one. Both in milliseconds.
- `policy`: `ALLOW` / `MONETIZE` (playable), `SNIP` (Go+ — 30 s preview,
  transcodings `snipped: true`), `BLOCK` (not available in the requester's
  country, or removed).
- `artwork_url` may be null → `user.avatar_url`. Sizes by suffix: `-large`
  (100×100), `-t300x300`, `-t500x500`, `-original`.
- A private track resolves only from its secret link
  (`…/<track>/s-<secret>`), and then carries a `secret_token`.

A playlist / album (`kind: "playlist"`): `id`, `title`, `track_count`,
`set_type` (`album`, `ep`, `""`), `tracks: [ … ]` — the first ~5 complete, the
rest only `{ "id": 123, "kind": "track", "policy": … }`.

A profile: `kind: "user"`.

## GET <transcoding.url>?client_id=…&track_authorization=…

```json
{ "url": "https://cf-media.sndcdn.com/AbCd.128.mp3?Policy=…&Signature=…&Key-Pair-Id=…" }
```

For `hls`: AAC playlists on `https://playback.media-streaming.soundcloud.cloud/…`,
MP3 ones on `https://cf-hls-media.sndcdn.com/playlist/…/playlist.m3u8?Policy=…`
(the code assumes no host). The URL is signed and expires within minutes. A
URL with `/preview/0/30/` or `/playlist/0/30/` is the 30-second preview.

For a private track add `secret_token=s-…` (the last segment of its secret
link, or the track's `secret_token`), or the request 404s.

## The HLS media playlist

```
#EXTM3U
#EXT-X-VERSION:6
#EXT-X-TARGETDURATION:10
#EXT-X-MAP:URI="https://…/init.mp4"          ← AAC (fMP4): init first, then .m4s segments
#EXTINF:9.98,
https://cf-hls-media.sndcdn.com/media/0/159960/AbCd.128.mp3?Policy=…
#EXTINF:9.98,
https://cf-hls-media.sndcdn.com/media/159960/319920/AbCd.128.mp3?Policy=…
…
#EXT-X-ENDLIST
```

Encrypted variants add `#EXT-X-KEY:METHOD=SAMPLE-AES,…` (or `AES-128`) — not
usable. Segment URIs may be absolute, root-relative or relative to the
playlist (`parseM3u8` handles all three).

## Not used yet

| Call | For |
|---|---|
| `GET /tracks?ids=1,2,3` | filling a playlist's incomplete tracks (≤ 50 ids) |
| `GET /search/tracks?q=…&limit=10&offset=0` | inline search → `{ collection, next_href, total_results }` |
| `GET /tracks/<id>` | a track by id |
| `GET /playlists/<id>` | a playlist by id |

## Status codes

| Status | Usually | Code in the bot |
|---|---|---|
| 401 | client_id expired / wrong | re-scrape once, then UNREACHABLE |
| 403 | client_id refused, or geo-blocked media | re-scrape once, then BLOCKED |
| 404 | no such link / private without secret | NOT_FOUND |
| 429 | rate limited (per IP / client_id) | RATE_LIMITED |
| 5xx | SoundCloud trouble | UNREACHABLE |
