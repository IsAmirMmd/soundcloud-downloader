// endpoints/adminProbe.js — admin only: every step of a SoundCloud download,
// run where the bot runs (lib/probe.js). The audio is downloaded but not sent.
// .github/workflows/check.yml runs it on every branch; run.yml by hand:
//   { }                                      the default track (config.js PROBE_TRACK_URL)
//   { url: "https://soundcloud.com/…" }      another link
//   { url: "…", download: false }            stop before downloading
//   { search: "free download wav" }          tracks whose original upload is offered
//   { q: "shadmehr" }                        what the bot's search finds, and what it drops and why
//   { q: "shadmehr", shortcut: true }        what an iPhone Shortcut gets, raw (docs/SHORTCUT.md)

import { requireAdmin, badInput } from '../lib/access.js';
import { probe, findDownloadable, shortcutCheck } from '../lib/probe.js';
import { searchTracks } from '../lib/soundcloud.js';

export default async function (input, ctx) {
  requireAdmin(ctx);
  if (typeof input.search === 'string' && input.search.trim()) return findDownloadable(input.search.trim());
  if (typeof input.q === 'string' && input.q.trim() && input.shortcut) return shortcutCheck(input.q.trim(), Number(input.limit) || 2);
  if (typeof input.q === 'string' && input.q.trim()) {
    const found = await searchTracks(input.q.trim(), { offset: Number(input.offset) || 0, limit: Number(input.limit) || 20 });
    const line = (t) => `${t.id} ${t.artist} — ${t.title} (${t.duration} s, ${t.policy}, ${t.transcodings.map((x) => x.preset).join('/') || 'no streams listed'})`;
    return {
      next: found.next,
      dropped: found.dropped,
      tracks: found.tracks.map(line),
      // With each stream's protocol: why none of them was usable.
      refused: found.refused.map((t) => `${t.refusal}: ${line(t)} ${t.permalink} [${t.transcodings.map((x) => `${x.preset} ${x.format?.protocol}${x.snipped ? ' snipped' : ''}`).join(', ')}]`),
    };
  }
  if (input.url != null && typeof input.url !== 'string') throw badInput('url must be a string');
  return probe(input.url || undefined, { download: input.download !== false });
}
