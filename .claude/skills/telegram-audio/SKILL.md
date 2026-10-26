---
name: telegram-audio
description: Delivering audio from this Telegram Serverless bot — sendAudio with InputFile vs a kept file_id, the `tracks` file_id cache, thumbnails, file names, captions, the ✏️ 🎤 🖼 buttons that re-upload a copy with a new title / artist / cover (sent_audios, lib/metadata.js, ID3 / iTunes tags in lib/tags.js), the "⏳" status message and chat actions, Bot API limits (50 MB upload, 20 MB getFile, 200 KB thumbnail), and handling BotApiError (400 stale file_id, 403 blocked, 429). Use when changing tgcloud/lib/download.js or anything that sends files, adding playlist/album delivery, changing inline mode (lib/inline.js), group replies, or debugging why an audio message wasn't delivered or looks wrong.
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
   by `file_id` — no SoundCloud request beyond resolve, no upload. A hit
   without `storage_message_id` is then posted to the storage channel by
   that file_id (`archive`, never throws).
2b. **Upload once, into the storage channel** (`storeTrack`,
   `lib/storage.js`, `STORAGE_CHAT_ID`): the post's caption has name,
   artist, link and `#t<id>`, no buttons; the user then gets the post's
   `file_id`. A refused channel post returns null: upload straight to the
   user instead, and the admin is warned at most once an hour
   (`storage:warned_at` in settings). Edited copies never go there.
3. **Stale file_id** → `sendAudio` throws `BotApiError` 400: delete the row
   (`forget`) and upload again. Any other error goes up.
4. **Tag, then upload.** `withTags` (`lib/audio.js`) writes title, artist and
   the 500 px cover into the bytes first: the `thumbnail` is Telegram's own,
   and a file saved to Files or a music app shows only what is inside it
   (a user saw no cover on iOS until the tags went in). Then
   `new InputFile(bytes, fileName(track, ext), { type })`, `title`,
   `performer`, `duration`, `thumbnail` (300 px), HTML `caption` with every
   outside string through `esc()`, and `reply_parameters` with
   `allow_sending_without_reply: true` (the link may have been deleted).
5. **Remember** `sent.audio.file_id` (+ `file_unique_id`, size, format,
   `tags_version`) with `INSERT … ON CONFLICT (track_id) DO UPDATE`. A kept
   file_id older than `FILE_VERSION` (`lib/download.js`) is not reused: the
   track is uploaded again once. Bump `FILE_VERSION` whenever what goes into
   a file changes.
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
  `moov/udta/meta/ilst` for mp4 (AAC files are named .mp4; old rows say
  m4a) — fragmented MP4 only; it returns null (the
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

## Inline mode (lib/inline.js)

- `@bot <name>` → `answerInline`: a track with a current `tracks.file_id`
  (`keptFiles`, `FILE_VERSION` checked) is an `InlineQueryResultCachedAudio`;
  any other is an article ("🎵 Title / 🎤 Artist") with a ⏳ button
  `il:<id>`. The button is what gives the sent message an
  `inline_message_id`; without one it could never be edited.
- **An inline message takes no upload** (`editMessageMedia` with an
  inline_message_id accepts a file_id or URL only), so `storedFile(track)`
  downloads the track into the storage channel first and fills the message
  with the post's file_id. No channel → `NO_STORAGE`: the message says to
  send the link to the bot.
- Filled on `chosen_inline_result` (BotFather `/setinlinefeedback`) or when
  ⏳ is pressed; a second fill is "message is not modified", ignored. A kept
  file_id Telegram refuses (400) → `forgetFile`, upload again once.
- No ✏️ 🎤 🖼 on inline audio and no `sent_audios` row: the message is in
  someone else's chat. Every fill is logged in `downloads` with
  `via = 'inline'`.
- `answerInlineQuery` 400 "query is too old" → ignored (the user typed on).

## Groups (roadmap)

- Answer only when mentioned or replied to; `reply_parameters` to the link;
  no hint replies to other messages. Rate-limit per chat.

## Testing

`test/download.test.mjs` is the shape: `soundcloud({ tracks })` + a
`mockApi('sendAudio', …)` that returns `{ audio: { file_id } }` like Telegram
does (`telegramKeepsAudio()` there), then assert on `take()` (the Bot API
calls in order) and on `tracks` / `downloads` rows. Use
`failNext('sendAudio', 400, 'Bad Request: wrong file identifier…')` for the
stale-cache path. An uploaded file in `take()` is an `InputFile`: `.name`,
`.type`, `.data` (`asText(data)` for the fake bytes).
