// node --import ./test/sdk/register.mjs --test … (npm test): lets the bot's
// modules import 'sdk' and 'sdk/db' outside the cloud.
import { register } from 'node:module';

register('./hooks.mjs', import.meta.url);
