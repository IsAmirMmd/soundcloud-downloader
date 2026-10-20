// The `settings` table: small key/value state — secrets set by an admin
// command, drafts, flags. Values are strings; JSON.stringify anything else.

import { db } from 'sdk';
import { eq } from 'sdk/db';
import { settings } from '../schema.js';

export async function getSetting(key) {
  const row = await db.select().from(settings).where(eq(settings.key, key)).get();
  return row?.value ?? null;
}

export async function setSetting(key, value) {
  await db.insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
    .run();
}

export async function deleteSetting(key) {
  await db.delete(settings).where(eq(settings.key, key)).run();
}
