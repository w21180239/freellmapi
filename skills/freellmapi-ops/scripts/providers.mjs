// providers subcommand and the report sync-upstream prints after a restart.
import fs from 'node:fs';
import path from 'node:path';
import { APPDATA_DIR, die, log, withSession } from './lib.mjs';

// Seen-set state: sync-upstream flags providers absent from it as new, then records them.
const SEEN_FILE = path.join(APPDATA_DIR, 'providers-seen.json');
function readSeen() {
  try { return JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')); } catch { return null; }
}

/** Print providers that still need a key, new ones (since the last record) first.
 *  record=true stores the current set as seen; the first record only seeds it. */
export async function providerReport(call, { record = false } = {}) {
  const r = await call('GET', '/api/keys/providers');
  if (r.status >= 300) die(`providers: HTTP ${r.status}`);
  const j = r.json;
  const all = j.providers ?? [];
  const prev = readSeen();
  const fresh = prev ? all.filter((p) => !prev.seen.includes(p.platform)).map((p) => p.platform) : [];
  const newSet = new Set(record ? fresh : (prev?.lastNew ?? []));
  if (record) {
    fs.writeFileSync(SEEN_FILE, JSON.stringify({ seen: all.map((p) => p.platform), lastNew: fresh, at: new Date().toISOString() }, null, 1));
  }
  const missing = all.filter((p) => !p.configured && !p.keyless);
  const order = (p) => (newSet.has(p.platform) ? 0 : 1);
  missing.sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
  for (const p of missing) log(`  ${newSet.has(p.platform) ? 'NEW ' : '    '}${p.platform.padEnd(18)} ${p.kind.padEnd(6)} ${p.name}`);
  const newKeyless = all.filter((p) => newSet.has(p.platform) && p.keyless).map((p) => p.platform);
  if (newKeyless.length) log(`  new keyless (no key needed): ${newKeyless.join(', ')}`);
  const newMissing = missing.filter((p) => newSet.has(p.platform)).length;
  log(`providers: ${missing.length} without a key (${newMissing} new upstream), ${all.length - missing.length} configured or keyless${prev ? '' : record ? '; seen-set seeded' : '; no seen-set yet'}`);
}

export async function providers() {
  await withSession(({ call }) => providerReport(call));
}
