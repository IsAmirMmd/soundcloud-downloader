// POST /api/me — who the Mini App's user is, as the server sees them.
// The front-end calls it first to decide what to show.

import { isAdmin, callerId } from '../lib/access.js';

export default async function (input, ctx) {
  const user = ctx.initData.user;   // verified by the platform; there is no ctx.user
  return {
    id: callerId(ctx),
    first_name: user?.first_name ?? null,
    username: user?.username ?? null,
    isAdmin: isAdmin(ctx),
  };
}
