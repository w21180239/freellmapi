#!/usr/bin/env node
// Local fork allowlist / blocklist on top of the signed catalog, against the live DB.
//   node scripts/catalog-lists.mjs list
//   node scripts/catalog-lists.mjs pin     <media|embedding> <platform> <modelId...>
//   node scripts/catalog-lists.mjs unpin   <media|embedding> <platform> <modelId...>
//   node scripts/catalog-lists.mjs block   <chat|media|embedding> <platform> <modelId...>
//   node scripts/catalog-lists.mjs unblock <chat|media|embedding> <platform> <modelId...>
// pin: the row survives catalog prunes. block: tombstone + delete now; no catalog sync re-adds it.
// Chat rows need no pin: hand-added rows (source='user') already win over the catalog.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '..', 'server', 'package.json'));
const Database = require('better-sqlite3');
const dbPath = process.env.FREEAPI_DB ?? path.join(process.env.APPDATA ?? '', 'FreeLLMAPI', 'freeapi.db');
const db = new Database(dbPath, { fileMustExist: true });
db.pragma('busy_timeout = 5000');
db.prepare(`CREATE TABLE IF NOT EXISTS catalog_local_pins (
  kind TEXT NOT NULL, platform TEXT NOT NULL, model_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (kind, platform, model_id))`).run();

const [cmd, kind, platform, ...ids] = process.argv.slice(2);
const kinds = { pin: ['media', 'embedding'], unpin: ['media', 'embedding'], block: ['chat', 'media', 'embedding'], unblock: ['chat', 'media', 'embedding'] };
function usage(msg) { console.error(msg); process.exit(2); }

if (cmd === 'list') {
  for (const r of db.prepare('SELECT kind, platform, model_id FROM catalog_local_pins ORDER BY 1, 2, 3').all()) console.log(`pin\t${r.kind}\t${r.platform}\t${r.model_id}`);
  for (const r of db.prepare("SELECT kind, platform, model_id FROM catalog_model_tombstones WHERE source = 'user' ORDER BY 1, 2, 3").all()) console.log(`block\t${r.kind}\t${r.platform}\t${r.model_id}`);
  process.exit(0);
}
if (!kinds[cmd]) usage('command: list | pin | unpin | block | unblock');
if (!kinds[cmd].includes(kind)) usage(`${cmd} kind must be one of ${kinds[cmd].join(', ')}`);
if (!platform || ids.length === 0 || platform === 'custom') usage('need a built-in platform and at least one model id');

const table = kind === 'embedding' ? 'embedding_models' : kind === 'media' ? 'media_models' : 'models';
const stmt = {
  pin: db.prepare('INSERT OR IGNORE INTO catalog_local_pins (kind, platform, model_id) VALUES (?, ?, ?)'),
  unpin: db.prepare('DELETE FROM catalog_local_pins WHERE kind = ? AND platform = ? AND model_id = ?'),
  block: db.prepare(`INSERT INTO catalog_model_tombstones (kind, platform, model_id, source) VALUES (?, ?, ?, 'user')
    ON CONFLICT(kind, platform, model_id) DO UPDATE SET source = 'user', created_at = datetime('now')`),
  unblock: db.prepare("DELETE FROM catalog_model_tombstones WHERE kind = ? AND platform = ? AND model_id = ? AND source = 'user'"),
};
let changed = 0, removed = 0;
db.transaction(() => {
  for (const id of ids) {
    changed += stmt[cmd].run(kind, platform, id).changes;
    if (cmd === 'block') {
      db.prepare('DELETE FROM catalog_local_pins WHERE kind = ? AND platform = ? AND model_id = ?').run(kind, platform, id);
      const rows = db.prepare(`SELECT id FROM ${table} WHERE platform = ? AND model_id = ? AND key_id IS NULL`).all(platform, id);
      for (const r of rows) {
        if (kind === 'chat') {
          db.prepare('DELETE FROM fallback_config WHERE model_db_id = ?').run(r.id);
          db.prepare('DELETE FROM profile_models WHERE model_db_id = ?').run(r.id);
        }
        removed += db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(r.id).changes;
      }
    }
  }
})();
console.log(`${cmd} ${kind} ${platform}: ${changed} changed${cmd === 'block' ? `, ${removed} rows removed` : ''}`);
