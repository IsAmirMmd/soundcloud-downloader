---
name: telegram-audio
description: Delivering audio from this Telegram Serverless bot — sendAudio with InputFile vs a kept file_id, the `tracks` file_id cache, thumbnails, file names, captions, the ✏️ 🎤 🖼 buttons that re-upload a copy with a new title / artist / cover (sent_audios, lib/metadata.js, ID3 / iTunes tags in lib/tags.js), the "⏳" status message and chat actions, Bot API limits (50 MB upload, 20 MB getFile, 200 KB thumbnail), and handling BotApiError (400 stale file_id, 403 blocked, 429). Use when changing tgcloud/lib/download.js or anything that sends files, adding playlist/album delivery, inline audio results, group replies, or debugging why an audio message wasn't delivered or looks wrong.
---

# Sending audio to Telegram from this bot

The code is `tgcloud/lib/download.js` (links → audio), `tgcloud/lib/audio.js`
(every send) and `tgcloud/lib/metadata.js` + `tgcloud/lib/tags.js` (editing);
the SDK reference is
`docs/tgcloud-sdk.md` (*Telegram Bot API*, *Files*). The SoundCloud side is the
**soundcloud-api** skill.

## The delivery contract (keep it)

1. **Answer the link at once** with a status message ("⏳ …", a reply to the
   link). A download can take many seconds; silence looks broken.
2. **Cache first.** `tracks.file_id` by SoundCloud `track_id`. A hit is sent
   by `file_id` — no SoundCloud request beyond resolve, no upload.
3. **Stale file_id** → `sendAudio` throws `BotApiError` 400: delete the row
   (`forget`) and upload again. Any other error goes up.
4. **Upload** with `new InputFile(bytes, fileName(track, ext), { type })`,
   `title`, `performer`, `duration`, `thumbnail` (optional), HTML `caption`
   with every outside string through `esc()`, and `reply_parameters` with
   `allow_sending_without_reply: true` (the link may have been deleted).
5. **Remember** `sent.audio.file_id` (+ `file_unique_id`, size, format) with
   `INSERT … ON CONFLICT (track_id) DO UPDATE`.
6. **Log every link** in `downloads` (`sent` / `cached` / `failed` + error
   code + ms). `log()` never throws.
7. **Finish the status message**: delete it on success; on failure edit it
   into `ERRORS[code]`. Both `.catch(console.error)` — the user has the audio
   or the reason either way.

8. **Send through `sendAudioMessage`** (`lib/audio.js`), never `api.sendAudio`
   directly: it adds the ✏️ 🎤 🖼 buttons and the `sent_audios` row their
   edits need. A send without a row leaves buttons that only say "too old".

## Editing metadata (✏️ 🎤 🖼)

- Telegram keeps title, performer and thumbnail **with the file**. A file_id
  sent again keeps them (the thumbnail can only come with an upload), so an
  edit is always a **re-upload**: the bytes come from `api.getFileContent`
  (≤ 20 MB), else from SoundCloud again via `sent_audios.permalink_url`.
- The new copy is a new message (a reply to the user's answer), with the
  buttons again and its own `sent_audios` row (`edited = 1`) carrying every
  field forward, so edits add up. The original stays.
- The question is `askFor(user, 'meta:<field>:<row id>:<question id>')`; the
  answer goes through `takePending` → `applyMetaEdit` in `handlers/message.js`.
  ❌ is `meta:cancel` (`cancelPending`). A wrong kind of answer re-asks; a
  SoundCloud link instead of an answer falls through to the download.
- A cover the user sends is a Telegram photo: `cover_file_id` (≤ 1280 px,
  written into the file) and `cover_thumb_id` (≤ 320 px, the thumbnail).
  Without one, SoundCloud's artwork at `t500x500` / `t300x300`.
- `tagAudio` writes the same fields into the file: ID3v2.3 for mp3, iTunes
  `moov/udta/meta/ilst` for m4a — fragmented MP4 only; it returns null (the
  copy goes untagged, Telegram's fields still change) for a layout with
  absolute offsets. It was checked against ffmpeg and mutagen: same decoded
  audio, the new tags read back.
- Only the chat's own user may press (`query.from.id === chat id`).

## Limits

| What | Limit | In code |
|---|---|---|
| Upload through the Bot API | 50 MB per file | `MAX_AUDIO_BYTES` (49 MB) in `lib/config.js` |
| Sending by URL (Telegram downloads it) | 20 MB, Telegram must reach the URL | not used: signed SoundCloud URLs expire and may not answer Telegram |
| `getFile` / `api.getFileContent` | 20 MB | — |
| Thumbnail | JPEG, ≤ 320×320, < 200 KB, uploaded as a new file each time (never a file_id/URL) | `artwork()` asks for `-t300x300`, caps at 200 KB |
| Caption | 1024 characters | short: link + @bot |
| `sendAudio` formats Telegram plays as music | MP3, M4A | other formats → `sendDocument` |
| callback_data | 64 bytes | `<feature>:<action>:<args>` |

A 128 kbps MP3 is ~1 MB/minute; `MAX_DURATION_SECONDS` refuses long tracks
before anything is downloaded.

## Errors from the Bot API

- `BotApiError` has `.code`, `.description`, `.parameters`.
- **400** on `sendAudio` with a file_id → stale cache (above). 400 "message to
  edit not found" / "message can't be deleted" on the status message → ignore.
- **403** → the user blocked the bot: `setBlocked(userId, true)`
  (`lib/users.js`). Rare here (they just wrote), but matters for anything sent
  later (playlists in batches, broadcasts).
- **413 / "Request Entity Too Large"** → the size estimate was wrong: treat as
  TOO_BIG and lower the limit.
- **429** → `parameters.retry_after`: stop the batch; don't sleep inside a
  handler.

## Chat actions and long work

`sendChatAction({ action: 'upload_voice' })` shows "sending audio…" for ~5 s;
send it once before the download. There is no background queue on the
platform: the whole download + upload happens inside one webhook run. For
anything multi-track (playlists), send tracks one by one from the same run
with a cap, or hand the rest to a later run (a cron job via
`.github/workflows/scheduled.yml`, or a button the user presses for the next
batch) — never an unbounded loop.

## Groups and inline mode (roadmap)

- **Groups**: answer only when mentioned or replied to; `reply_parameters` to
  the link; no hint replies to other messages. Rate-limit per chat.
- **Inline** (`@bot <query>`): results must reference audio already on
  Telegram (`InlineQueryResultCachedAudio` with `tracks.file_id`), so new
  tracks are first uploaded to a private storage channel the bot admins (a
  `STORAGE_CHAT_ID` in `config.js`, like the calculator bot's
  `IMAGE_CHAT_ID`). Needs BotFather `/setinline` (and `/setinlinefeedback`
  for counting sends).

## Testing

`test/download.test.mjs` is the shape: `soundcloud({ tracks })` + a
`mockApi('sendAudio', …)` that returns `{ audio: { file_id } }` like Telegram
does (`telegramKeepsAudio()` there), then assert on `take()` (the Bot API
calls in order) and on `tracks` / `downloads` rows. Use
`failNext('sendAudio', 400, 'Bad Request: wrong file identifier…')` for the
stale-cache path. An uploaded file in `take()` is an `InputFile`: `.name`,
`.type`, `.data` (`asText(data)` for the fake bytes).
