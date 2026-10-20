// Who may call which endpoint. The caller is always ctx.initData.user —
// verified by the platform — never an id sent in the input.

import { EndpointError } from 'sdk';
import { ADMIN_ID } from './config.js';

export const callerId = (ctx) => ctx.initData?.user?.id;
export const isAdmin = (ctx) => callerId(ctx) === ADMIN_ID;

export const forbidden = (message = 'Forbidden') => new EndpointError(message, { code: 'FORBIDDEN' });
export const badInput = (message) => new EndpointError(message, { code: 'BAD_INPUT' });

export function requireAdmin(ctx) {
  if (!isAdmin(ctx)) throw forbidden('Admins only');
}

// Per-resource access (multi-tenant): look the caller up in a membership table
// and throw forbidden() when they have no row — see the tgcloud-growth skill,
// references/multi-tenant.md.
