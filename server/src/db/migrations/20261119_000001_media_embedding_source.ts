// Migration: source provenance (catalog vs user) for media and embedding rows
// Created: 2026-11-19
//
// DOWN: recreates the empty catalog_local_pins table; pin rows and the stripped
// meta_json.userAdded markers are not restored. The columns are upstream's.
//
// Same contract as models.source: 'catalog' rows follow the signed catalog,
// 'user' rows are the owner's and catalog sync never updates, prunes or
// deletes them. Before this column local media/embedding rows survived through
// three ad hoc mechanisms; each is folded into source = 'user' here:
//   - custom-endpoint and key-bound rows (local by definition)
//   - rows marked meta_json.userAdded (the marker is stripped)
//   - rows listed in catalog_local_pins (the table is dropped)
//
// The DEFAULT is 'catalog' so baseline re-seeds stay catalog-owned.
// Guarded so a replay over a live schema is a no-op.

import type { Db } from '../types.js';

const TABLES = ['media_models', 'embedding_models'] as const;

function hasColumn(db: Db, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some(col => col.name === column);
}

function hasTable(db: Db, table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

export function up(db: Db): void {
  for (const table of TABLES) {
    if (!hasColumn(db, table, 'source')) {
      db.prepare(`ALTER TABLE ${table} ADD COLUMN source TEXT NOT NULL DEFAULT 'catalog'`).run();
    }
    db.prepare(`UPDATE ${table} SET source = 'user' WHERE platform = 'custom' OR key_id IS NOT NULL`).run();
  }

  const marked = db.prepare("SELECT id, meta_json FROM media_models WHERE meta_json LIKE '%userAdded%'")
    .all() as { id: number; meta_json: string }[];
  const claim = db.prepare("UPDATE media_models SET source = 'user', meta_json = ? WHERE id = ?");
  for (const row of marked) {
    let meta: Record<string, unknown>;
    try { meta = JSON.parse(row.meta_json) as Record<string, unknown>; } catch { continue; }
    if (!meta || typeof meta !== 'object' || meta.userAdded !== true) continue;
    delete meta.userAdded;
    claim.run(Object.keys(meta).length > 0 ? JSON.stringify(meta) : null, row.id);
  }

  if (hasTable(db, 'catalog_local_pins')) {
    db.prepare(`
      UPDATE media_models SET source = 'user'
       WHERE EXISTS (SELECT 1 FROM catalog_local_pins p
                      WHERE p.kind = 'media' AND p.platform = media_models.platform AND p.model_id = media_models.model_id)
    `).run();
    db.prepare(`
      UPDATE embedding_models SET source = 'user'
       WHERE EXISTS (SELECT 1 FROM catalog_local_pins p
                      WHERE p.kind = 'embedding' AND p.platform = embedding_models.platform AND p.model_id = embedding_models.model_id)
    `).run();
    db.prepare('DROP TABLE catalog_local_pins').run();
  }
}

// Both source columns belong to upstream migrations (20261118 embeddings,
// 20261125 media), whose down() drops them. This only restores the (empty)
// pin table up() dropped; its rows and the userAdded markers are gone.
export function down(db: Db): void {
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
