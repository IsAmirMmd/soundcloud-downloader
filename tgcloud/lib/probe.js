// Is SoundCloud usable from where the bot runs? Each step of a download,
// timed, with the error it stopped at: the client_id, resolving a link, the
// stream formats, the stream's URL and the audio itself (downloaded, never
// sent). Only the cloud can answer this — Telegram's servers may be refused
// by hosts the developer reaches fine — so it runs there:
//   /sc [link]                      the admin, in the bot
//   endpoints/adminProbe { url }    .github/workflows/check.yml and run.yml

import { api } from 'sdk';
import { ADMIN_ID, PROBE_TRACK_URL } from './config.js';
import { getSetting } from './settings.js';
import { clientId, findSoundcloudUrl, getTrack, pickTranscoding, downloadAudio } from './soundcloud.js';

async function step(report, name, fn) {
  const t = Date.now();
  try {
    const value = await fn();
    report.steps.push({ name, ok: true, ms: Date.now() - t, value });
    return value;
  } catch (e) {
    report.steps.push({ name, ok: false, ms: Date.now() - t, error: e.message });
    report.ok = false;
    return undefined;
  }
}

// → { ok, url, steps: [{ name, ok, ms, value | error }] }. Stops at the first failed step.
export async function probe(url = PROBE_TRACK_URL, { download = true } = {}) {
  const link = findSoundcloudUrl(url) ?? { url, short: false };
  const report = { ok: true, url: link.url, steps: [] };
  const kept = await getSetting('sc:client_id');
  const id = await step(report, kept ? 'client_id (kept)' : 'client_id (scraped)', () => clientId());
  if (!id) return report;
  const track = await step(report, 'resolve', () => getTrack(link));
  if (!track) return report;
  report.steps.at(-1).value = `track ${track.id}`;
  report.track ={ id: track.id, title: track.title, artist: track.artist, duration: track.duration, policy: track.policy };
  report.formats = track.transcodings.map((t) => `${t.format?.protocol} ${t.format?.mime_type}${t.snipped ? ' (snipped)' : ''}`);
  const picked = pickTranscoding(track.transcodings);
  report.steps.push({ name: 'stream', ok: Boolean(picked), ms: 0, value: picked ? `${picked.format.protocol} ${picked.format.mime}` : 'none usable' });
  if (!picked) { report.ok = false; return report; }
  if (download) {
    const file = await step(report, 'download', () => downloadAudio(track));
    if (file) report.steps.at(-1).value = `${file.bytes.length} bytes (${file.format})`;
  }
  return report;
}

// /sc [link] — the probe, as a message to the admin.
export async function sendProbe(text) {
  const url = text.replace(/^\/sc(@\w+)?\s*/, '').trim() || PROBE_TRACK_URL;
  const r = await probe(url);
  const lines = [`${r.ok ? '✅' : '❌'} SoundCloud probe: ${r.url}`];
  if (r.track) lines.push(`🎵 ${r.track.artist} — ${r.track.title} (${r.track.duration} s, ${r.track.policy})`);
  if (r.formats) lines.push(`📼 ${r.formats.join(' · ') || 'no formats'}`);
  for (const s of r.steps) {
    const value = typeof s.value === 'string' ? s.value : s.ok ? 'ok' : '';
    lines.push(`${s.ok ? '✅' : '❌'} ${s.name}${s.ms ? ` (${s.ms} ms)` : ''}: ${s.ok ? value : s.error}`);
  }
  await api.sendMessage({ chat_id: ADMIN_ID, text: lines.join('\n'), link_preview_options: { is_disabled: true } });
}
