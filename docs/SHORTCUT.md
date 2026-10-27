# Searching from an iPhone Shortcut

## Why not the bot's endpoints

The bot's endpoints (`tgcloud/endpoints/*`, i.e. `POST https://app<id>.tgcloud.ai/api/<name>`)
are run by Telegram's platform only when the request carries **init data
signed by Telegram**. That signature is made only inside the bot's Mini App,
opened in Telegram. A Shortcut doesn't have it, so every request it makes is
answered `401` before the bot's code runs. tgcloud has no other public API.
The only other way in is the CLI's management API, which takes the token that
can deploy code and change the database; that token must not go on a phone.

So the Shortcut searches SoundCloud's API **itself** (what
`lib/soundcloud.js` does) and hands the chosen track to the bot with a link:

```
Shortcut ── GET soundcloud.com ────────────▶ client_id (from the page's HTML)
         ── GET api-v2 /search/tracks ─────▶ the results, JSON
         ── Choose from List
         ── Open URL tg://resolve?domain=SoundCoudMusicBot&start=t_<id>
Bot      ◀─ /start t_<id> ──▶ the same path as a pressed search result: ⏳ → storage channel → audio with ✏️ 🎤 🖼
```

No token or secret is on the phone. The `client_id` is public: every visitor
of soundcloud.com gets it.

## 1. Get the client_id

```
GET https://soundcloud.com/
User-Agent: Shortcuts/3 CFNetwork/1568.100.1 Darwin/24.0.0
```

No body. Find this regex in the HTML; group 1 is the `client_id`
(32 letters and digits):

```
"apiClient","data":\{"id":"([a-zA-Z0-9]{32})"
```

> **Always send this User-Agent header.** From Telegram's servers
> (2026-10-27), this User-Agent got a 74 KB page with the `client_id`; the
> iPhone Safari User-Agent got a 56 KB mobile page without it. The
> `client_id` changes every few weeks; the Shortcut fetches a fresh one on
> every run.

## 2. Search

```
GET https://api-v2.soundcloud.com/search/tracks?q=cry%20for%20me&limit=10&client_id=<client_id>
```

No body. `q` must be URL-encoded (the **URL Encode** action). `limit` is the
number of results (SoundCloud sometimes returns one more), `offset` the start
of a later page.

### Sample response

The real response to this request from Telegram's servers, 2026-10-27, with
`limit=2`, shortened: each track has about 70 fields and only the useful ones
are kept here; SoundCloud also returned a third track, removed; the second
track had six `transcodings`, all encrypted, of which two are kept.
`track_authorization` and `media.transcodings[].url` are removed too (the
Shortcut doesn't need them).

```json
{
  "collection": [
    {
      "kind": "track",
      "id": 1952913243,
      "title": "Ironmouse & Bubi - Cry For Me (WA WA WA) [Prod. Shirobeats & HalaCG]",
      "user": { "username": "shirobeats", "permalink_url": "https://soundcloud.com/shiro-beats" },
      "publisher_metadata": { "artist": "Ironmouse & Shirobeats & HalaCG" },
      "full_duration": 160679,
      "duration": 160691,
      "permalink_url": "https://soundcloud.com/shiro-beats/cry-for-me-wa-wa-wa-mix-4-wav",
      "artwork_url": "https://i1.sndcdn.com/artworks-DMZmJxpZrWxDqLfP-lrb91Q-large.jpg",
      "genre": "",
      "playback_count": 1905944,
      "likes_count": 32541,
      "policy": "MONETIZE",
      "media": {
        "transcodings": [
          { "preset": "aac_160k", "snipped": false, "format": { "protocol": "hls", "mime_type": "audio/mp4; codecs=\"mp4a.40.2\"" } },
          { "preset": "aac_96k",  "snipped": false, "format": { "protocol": "hls", "mime_type": "audio/mp4; codecs=\"mp4a.40.2\"" } },
          { "preset": "abr_sq",   "snipped": false, "format": { "protocol": "hls", "mime_type": "audio/mpegurl" } }
        ]
      }
    },
    {
      "kind": "track",
      "id": 2022483977,
      "title": "Cry For Me",
      "user": { "username": "The Weeknd", "permalink_url": "https://soundcloud.com/theweeknd" },
      "publisher_metadata": { "artist": "The Weeknd", "album_title": "Hurry Up Tomorrow" },
      "full_duration": 224183,
      "duration": 224183,
      "permalink_url": "https://soundcloud.com/theweeknd/cry-for-me",
      "artwork_url": "https://i1.sndcdn.com/artworks-H81byShFoRAy-0-large.jpg",
      "genre": "R & B",
      "label_name": "XO / Republic Records",
      "playback_count": 3968514,
      "likes_count": 94986,
      "policy": "MONETIZE",
      "media": {
        "transcodings": [
          { "preset": "aac_160k", "snipped": false, "format": { "protocol": "cbc-encrypted-hls", "mime_type": "audio/mp4; codecs=\"mp4a.40.2\"" } },
          { "preset": "aac_160k", "snipped": false, "format": { "protocol": "ctr-encrypted-hls", "mime_type": "audio/mp4; codecs=\"mp4a.40.2\"" } }
        ]
      }
    }
  ],
  "total_results": 377338,
  "next_href": "https://api-v2.soundcloud.com/search/tracks?query_urn=soundcloud%3Asearch%3A2b7e44a20e96406b8adeb41a7bb67d46&limit=2&offset=2&q=cry%20for%20me",
  "query_urn": "soundcloud:search:2b7e44a20e96406b8adeb41a7bb67d46"
}
```

| Field | Meaning |
|---|---|
| `collection[].id` | The track's id; what is handed to the bot (`t_<id>`) |
| `title` | The track's name |
| `publisher_metadata.artist` | The artist, when the publisher set one; otherwise `user.username` |
| `full_duration` | Length in **milliseconds** (160679 ≈ 2:40) |
| `artwork_url` | The 100×100 cover; replace `-large` with `-t500x500` for a bigger one |
| `permalink_url` | The track's page on SoundCloud |
| `policy` | `BLOCK`: not available · `SNIP`: Go+ preview only · anything else plays |
| `media.transcodings[].format.protocol` | `hls` or `progressive`: the bot can download it. Only `cbc-encrypted-hls` / `ctr-encrypted-hls`: encrypted (DRM), like The Weeknd's Cry For Me; the bot answers with its 🔒 message |
| `next_href` | The next page; append `&client_id=<client_id>` to call it. `null`: the last page |

Errors: `401` or `403` means the `client_id` expired (get a new one, step 1).
`429` means SoundCloud has had too many requests; wait a little.

## 3. Hand the track to the bot

```
tg://resolve?domain=SoundCoudMusicBot&start=t_2022483977
```

(Or `https://t.me/SoundCoudMusicBot?start=t_2022483977`; `tg://` opens
Telegram directly, without going through Safari.) `SoundCoudMusicBot` is the
bot's username (@SoundCoudMusicBot) without the @. Telegram opens the bot's
chat and sends
`/start t_2022483977`; if it shows a **Start** button, tap it. The bot does
what it does for a pressed search result: "⏳", then the audio with the
✏️ 🎤 🖼 buttons. A track that can't be downloaded gets the reason. `/stats`
counts these as "t_ deep link".

## 4. Building the Shortcut

Each action takes the previous one's output unless a variable is named.

1. **Ask for Input**: type Text, prompt "Song name?".
2. **URL Encode** (Encode) ← the provided input. **Set Variable** `query`.
3. **Get Contents of URL**: `https://soundcloud.com/`, Method: GET, Headers:
   `User-Agent` = `Shortcuts/3 CFNetwork/1568.100.1 Darwin/24.0.0`.
4. **Match Text**: pattern `"apiClient","data":\{"id":"([a-zA-Z0-9]{32})"` in step 3's output.
5. **Get Group from Matched Text**: Group At Index `1`. **Set Variable** `clientId`.
   (Optional: **If** `clientId` **does not have any value** → **Show Alert**
   "No client_id found" and **Stop This Shortcut**.)
6. **Text**: `https://api-v2.soundcloud.com/search/tracks?q=` `query`
   `&limit=10&client_id=` `clientId` (no spaces, one after another).
7. **Get Contents of URL** ← that text (GET). The JSON response becomes a Dictionary by itself.
8. **Get Dictionary Value**: Value for `collection`.
9. **Repeat with Each** item:
   1. **Get Dictionary Value** `title` from Repeat Item → **Set Variable** `title`.
   2. **Get Dictionary Value** `user` from Repeat Item, then **Get Dictionary Value** `username` → **Set Variable** `artist`.
   3. **Get Dictionary Value** `id` from Repeat Item → **Set Variable** `id`.
   4. **Text**: `title` ` — ` `artist` ` · #` `id`
   5. **Add to Variable** `results`.
10. **Choose from List** ← `results`.
11. **Match Text**: pattern `#(\d+)$` in the chosen item, then **Get Group from Matched Text** Group At Index `1`.
12. **Open URLs**: `tg://resolve?domain=SoundCoudMusicBot&start=t_` + step 11's output.

The `#<id>` at the end of each choice is there to find the id again after the
pick. The results are collected in a list, so they show in SoundCloud's order.

**Optional, hiding encrypted tracks:** inside step 9, before Add to Variable:
**Get Dictionary Value** `media` → **Get Dictionary Value** `transcodings` →
**Repeat with Each** → **Get Dictionary Value** `format` → **Get Dictionary
Value** `protocol` → **If** is `hls` → **Set Variable** `ok` = `1`. After this
inner Repeat: **If** `ok` is `1` → Add to Variable, then clear `ok`. Without
this, the bot still refuses an encrypted track with its 🔒 message.

## 5. Testing from a computer

```
UA='Shortcuts/3 CFNetwork/1568.100.1 Darwin/24.0.0'
ID=$(curl -s -A "$UA" https://soundcloud.com/ | grep -oE '"apiClient","data":\{"id":"[a-zA-Z0-9]{32}"' | grep -oE '[a-zA-Z0-9]{32}')
curl -s -A "$UA" "https://api-v2.soundcloud.com/search/tracks?q=cry%20for%20me&limit=10&client_id=$ID" \
  | jq '.collection[] | {id, title, artist: (.publisher_metadata.artist // .user.username), seconds: (.full_duration / 1000 | floor), protocols: [.media.transcodings[].format.protocol] | unique}'
```

## Checking it from Telegram's servers

The same path (the page with the Shortcut's regex and both User-Agents, then
the search and its raw JSON), from where the bot runs:

```
Actions → Run in cloud → endpoints/adminProbe → { q: "cry for me", shortcut: true, limit: 2 }
```
