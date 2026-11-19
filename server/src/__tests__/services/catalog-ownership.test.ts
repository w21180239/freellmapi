import { beforeEach, describe, expect, it } from 'vitest';
import { getDb, initDb, setSetting } from '../../db/index.js';
import { applyCatalog, getCatalogOverlap, type OwnedModelKind } from '../../services/catalog-sync.js';
import { recordCatalogModelTombstone } from '../../services/model-state.js';
import {
  claimModel,
  OwnershipError,
  patchEmbeddingModel,
  patchMediaModel,
  releaseModel,
} from '../../services/model-ownership.js';

// The signed catalog is a baseline; source='user' rows are the owner's. These
// tests pin the overlay contract for every catalog array: user rows are never
// updated or pruned, user tombstones block re-adds, content edits claim,
// release hands a row back only when the catalog lists it, and overlap is
// reported.

type AnyCatalog = Parameters<typeof applyCatalog>[1];

interface Case {
  name: string;
  kind: OwnedModelKind;
  table: 'models' | 'media_models' | 'embedding_models';
  platform: string;
  modelId: string;
  modality: string;
  /** Catalog carrying `entry` (or only a filler row when null) in this case's array. */
  catalog: (entry: { displayName: string; enabled?: boolean } | null) => AnyCatalog;
}

function chatModel(platform: string, modelId: string, displayName: string, enabled = true, modality?: string): AnyCatalog['models'][number] {
  return {
    platform, modelId, displayName, intelligenceRank: 3, speedRank: 5, sizeLabel: 'Medium',
    limits: { rpm: 30, rpd: 1000, tpm: null, tpd: null }, monthlyTokenBudget: '~1M', contextWindow: 8192,
    enabled, supportsVision: false, supportsTools: true,
    ...(modality ? { modality, mediaNote: 'catalog note' } : {}),
  };
}

function base(over: Partial<AnyCatalog>): AnyCatalog {
  return { version: '2099.01.01', generatedAt: new Date().toISOString(), tier: 'live', models: [], quirks: [], ...over };
}

// Each array also carries a filler row, so "absent" still means a snapshot
// that is present (an empty embeddings array keeps the baseline untouched).
const CASES: Case[] = [
  {
    name: 'chat', kind: 'chat', table: 'models', platform: 'groq', modelId: 'mine-chat', modality: 'chat',
    catalog: e => base({ models: [chatModel('groq', 'filler-chat', 'Filler'), ...(e ? [chatModel('groq', 'mine-chat', e.displayName, e.enabled)] : [])] }),
  },
  {
    name: 'image (models[])', kind: 'media', table: 'media_models', platform: 'pollinations', modelId: 'mine-image', modality: 'image',
    catalog: e => base({ models: [chatModel('pollinations', 'filler-image', 'Filler', true, 'image'), ...(e ? [chatModel('pollinations', 'mine-image', e.displayName, e.enabled, 'image')] : [])] }),
  },
  {
    name: 'video', kind: 'media', table: 'media_models', platform: 'pollinations', modelId: 'mine-video', modality: 'video',
    catalog: e => base({ videoModels: [
      { platform: 'pollinations', modelId: 'filler-video', displayName: 'Filler', priority: 1, enabled: true },
      ...(e ? [{ platform: 'pollinations', modelId: 'mine-video', displayName: e.displayName, priority: 1, enabled: e.enabled ?? true }] : []),
    ] }),
  },
  {
    name: 'search', kind: 'media', table: 'media_models', platform: 'tavily', modelId: 'mine-search', modality: 'search',
    catalog: e => base({ searchEngines: [
      { platform: 'tavily', engineId: 'filler-search', displayName: 'Filler', priority: 1, enabled: true },
      ...(e ? [{ platform: 'tavily', engineId: 'mine-search', displayName: e.displayName, priority: 1, enabled: e.enabled ?? true }] : []),
    ] }),
  },
  {
    name: 'decision', kind: 'media', table: 'media_models', platform: 'cloudflare', modelId: 'mine-decision', modality: 'decision',
    catalog: e => base({ decisionModels: [
      { platform: 'cloudflare', modelId: 'filler-decision', displayName: 'Filler', priority: 1, enabled: true },
      ...(e ? [{ platform: 'cloudflare', modelId: 'mine-decision', displayName: e.displayName, priority: 1, enabled: e.enabled ?? true }] : []),
    ] }),
  },
  {
    name: 'transcription', kind: 'media', table: 'media_models', platform: 'groq', modelId: 'mine-stt', modality: 'transcription',
    catalog: e => base({ transcriptionModels: [
      { platform: 'groq', modelId: 'filler-stt', displayName: 'Filler', priority: 1, enabled: true },
      ...(e ? [{ platform: 'groq', modelId: 'mine-stt', displayName: e.displayName, priority: 1, enabled: e.enabled ?? true }] : []),
    ] }),
  },
  {
    name: 'embedding', kind: 'embedding', table: 'embedding_models', platform: 'silvr', modelId: 'mine-embed', modality: 'embedding',
    catalog: e => base({ embeddings: [
      { family: 'filler-embed', platform: 'silvr', modelId: 'filler-embed', displayName: 'Filler', dimensions: 1536, maxInputTokens: 8192, priority: 1, enabled: true, quotaLabel: '' },
      ...(e ? [{ family: 'mine-embed', platform: 'silvr', modelId: 'mine-embed', displayName: e.displayName, dimensions: 1536, maxInputTokens: 8192, priority: 1, enabled: e.enabled ?? true, quotaLabel: '' }] : []),
    ] }),
  },
];

function insertUserRow(c: Case): number {
  const db = getDb();
  const info = c.kind === 'chat'
    ? db.prepare("INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, source) VALUES (?, ?, 'Mine', 50, 50, 1, 'user')").run(c.platform, c.modelId)
    : c.kind === 'media'
      ? db.prepare("INSERT INTO media_models (platform, model_id, display_name, modality, priority, enabled, source) VALUES (?, ?, 'Mine', ?, 7, 1, 'user')").run(c.platform, c.modelId, c.modality)
      : db.prepare("INSERT INTO embedding_models (family, platform, model_id, display_name, dimensions, priority, enabled, source) VALUES (?, ?, ?, 'Mine', 1536, 7, 1, 'user')").run(c.modelId, c.platform, c.modelId);
  return Number(info.lastInsertRowid);
}

function row(c: Case): { id: number; display_name: string; source: string; enabled: number } | undefined {
  return getDb().prepare(`SELECT id, display_name, source, enabled FROM ${c.table} WHERE platform = ? AND model_id = ?`)
    .get(c.platform, c.modelId) as { id: number; display_name: string; source: string; enabled: number } | undefined;
}

function setApplied(catalog: AnyCatalog): void {
  setSetting('catalog_applied_json', JSON.stringify(catalog));
}

describe.each(CASES)('catalog overlay: $name', (c) => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('prunes a catalog row once the catalog stops listing it (control)', () => {
    applyCatalog(getDb(), c.catalog({ displayName: 'Catalog Name' }));
    expect(row(c)).toMatchObject({ display_name: 'Catalog Name', source: 'catalog' });
    applyCatalog(getDb(), c.catalog(null));
    expect(row(c)).toBeUndefined();
  });

  it('never updates nor prunes a user row', () => {
    insertUserRow(c);
    applyCatalog(getDb(), c.catalog({ displayName: 'Catalog Name', enabled: false }));
    expect(row(c)).toMatchObject({ display_name: 'Mine', source: 'user', enabled: 1 });
    applyCatalog(getDb(), c.catalog(null));
    expect(row(c)).toMatchObject({ display_name: 'Mine', source: 'user' });
  });

  it('keeps a user-tombstoned model out', () => {
    recordCatalogModelTombstone(getDb(), c.kind, c.platform, c.modelId);
    applyCatalog(getDb(), c.catalog({ displayName: 'Catalog Name' }));
    expect(row(c)).toBeUndefined();
  });

  it('reports a user row the catalog also lists, with the differing fields', () => {
    const id = insertUserRow(c);
    applyCatalog(getDb(), c.catalog({ displayName: 'Catalog Name' }));
    const entry = getCatalogOverlap().find(o => o.kind === c.kind && o.modelId === c.modelId);
    expect(entry).toMatchObject({ id, table: c.table, platform: c.platform, modality: c.modality });
    expect(entry!.differs.displayName).toEqual({ local: 'Mine', catalog: 'Catalog Name' });
    expect(entry!.differs.enabled).toBeUndefined();
    applyCatalog(getDb(), c.catalog(null));
    expect(getCatalogOverlap().some(o => o.modelId === c.modelId)).toBe(false);
  });

  it('claims a catalog row so later applies leave it alone', () => {
    applyCatalog(getDb(), c.catalog({ displayName: 'Catalog Name' }));
    const id = row(c)!.id;
    if (c.kind === 'chat') {
      claimModel(getDb(), 'chat', id);
      getDb().prepare("UPDATE models SET display_name = 'Mine' WHERE id = ?").run(id);
    } else {
      const patch = c.kind === 'media' ? patchMediaModel : patchEmbeddingModel;
      patch(getDb(), id, { enabled: false });
      expect(row(c)).toMatchObject({ source: 'catalog', enabled: 0 });
      patch(getDb(), id, { displayName: 'Mine' });
    }
    expect(row(c)!.source).toBe('user');
    applyCatalog(getDb(), c.catalog({ displayName: 'Catalog Renamed' }));
    expect(row(c)!.display_name).toBe('Mine');
    applyCatalog(getDb(), c.catalog(null));
    expect(row(c)!.display_name).toBe('Mine');
  });

  it('release takes the catalog values at once', () => {
    const id = insertUserRow(c);
    setApplied(c.catalog({ displayName: 'Catalog Name' }));
    releaseModel(getDb(), c.kind, id);
    expect(row(c)).toMatchObject({ id, source: 'catalog', display_name: 'Catalog Name' });
  });

  it('refuses release when the applied catalog does not list the model', () => {
    const id = insertUserRow(c);
    setApplied(c.catalog(null));
    expect(() => releaseModel(getDb(), c.kind, id)).toThrow(OwnershipError);
    expect(row(c)).toMatchObject({ source: 'user', display_name: 'Mine' });
  });
});

describe('catalog overlay: custom rows', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('refuses to release a custom endpoint row', () => {
    const id = Number(getDb().prepare(`
      INSERT INTO media_models (platform, model_id, display_name, modality, priority, enabled, source)
      VALUES ('custom', 'relay', 'Relay', 'search', 0, 1, 'user')
    `).run().lastInsertRowid);
    expect(() => releaseModel(getDb(), 'media', id)).toThrow(/local by definition/);
  });
});
