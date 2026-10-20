# CLAUDE.md

@AGENTS.md

## How this project is worked on

- One developer: work directly on `main` and push to it. Every push to
  `main` deploys (`.github/workflows/deploy.yml`: `npm test` first — a failure
  deploys nothing — then push, `migrate --safe`, webhook sync and the `/`
  command menus). Check the run's result after each push.
- Commit each significant change on its own, with a message that says what
  changed and why.
- Run `npm test` before pushing. SoundCloud itself can only be checked from
  the cloud: `/sc [link]` as the admin, or
  `npx tgcloud run endpoints/adminProbe '{}' --ctx '{ initData: { user: { id: 199419831 } } }'`
  (Actions → Run in cloud does the same).
- Skills for this repo: `.claude/skills/bot-feature` (how a change is made and
  shipped here), `soundcloud-api` (api-v2, client_id, streams),
  `telegram-audio` (sendAudio, file_id cache, limits). The tgcloud-kit plugin
  (`.claude/settings.json`) adds the platform skills: tgcloud-bot,
  tgcloud-endpoints, tgcloud-growth, tgcloud-mini-app.
