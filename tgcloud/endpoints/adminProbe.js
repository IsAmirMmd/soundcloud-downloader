// endpoints/adminProbe.js — admin only: every step of a SoundCloud download,
// run where the bot runs (lib/probe.js). The audio is downloaded but not sent.
// .github/workflows/check.yml runs it on every branch; run.yml by hand:
//   { }                                      the default track (config.js PROBE_TRACK_URL)
//   { url: "https://soundcloud.com/…" }      another link
//   { url: "…", download: false }            stop before downloading

import { requireAdmin, badInput } from '../lib/access.js';
import { probe } from '../lib/probe.js';

export default async function (input, ctx) {
  requireAdmin(ctx);
  if (input.url != null && typeof input.url !== 'string') throw badInput('url must be a string');
  return probe(input.url || undefined, { download: input.download !== false });
}
