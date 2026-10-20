// Edit these to configure the bot. There are no env vars at runtime: constants
// live here, secrets in the `settings` table (lib/settings.js).

// Telegram user id of the admin: the only one allowed to use the admin
// commands and the `sql` endpoint (npm run sql); receives error notices.
// Also used by .github/workflows/*.yml (--ctx and the scheduled /backup) —
// change it there too.
export const ADMIN_ID = 199419831;

// The Mini App's address — `npx tgcloud push` prints it (https://app<app id>.tgcloud.ai/).
// Empty: no "open the app" buttons.
export const MINI_APP_URL = '';

// The bot's timezone as a fixed UTC offset in minutes (Iran: 210 = +03:30).
// A fixed offset, because the runtime is not guaranteed to have Intl timezone data.
export const UTC_OFFSET_MINUTES = 210;

// The largest audio file the bot uploads. The Bot API takes 50 MB per file;
// the rest is room for the multipart envelope and the thumbnail.
export const MAX_AUDIO_BYTES = 49 * 1024 * 1024;

// Longer tracks are refused before anything is downloaded. A 128 kbps MP3 is
// 16 KB a second, so 50 minutes is about 47 MB: just under MAX_AUDIO_BYTES.
export const MAX_DURATION_SECONDS = 50 * 60;

// A public track that should always resolve: the default of /sc and
// endpoints/adminProbe.js, which check SoundCloud from the cloud.
export const PROBE_TRACK_URL = 'https://soundcloud.com/forss/flickermood';
