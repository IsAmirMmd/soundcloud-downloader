// Usage: npm run sql -- "SELECT * FROM settings"
// Runs the query in the cloud through tgcloud/endpoints/sql.js (no deploy needed).
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const q = process.argv.slice(2).join(' ').trim();
if (!q) {
  console.error('Usage: npm run sql -- "SELECT * FROM settings"');
  process.exit(1);
}

const config = readFileSync(new URL('../tgcloud/lib/config.js', import.meta.url), 'utf8');
const adminId = Number(config.match(/ADMIN_ID\s*=\s*(\d+)/)[1]);

const cli = new URL('../node_modules/@tgcloud/cli/bin/tgcloud.js', import.meta.url);
const { status } = spawnSync(process.execPath, [
  cli.pathname.replace(/^\/(\w:)/, '$1'),
  '--no-pager', 'run', 'endpoints/sql',
  JSON.stringify({ q }),
  '--ctx', JSON.stringify({ initData: { user: { id: adminId } } }),
], { stdio: 'inherit' });
process.exit(status ?? 1);
