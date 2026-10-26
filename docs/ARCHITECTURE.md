# Architecture

How this bot is built, and the conventions every change follows. It comes from
tgcloud-kit (the architecture of a production bot on Telegram Serverless, cut
down to a starting point). The platform's own rules are in `AGENTS.md` and the
SDK reference in `docs/tgcloud-sdk.md`. This file is about *this project's*
structure. Keep it true when the structure changes. How the SoundCloud side
works (client_id, streams, limits, what can go wrong) is in
[docs/SOUNDCLOUD.md](SOUNDCLOUD.md).

## 1. The platform in one paragraph

Telegram Serverless runs the JavaScript modules in `tgcloud/` in a V8 isolate.
There is no server, filesystem, npm packages or env vars at runtime, only the
`sdk` module:
- `db`: SQLite with a query builder;
- `api`: the Bot API;
- `fetch`;
- `InputFile`;
- `EndpointError`.

A file in `handlers/` is named after a Telegram update type and receives that
update's payload. A file in `endpoints/` answers `POST /api/<name>` for the Mini
App. The Mini App's build folder is hosted at `https://app<id>.tgcloud.ai/`. The
`tgcloud` CLI deploys (`push`), migrates the schema (`migrate`) and runs modules
in the cloud (`run`).

## 2. Layout

```
tgcloud/                      ← deployed code; the only code the platform sees
  schema.js                   ← every table, as named exports
  handlers/                   ← one file per update type; thin routers
    message.js                ← /start (+ deep links), /stop, admin commands, pending answers (feedback, ✏️ 🎤 🖼), SoundCloud links, search by name
    callback_query.js         ← inline buttons, routed by callback_data prefix (menu:, feedback, meta:, dl:, sr:, il:)
    inline_query.js           ← `@bot <name>` in any chat → lib/inline.js (BotFather /setinline)
    chosen_inline_result.js   ← an inline result sent → its ⏳ message becomes the audio (BotFather /setinlinefeedback)
    my_chat_member.js         ← the bot blocked/unblocked (private) or added/removed (groups, channels)
  endpoints/                  ← one file per Mini App call; thin: authorize → lib → JSON
    me.js                     ← who is calling (isAdmin)
    sql.js                    ← admin-only raw SQL, used by `npm run sql`
    adminProbe.js             ← admin-only: every step of a SoundCloud download, from the cloud (check.yml, run.yml)
    adminSyncCommands.js      ← admin-only: sets the "/" command menus (deploy.yml, after each deploy)
  lib/                        ← all the logic; one module per feature
    config.js                 ← constants (ADMIN_ID, STORAGE_CHAT_ID, size/duration limits, PROBE_TRACK_URL): no env vars exist
    soundcloud.js             ← SoundCloud api-v2: links, client_id (scraped, kept), resolve, search, streams, download
    download.js               ← the bot's job: link / search result → status → audio (file_id cache in `tracks`), `downloads` log, stats
    search.js                 ← a name in the bot → results as buttons (dl:<track>), ◀️ ▶️ pages (sr:<search>:<offset>), `searches`
    inline.js                 ← inline mode: kept tracks as cached audio, others as a ⏳ message filled by editMessageMedia (il:<track>)
    audio.js                  ← every audio message: sendAudio + caption + ✏️ 🎤 🖼 buttons + its `sent_audios` row, file names
    metadata.js               ← ✏️ 🎤 🖼: ask, take the answer, send a copy with the new title / artist / cover
    tags.js                   ← title, artist, cover written into the file: ID3v2.3 (mp3), iTunes ilst (fragmented mp4)
    storage.js                ← the storage channel: every track uploaded there once, users get its file_id; admin warned if it fails
    probe.js                  ← /sc and adminProbe: is SoundCloud usable from Telegram's servers, step by step
    settings.js               ← key/value table: secrets, drafts, flags (and the SoundCloud client_id)
    users.js                  ← users table: /start tracking, blocked, /stop, pending_action
    access.js                 ← callerId / isAdmin / requireAdmin / forbidden() for endpoints
    admin.js                  ← bodies of the admin commands (/stats, /backup, /setclientid, /setcommands)
    menu.js                   ← the /start menu as screens (menu:<screen>): home and help
    bot.js                    ← the bot's @username (getMe, kept)
    query.js                  ← pagination, search, ORDER BY, WHERE helpers for list endpoints
    html.js                   ← esc(), link(), fa(), clock() for parse_mode HTML texts
    time.js                   ← now(), DAY, local time with a fixed UTC offset
    files.js                  ← CSV / XLSX / UTF-8 without npm packages
src/                          ← the Mini App (React + Vite), if there is one; talks to endpoints only
test/                         ← offline tests: the real modules on a mock SDK (node:sqlite)
scripts/sql.mjs               ← `npm run sql -- "SELECT …"`
.github/workflows/
  deploy.yml                  ← push to main → npm test, build, push, migrate --safe, webhook sync, "/" commands
  check.yml                   ← other branches / PRs → npm test, then endpoints/adminProbe in the cloud (no deploy)
  run.yml                     ← by hand: run one module in the cloud as the admin (e.g. endpoints/adminProbe)
  scheduled.yml               ← cron → `tgcloud run handlers/message '{ text: "/backup", … }'`
.claude/skills/               ← this project's skills for Claude Code (soundcloud-api, telegram-audio, bot-feature)
docs/ARCHITECTURE.md          ← this file
docs/SOUNDCLOUD.md            ← how a link becomes an audio message; limits, risks, roadmap
AGENTS.md, docs/tgcloud-sdk.md← platform rules + SDK reference (from `tgcloud init`)
tgcloud.jsonc                 ← "static": the Mini App's build folder
.tgcloud/                     ← CLI state + credentials; gitignored; never read or edit
```

## 3. Layers and the dependency rule

```
Telegram ──webhook──▶ handlers/<update>.js ─┐
Mini App ──/api/x───▶ endpoints/x.js ───────┼──▶ lib/<feature>.js ──▶ schema.js, sdk (db, api, fetch)
cron / terminal ─tgcloud run─▶ handlers/message.js or endpoints/x.js ─┘
```

- **handlers/** and **endpoints/** are entry points. They parse, route,
  authorize and answer. Logic lives in `lib/`, so a bot command, a Mini App
  button and a scheduled job can share one function. For example,
  `userStats()` serves both `/stats` and `endpoints/adminStats.js`.
- **lib/** never imports from `handlers/` or `endpoints/`. If two lib modules
  need each other, move the shared part into a third module. Import cycles
  break silently at load time.
- **The front-end** (`src/`) never imports from `tgcloud/`. It reaches the server
  only through endpoints (`callEndpoint` / `useEndpoint`).
- Imports: relative with `.js` (`'../lib/users.js'`), the SDK by name (`'sdk'`,
  `'sdk/db'`). Nothing outside `tgcloud/` is reachable.

## 4. The four ways code runs

| Trigger | Path | Caller identity |
|---|---|---|
| Telegram update | webhook → `handlers/<type>.js` default export `(payload, ctx)`; full update in `ctx.update` | `payload.from` (from Telegram) |
| Mini App call | `Telegram.WebApp.Serverless.call(name, input)` → `/api/<name>` → `endpoints/<name>.js` `(input, ctx)` | `ctx.initData.user` (verified by the platform; bad init data → 401) |
| Scheduled job | GitHub Actions cron → `npx tgcloud run handlers/message '{ text: "/cmd", from: { id: ADMIN_ID }, chat: { id: ADMIN_ID, type: "private" } }'` | the admin, as configured in the workflow |
| Terminal | `npm run sql`, `npx tgcloud run endpoints/x '{…}' --ctx '{…}'` | whatever `--ctx` says (not verified: logic tests only) |

There is no scheduler on the platform. Every periodic job is an admin command
plus a workflow. A job therefore also works by hand: send the command, or
"Run workflow" in GitHub.

## 5. Conventions

### Routing

- **`handlers/message.js`** checks, in this order:
  1. payments (`successful_payment`);
  2. `/start` (track the user, then the deep-link payload, then the menu);
  3. `/stop`;
  4. admin commands;
  5. public commands;
  6. the answer to a pending question (`feedback`; `meta:…` from ✏️ 🎤 🖼 →
     `applyMetaEdit`, which lets a SoundCloud link through to step 7);
  7. a SoundCloud link in a private chat (`replyDownload`, lib/download.js);
  8. other text in a private chat is a search (`replySearch`, lib/search.js);
     shorter than 2 characters, or a caption without text, gets a one-line hint;
  9. everything else (unknown commands, groups) is ignored, with no reply.
- **callback_data** is `<feature>:<action>[:<args>]`, at most 64 bytes, for
  example `menu:help` or `wk:pub:-1001234`. Each lib module exports
  `handleXCallback(query)`, which returns `true` when the button was one of
  its own. `callback_query.js` tries them in turn.
  - Always `answerCallbackQuery`, and make it a toast rather than an alert,
    unless the user must read it.
  - Check `query.from.id` before acting. A button can be pressed by anyone
    who sees it.
- **Deep links** look like `t.me/<bot>?start=<prefix>_<args>`. The payload is
  at most 64 characters, `[A-Za-z0-9_-]`. `startPayload()` in `message.js`
  routes them by prefix. The first payload a user ever came with is kept in
  `users.start_param` for attribution.
- **Multi-step input**: `askFor(user, 'action:args')` stores
  `users.pending_action`. The next private message is read by `takePending()`,
  which clears the action and expires it after 15 minutes. Call `takePending()`
  last, so commands still work while a question is pending.

### Admin commands

`adminCommand(message, text)` in `message.js` maps each command to a promise
from `lib/admin.js`, or to a feature module. A failure goes to the admin as
`⚠️ Command failed: …`. Without that message a failure is silent, because logs
are visible only through `tgcloud run`.

The `/` suggestions come from `setMyCommands` (`syncCommands()` in
`lib/admin.js`). The deploy runs it after every push to main
(`endpoints/adminSyncCommands.js`), and the admin's `/start` runs it too:
the admin's own list can be set only once they have a chat with the bot.
`/setcommands` does the same by hand.

### State and configuration

- Constants go in `lib/config.js`.
- Secrets (API keys) go in the `settings` table, set by an admin command that
  deletes the admin's message.
- Per-user state goes in `users`. Per-feature state goes in its own table.
- Nothing is kept in module-level variables between updates, except caches
  that are safe to lose (e.g. `getMe`).

### Texts

- `parse_mode: 'HTML'`, with every user-provided string passed through `esc()`.
- Numbers go through `fa()` (Persian digits).
- User-facing copy is in the bot's language. Admin-only messages may be
  English.
- Wrap usernames in `<bdi>` in the RTL UI.

### Errors

- **Handlers:**
  - Expect `BotApiError`. A 403 means the user blocked the bot: call
    `setBlocked`.
  - A 400 "message is not modified" is harmless. Ignore it.
  - A 429 has `parameters.retry_after`. Stop the batch and continue on the
    next run.
  - A handler must never throw on tracking code (`trackStart` catches).
- **Endpoints:**
  - Refuse with `EndpointError(message, { code })`. The message is shown to
    the user, and `code` lets the UI branch.
  - Anything else becomes a generic 500.

### Time

- Store unix seconds (`unixepoch()` in SQL, `now()` in JS).
- Display with the fixed UTC offset in `config.js`. The runtime may lack Intl
  timezone data.

### Naming

| Kind | Rule | Examples |
|---|---|---|
| Tables, columns | `snake_case` | `users`, `start_param` |
| Endpoints | camelCase, prefixed by audience | `me`, `adminUsers`, `ownerX` |
| lib modules | named by feature | `lib/broadcast.js` |
| Telegram chat ids of channels/groups | stored as TEXT | `-100…` ids were mangled by CSV exports |

## 6. Database rules

- **Every call is async.** `await` it.
- **No foreign keys**, so integrity lives in lib code. Delete children before
  parents.
- **One row per (x, y)**: use a `uniqueIndex` in `schema.js` plus
  `INSERT … ON CONFLICT (x, y) DO UPDATE`.
- **Migrations are additive.**
  - A new column on an existing table is **nullable or has a default**, so
    `migrate --safe` (in CI) always applies it. Read it as `coalesce(col, 0)`.
  - Dropping happens only through `.deprecated('reason')`. Deleting the
    declaration drops nothing.
  - Type changes are done by hand with `db.run`.
- **Raw SQL** (`db.all/get/run` with `` sql`…` ``) returns raw values: booleans as
  0/1, JSON as strings, and aggregates possibly as strings. Convert them with
  `Number()` and `=== 1` before returning. Only the table-bound builder
  converts.
- **Batch inserts**: about 50 rows per statement, because SQLite limits bound
  variables.
- **Composable SQL**: `` sql`…` `` fragments nest. Use `whereOf([...])` and
  `searchCondition` from `lib/query.js`. Values always go in `${}`; column
  names come only from code (`sql.raw`).

## 7. Security

- An endpoint trusts only `ctx.initData.user.id`. **Every** Mini App user can call
  **every** endpoint, so authorize inside each one:
  - `requireAdmin(ctx)`, or
  - a membership lookup (tgcloud-growth → multi-tenant).

  Never take a user id, role or price from `input`.
- `callback_data` and deep-link payloads come from the client. Re-check them
  against the DB.
- `endpoints/sql.js` is admin-only. Backups leave out `settings`, which holds
  secrets.
- The CLI token (`TGCLOUD_TOKEN`) lives only in `.tgcloud/` (gitignored) and in
  the repository secret. Never put it in code, docs or chat.

## 8. Testing

`npm test` runs `test/*.test.mjs` with Node's test runner. `test/sdk/` maps
`sdk` and `sdk/db` to local stand-ins:
- an in-memory node:sqlite database built from `schema.js`;
- an `api` that records calls instead of sending them;
- `failNext(method, code, description)` to simulate Bot API errors;
- `mockApi(method, fn)` to fake return values.

`helpers.mjs` builds updates for the tests: `msg`, `groupMsg`, `press`,
`membership` and `ctxOf`. `soundcloud({ tracks, short, down })` routes every
`fetch` to a fake soundcloud.com, api-v2 and media CDN, and `scTrack(id, …)`
builds a track as api-v2 returns it (stream formats, policy, length). Nothing
in `npm test` touches the network.

Every feature gets tests for:
- the happy path;
- a refused caller;
- a Bot API failure, when it matters.

The mock covers the common SDK surface. When it disagrees with the cloud, the
cloud is right. Check against the real DB and Bot API without deploying, using
`npx tgcloud run handlers/message '{ … }'` or
`npx tgcloud run endpoints/x '{…}' --ctx '{ initData: { user: { id: 1 } } }'`.

## 9. Deploy pipeline

`main` is what runs, and the work happens on it directly (one developer).
`deploy.yml` runs on every push to main that touches `tgcloud/`, `test/` or the
front-end:
1. `npm ci`, then `npm test`: when a test fails, nothing is deployed.
2. `npm run build --if-present` (the Mini App)
3. `tgcloud fetch` and `tgcloud push` (`fetch` first, because a fresh checkout
   has no snapshot)
4. `tgcloud migrate --safe`, as its **own `always()` step**. A push can deploy
   the code and then fail while writing the CLI's local snapshot, and the
   schema must not stay behind the code.
5. `tgcloud webhook sync`, `always()`. The update types the bot receives
   come from `handlers/`, and a half-failed push may not have refreshed them.
6. `endpoints/adminSyncCommands`, `always()`: the `/` menus.

Setup, once:
- In BotFather, open the bot, then **Serverless → CLI Access → Access token**.
  Store the token as the repository secret **`TGCLOUD_TOKEN`**. Without it the
  workflows do nothing.
- After the first deploy:
  - run `npx tgcloud migrate` (or let CI do it);
  - the admin sends `/start` once (the deploy sets the `/` menus, but the
    admin's own list needs that chat), then `/sc` to check SoundCloud;
  - set the Mini App URL in BotFather (if there is a Mini App).

Destructive schema changes, anything `--safe` skips, are applied by hand with
`npx tgcloud migrate`.

## 10. Adding a feature

1. **Schema**: new table(s) in `schema.js`. New columns on old tables must be
   nullable.
2. **Logic**: `lib/<feature>.js`. It holds the queries, the Bot API calls and
   `handleFeatureCallback(query)` when it has buttons.
3. **Entry points**:
   - one line in `adminCommand()` or the public command list;
   - a prefix in `callback_query.js`;
   - a thin `endpoints/<name>.js` for the Mini App.
4. **Tests**: `test/<feature>.test.mjs`. Then `npm test`.
5. **Check in the cloud** when SoundCloud or the Bot API's real behavior
   matters: Actions → Run in cloud, or `npx tgcloud run endpoints/adminProbe …`.
6. **Ship**: commit and push to main. The deploy also re-sends the `/` command lists.

Bigger building blocks are in the tgcloud-growth skill. Each comes with
schema, lib code and the lessons learned in production:
- multi-tenant bots (channels or groups, each with its managers and viewers);
- Telegram Stars payments and subscriptions;
- deep-link and invite-link attribution;
- join tracking (`chat_member`);
- referrals;
- weekly digests;
- segmented broadcasts.

## 11. Lessons learned (each cost a bug)

- **Admin commands fail silently** unless the error is sent to the admin.
- **The first `/start` of someone who already has a row** (e.g. they pressed a
  channel button first) must still record its payload. That is why
  `start_param` uses `CASE WHEN start_count = 0`.
- **Two lib modules importing each other** (`dashboard` ↔ `growth`) broke at
  load time. Split the shared helpers into a third module.
- **Channel ids exported to CSV** came back in scientific notation. Store them
  as TEXT and validate them on import.
- **The CLI can crash after a successful push**, so migrate and webhook sync
  run as separate `always()` steps.
- **Telegram doesn't show new `/` commands** until `setMyCommands` runs again.
- **Hosts that answer you may not answer the bot.** The calculator bot this
  project follows found Iranian exchanges unreachable from Telegram's servers.
  Every outside service is checked from the cloud (`adminProbe`) before a
  feature relies on it.
- **Invite links need the bot's "Add subscribers" admin right.**
  `chat_member` updates need the bot to be an admin and `chat_member` in the
  webhook's allowed updates. Deploying `handlers/chat_member.js` adds it.
- **Broadcasts must stop on 429 and resume from a cursor.** They must also
  mark 403 / "chat not found" users as blocked, and carry an opt-out (`/stop`).
