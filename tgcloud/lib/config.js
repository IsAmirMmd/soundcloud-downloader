// Edit these to configure the bot. There are no env vars at runtime: constants
// live here, secrets in the `settings` table (lib/settings.js).

// Telegram user id of the admin: the only one allowed to use the admin
// commands and the `sql` endpoint (npm run sql); receives error notices.
// Also used by .github/workflows/scheduled.yml — change it there too.
export const ADMIN_ID = 199419831;

// The Mini App's address — `npx tgcloud push` prints it (https://app<app id>.tgcloud.ai/).
// Empty: no "open the app" buttons.
export const MINI_APP_URL = '';

// The bot's timezone as a fixed UTC offset in minutes (Iran: 210 = +03:30).
// A fixed offset, because the runtime is not guaranteed to have Intl timezone data.
export const UTC_OFFSET_MINUTES = 210;
