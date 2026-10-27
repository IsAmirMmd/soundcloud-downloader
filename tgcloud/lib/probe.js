// Is SoundCloud usable from where the bot runs? Each step of a download,
// timed, with the error it stopped at: the client_id, resolving a link, the
// stream formats, the stream's URL and the audio itself (downloaded, never
// sent), and whether searching the track's name finds it. Only the cloud can answer this — Telegram's servers may be refused
// by hosts the developer reaches fine — so it runs there:
//   /sc [link]                      the admin, in the bot
//   endpoints/adminProbe { url }    .github/workflows/check.yml and run.yml
// For a track whose artist offers the original upload, that download is a
// step too. findDownloadable(q) lists such tracks, to have one to try. The
// storage channel (lib/storage.js) is checked too: can the bot post there?

import { api, fetch } from 'sdk';
import { ADMIN_ID, PROBE_TRACK_URL, STORAGE_CHAT_ID } from './config.js';
import { storageStatus } from './storage.js';
import { getSetting } from './settings.js';
import { clientId, findSoundcloudUrl, getTrack, searchTracks, pickTranscoding, downloadAudio, downloadOriginal, apiGet } from './soundcloud.js';

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
  if (STORAGE_CHAT_ID) {
    await step(report, 'storage channel', async () => {
      const s = await storageStatus();
      if (!s.canPost) throw new Error(`${s.title || STORAGE_CHAT_ID}: ${s.status}, can't post`);
      return `${s.title || STORAGE_CHAT_ID}: ${s.status}, can post`;
    });
  }
  if (!id) return report;
  const track = await step(report, 'resolve', () => getTrack(link));
  if (!track) return report;
  report.steps.at(-1).value = `track ${track.id}`;
  // Search (lib/search.js, lib/inline.js): does the track's own name find it?
  const q = `${track.artist} ${track.title}`.trim();
  const found = await step(report, 'search', () => searchTracks(q, { limit: 10 }));
  if (found) {
    report.steps.at(-1).value = `"${q}": ${found.tracks.length} of 10 deliverable, ` +
      `${found.tracks.some((t) => t.id === track.id) ? 'this track among them' : 'this track not among them'}${found.next != null ? ', more pages' : ''}` +
      (Object.keys(found.dropped).length ? `; dropped: ${Object.entries(found.dropped).map(([k, n]) => `${k} ${n}`).join(', ')}` : '');
  }
  report.track = { id: track.id, title: track.title, artist: track.artist, duration: track.duration, policy: track.policy, downloadable: track.downloadable };
  report.formats = track.transcodings.map((t) => `${t.preset} ${t.format?.protocol} ${t.format?.mime_type}${t.snipped ? ' (snipped)' : ''}`);
  const picked = pickTranscoding(track.transcodings);
  report.steps.push({ name: 'stream', ok: Boolean(picked), ms: 0, value: picked ? `${picked.transcoding.preset} ${picked.format.protocol} ${picked.format.mime}` : 'none usable' });
  if (!picked) { report.ok = false; return report; }
  if (download) {
    const file = await step(report, 'download', () => downloadAudio(track));
    if (file) report.steps.at(-1).value = `${file.bytes.length} bytes (${file.format})`;
    if (track.downloadable) {
      const original = await step(report, 'original', () => downloadOriginal(track));
      if (original) report.steps.at(-1).value = `${original.name}, ${original.bytes.length} bytes${original.lossless ? ', lossless' : ''}`;
    }
  }
  return report;
}

// Tracks found for `q` whose artist offers the original upload (up to 50
// looked at) → [{ url, title, artist, seconds }]. Something to probe.
export async function findDownloadable(q) {
  const found = await apiGet('/search/tracks', { q, limit: 50 });
  return (found?.collection ?? [])
    .filter((t) => t.downloadable && t.has_downloads_left !== false)
    .map((t) => ({ url: t.permalink_url, title: t.title, artist: t.user?.username ?? '', seconds: Math.round((t.full_duration ?? t.duration ?? 0) / 1000) }));
}

// What an iPhone Shortcut that searches SoundCloud itself gets
// (docs/SHORTCUT.md), step by step, as the Shortcut does it: soundcloud.com's
// page for the client_id, with the Shortcut's own regex and the user-agents
// it may send, then api-v2's search, its JSON as it comes. → { pages, search }
export const SHORTCUT_CLIENT_ID = /"apiClient","data":\{"id":"([a-zA-Z0-9]{32})"/;
const SHORTCUT_AGENTS = {
  shortcuts: 'Shortcuts/3 CFNetwork/1568.100.1 Darwin/24.0.0',
  safari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
};

export async function shortcutCheck(q, limit = 2) {
  const report = { pages: {} };
  let id = null;
  for (const [name, agent] of Object.entries(SHORTCUT_AGENTS)) {
    try {
      const res = await fetch('https://soundcloud.com/', { headers: { 'user-agent': agent } });
      const page = await res.text();
      const found = SHORTCUT_CLIENT_ID.exec(page)?.[1] ?? null;
      report.pages[name] = { status: res.status, bytes: page.length, client_id: found };
      id ??= found;
    } catch (e) {
      report.pages[name] = { error: e.message };
    }
  }
  if (!id) return report;
  const url = `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(q)}&limit=${limit}&client_id=${id}`;
  const res = await fetch(url, { headers: { 'user-agent': SHORTCUT_AGENTS.shortcuts } });
  report.search = { status: res.status, url: url.replace(id, '<client_id>'), body: await res.json().catch(() => null) };
  return report;
}

// /sc [link] — the probe, as a message to the admin.
export async function sendProbe(text) {
  const url = text.replace(/^\/sc(@\w+)?\s*/, '').trim() || PROBE_TRACK_URL;
  const r = await probe(url);
  const lines = [`${r.ok ? '✅' : '❌'} SoundCloud probe: ${r.url}`];
  if (r.track) lines.push(`🎵 ${r.track.artist} — ${r.track.title} (${r.track.duration} s, ${r.track.policy}${r.track.downloadable ? ', original offered' : ''})`);
  if (r.formats) lines.push(`📼 ${r.formats.join(' · ') || 'no formats'}`);
  for (const s of r.steps) {
    const value = typeof s.value === 'string' ? s.value : s.ok ? 'ok' : '';
    lines.push(`${s.ok ? '✅' : '❌'} ${s.name}${s.ms ? ` (${s.ms} ms)` : ''}: ${s.ok ? value : s.error}`);
  }
  await api.sendMessage({ chat_id: ADMIN_ID, text: lines.join('\n'), link_preview_options: { is_disabled: true } });
}
