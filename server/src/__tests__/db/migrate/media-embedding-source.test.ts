import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../../db/migrate/runner.js';
import { down, up } from '../../../db/migrations/20261119_000001_media_embedding_source.js';

// Folds the three old ways a local media/embedding row survived catalog sync
// (custom/key-bound, meta_json.userAdded, catalog_local_pins) into source='user'.

// The source columns are upstream's (20261118 / 20261125); drop them directly to
// get the pre-migration shape.
async function migratedWithoutSource(): Promise<Database.Database> {
  const db = new Database(':memory:');
  await runMigrations(db, 'up');
  db.exec('ALTER TABLE media_models DROP COLUMN source; ALTER TABLE embedding_models DROP COLUMN source;');
  return db;
}

function sourceOf(db: Database.Database, table: string, modelId: string): string {
  return (db.prepare(`SELECT source FROM ${table} WHERE model_id = ?`).get(modelId) as { source: string }).source;
}

describe('20261119_000001_media_embedding_source', () => {
  it('converts pins, userAdded and custom rows to user and drops the pin table', async () => {
    const db = await migratedWithoutSource();
    try {
      db.exec(`
        INSERT INTO media_models (platform, model_id, display_name, modality, priority, enabled, meta_json) VALUES
          ('typecast', 'pinned-tts', 'Pinned', 'audio', 1, 1, NULL),
          ('beatapi', 'added-search', 'Added', 'search', 1, 0, '{"userAdded":true}'),
          ('beatapi', 'added-decision', 'Added', 'decision', 1, 0, '{"userAdded":true,"contextWindow":4096}'),
          ('tavily', 'catalog-search', 'Catalog', 'search', 1, 1, '{"creditsPerQuery":1}');
        INSERT INTO media_models (platform, model_id, display_name, modality, priority, enabled, endpoint_scope)
          VALUES ('custom', 'relay', 'Relay', 'search', 1, 1, 'https://relay.example.com');
        INSERT INTO embedding_models (family, platform, model_id, display_name, dimensions, priority, enabled) VALUES
          ('pinned-embed', 'silvr', 'pinned-embed', 'Pinned', 1536, 1, 1),
          ('catalog-embed', 'silvr', 'catalog-embed', 'Catalog', 1536, 1, 1);
        CREATE TABLE catalog_local_pins (kind TEXT NOT NULL, platform TEXT NOT NULL, model_id TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (kind, platform, model_id));
        INSERT INTO catalog_local_pins (kind, platform, model_id) VALUES
          ('media', 'typecast', 'pinned-tts'), ('embedding', 'silvr', 'pinned-embed');
      `);

      up(db);

      expect(sourceOf(db, 'media_models', 'pinned-tts')).toBe('user');
      expect(sourceOf(db, 'media_models', 'added-search')).toBe('user');
      expect(sourceOf(db, 'media_models', 'added-decision')).toBe('user');
      expect(sourceOf(db, 'media_models', 'relay')).toBe('user');
      expect(sourceOf(db, 'media_models', 'catalog-search')).toBe('catalog');
      expect(sourceOf(db, 'embedding_models', 'pinned-embed')).toBe('user');
      expect(sourceOf(db, 'embedding_models', 'catalog-embed')).toBe('catalog');
      const meta = (id: string) => (db.prepare('SELECT meta_json FROM media_models WHERE model_id = ?').get(id) as { meta_json: string | null }).meta_json;
      expect(meta('added-search')).toBeNull();
      expect(JSON.parse(meta('added-decision')!)).toEqual({ contextWindow: 4096 });
      expect(meta('catalog-search')).toBe('{"creditsPerQuery":1}');
      expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'catalog_local_pins'").get()).toBeUndefined();

      up(db); // replay is a no-op
      expect(sourceOf(db, 'media_models', 'pinned-tts')).toBe('user');
    } finally {
      db.close();
    }
  });

  it('down recreates the empty pin table', async () => {
    const db = await migratedWithoutSource();
    try {
      up(db);
      down(db);
      expect(db.prepare('SELECT COUNT(*) AS n FROM catalog_local_pins').get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  it('runs without a pin table', async () => {
    const db = await migratedWithoutSource();
    try {
      up(db);
      const cols = db.prepare('PRAGMA table_info(embedding_models)').all() as { name: string }[];
      expect(cols.some(c => c.name === 'source')).toBe(true);
    } finally {
      db.close();
    }
  });
});
