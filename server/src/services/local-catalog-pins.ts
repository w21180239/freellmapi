// Local fork: allowlist of rows we register ourselves. A pinned media or
// embedding row survives catalog prunes; chat rows need no pin (source='user'
// already wins). The blocklist is catalog_model_tombstones with source='user'.
// The table is created on demand so it never collides with upstream migrations.
import type { Db } from '../db/types.js';

export type LocalPinKind = 'media' | 'embedding';

function ensureTable(db: Db): void {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS catalog_local_pins (
      kind TEXT NOT NULL,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (kind, platform, model_id)
    )
  `).run();
}

export const pinKey = (kind: LocalPinKind, platform: string, modelId: string) => `${kind}:${platform}:${modelId}`;

export function loadLocalPins(db: Db): Set<string> {
  ensureTable(db);
  const rows = db.prepare('SELECT kind, platform, model_id FROM catalog_local_pins').all() as
    { kind: LocalPinKind; platform: string; model_id: string }[];
  return new Set(rows.map(r => pinKey(r.kind, r.platform, r.model_id)));
}

export function pinLocalModel(db: Db, kind: LocalPinKind, platform: string, modelId: string): void {
  ensureTable(db);
  db.prepare('INSERT OR IGNORE INTO catalog_local_pins (kind, platform, model_id) VALUES (?, ?, ?)').run(kind, platform, modelId);
}
