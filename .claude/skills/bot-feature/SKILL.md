---
name: bot-feature
description: How a change is made and shipped in this SoundCloud downloader bot (Telegram Serverless / tgcloud) — where the code goes (schema → lib → thin handler/endpoint), the offline tests on the fake SoundCloud, checking against the real SoundCloud from the cloud, then committing and pushing to main, which deploys. Use for any feature, fix or refactor in this repo: playlists, inline mode, groups, limits, new admin commands, error messages, or "add/change/fix X in the bot".
argument-hint: "[what to add or change]"
---

# Adding or changing something in this bot

The platform rules are in `AGENTS.md`, the project's conventions in
`docs/ARCHITECTURE.md`, the SoundCloud flow in `docs/SOUNDCLOUD.md`. Read the
parts you touch before writing code. This skill is the order of work.

## 1. Place the code

| What | Where |
|---|---|
| A table / column | `tgcloud/schema.js` — new columns on old tables nullable or with a default; no FKs; drop only with `.deprecated()` |
| Talking to SoundCloud (no Bot API) | `tgcloud/lib/soundcloud.js`, or a new `lib/<feature>.js` that imports it — see the **soundcloud-api** skill |
| Sending to Telegram, the file_id cache, user-facing texts | `tgcloud/lib/download.js` or a new `lib/<feature>.js` — see the **telegram-audio** skill |
| A command | one line in `adminCommand()` (admin) or before `replyDownload` (public) in `tgcloud/handlers/message.js`; add it to `PUBLIC_COMMANDS` / `ADMIN_COMMANDS` in `lib/admin.js` |
| A button | `<feature>:<action>[:<args>]` callback_data (≤ 64 bytes) + `handleXCallback(query)` in the lib module, tried in `handlers/callback_query.js` |
| A new update type (inline_query, chosen_inline_result, …) | `tgcloud/handlers/<type>.js`, a thin router; the deploy's `webhook sync` subscribes the bot to it |
| Something to run from CI / by hand | an `endpoints/admin<Name>.js` with `requireAdmin(ctx)` first |
| A constant | `tgcloud/lib/config.js` (no env vars at runtime) |

Rules that bite here:
- Relative imports **with `.js`**; the SDK by name (`'sdk'`, `'sdk/db'`).
  Nothing outside `tgcloud/` exists at runtime: no npm packages, no `fs`.
- Don't assume browser globals in `tgcloud/`: no `URL`, `URLSearchParams`,
  `TextEncoder`/`TextDecoder`, `Buffer`. Use string helpers and `encodeURIComponent`.
- `await` every DB call. Raw SQL returns raw values (0/1, string aggregates):
  convert with `Number()`.
- `lib/` never imports `handlers/` or `endpoints/`; no import cycles between
  lib modules (move the shared part into a third one).
- User-facing copy is Persian, informal, like the existing `ERRORS` and menu
  texts. Admin-only texts may be English.

## 2. Test offline

Add or extend `test/<feature>.test.mjs`. Helpers in `test/helpers.mjs`:

- `fresh()` (in `beforeEach`): empty DB, recorded Bot API, fetch that throws.
- `msg(from, text)`, `groupMsg(from, text)`, `press(from, data)`, `ctxOf(id)`.
- `take()` → the Bot API calls since the last take; `mockApi(method, fn)`,
  `failNext(method, code, description, when?)`.
- `soundcloud({ tracks, short, clientId, pageId, down })` → fake soundcloud.com,
  api-v2, media CDN; returns the URLs fetched. `scTrack(id, { streams, policy,
  seconds, snipped })` builds an api-v2 track. `asText(bytes)` reads fake media.
- `row(sql, …)`, `rows(sql, …)`, `exec(sql)` for DB assertions.

Cover the happy path, a refused caller (admin-only things), and the failure
the user will actually meet (a SoundCloud error code, a Bot API 400/403).

```
npm test
```

All tests must pass: `deploy.yml` deploys nothing when one fails.

## 3. Check against the real thing when it matters

The fake SoundCloud only proves the code does what you believe SoundCloud
does. When the change depends on SoundCloud's or Telegram's real behavior,
check it from the cloud before (or right after) shipping:

```
npx tgcloud run endpoints/adminProbe '{ url: "https://soundcloud.com/…" }' --ctx '{ initData: { user: { id: 199419831 } } }'
npx tgcloud run handlers/message '{ text: "/sc https://soundcloud.com/…", from: { id: 199419831 }, chat: { id: 199419831, type: "private" } }'
```

`tgcloud run` sends the local modules — no deploy needed — but it needs
`npx tgcloud login` (the user runs it; never ask for the token in chat). Without
it, use Actions → *Run in cloud* after pushing, or ask the admin to send `/sc`.
If the change needs a new probe step, add it to `lib/probe.js`.

## 4. Ship

This repo is worked on directly on `main` (one developer):

1. Update the docs the change makes untrue: `docs/SOUNDCLOUD.md` (flow,
   formats, errors, roadmap), `docs/ARCHITECTURE.md` §2 layout, `README.md`
   (Persian: usage, admin commands, structure), `CLAUDE.md` if the workflow changed.
2. Commit each significant change on its own; the message says what changed and why.
3. `git push origin main`. Then check the *Deploy bot* run: test → push →
   migrate → webhook → commands. A schema change that drops data is skipped by
   `migrate --safe` and must be applied by hand with `npx tgcloud migrate`.
4. After a deploy that changes downloading, send `/sc` (or run the probe) and a
   real link to the bot.
