// Local overlay on top of the signed catalog. Every model table carries
// `source`: 'catalog' rows follow the catalog, 'user' rows are the owner's and
// catalog sync never updates, prunes or deletes them. This module holds the
// write paths shared by the chat, media and embedding routes: add on a
// built-in platform, edit (content edits claim the row), block (user
// tombstone), claim and release.
import type { Db } from '../db/types.js';
import { getSetting, setSetting } from '../db/index.js';
import { deleteUnusedCustomEndpointKey } from '../lib/custom-provider-cleanup.js';
import { appliedCatalogListsModel, reapplyCachedCatalog, type OwnedModelKind } from './catalog-sync.js';
import { clearSearchPriorityOverride, SEARCH_ENGINE_PLATFORMS, SEARCH_MODALITY } from './search.js';
import { CATALOG_DECISION_PLATFORMS } from './decision.js';
import { MEDIA_PLATFORMS, TRANSCRIPTION_PLATFORMS, VIDEO_PLATFORMS } from './media.js';
import { EMBEDDING_PLATFORMS } from './embeddings.js';
import { clearCatalogModelTombstone, recordCatalogModelTombstone } from './model-state.js';

export class OwnershipError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const MEDIA_ADD_MODALITIES = ['image', 'audio', 'video', 'transcription', 'search', 'decision'] as const;
export type MediaAddModality = typeof MEDIA_ADD_MODALITIES[number];

const MEDIA_ADD_PLATFORMS: Record<MediaAddModality, Set<string>> = {
  image: MEDIA_PLATFORMS,
  audio: MEDIA_PLATFORMS,
  video: VIDEO_PLATFORMS,
  transcription: TRANSCRIPTION_PLATFORMS,
  search: SEARCH_ENGINE_PLATFORMS,
  decision: CATALOG_DECISION_PLATFORMS,
};

const TABLE: Record<OwnedModelKind, string> = { chat: 'models', media: 'media_models', embedding: 'embedding_models' };

// Added rows sort after catalog rows unless the owner says otherwise.
const DEFAULT_USER_PRIORITY = 1000;
const DEFAULT_USER_QUOTA_LABEL = 'user configured';

export interface MediaAddInput {
  platform: string;
  modelId: string;
  modality: MediaAddModality;
  displayName?: string;
  priority?: number;
  quotaLabel?: string;
  meta?: Record<string, unknown> | null;
}

export function addMediaModel(db: Db, input: MediaAddInput): number {
  if (!MEDIA_ADD_PLATFORMS[input.modality].has(input.platform)) {
    throw new OwnershipError(400, `${input.platform} has no built-in ${input.modality} adapter`);
  }
  const existing = db.prepare('SELECT id FROM media_models WHERE platform = ? AND model_id = ?')
    .get(input.platform, input.modelId) as { id: number } | undefined;
  if (existing) {
    throw new OwnershipError(409, `${input.platform}/${input.modelId} already exists (id ${existing.id}); edit or claim it instead`);
  }
  clearCatalogModelTombstone(db, 'media', input.platform, input.modelId);
  const info = db.prepare(`
    INSERT INTO media_models (platform, model_id, display_name, modality, priority, enabled, quota_label, meta_json, source)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, 'user')
  `).run(
    input.platform, input.modelId, input.displayName || input.modelId, input.modality,
    input.priority ?? DEFAULT_USER_PRIORITY, input.quotaLabel ?? DEFAULT_USER_QUOTA_LABEL,
    input.meta && Object.keys(input.meta).length > 0 ? JSON.stringify(input.meta) : null,
  );
  return Number(info.lastInsertRowid);
}

export interface EmbeddingAddInput {
  platform: string;
  modelId: string;
  dimensions: number;
  family?: string;
  displayName?: string;
  maxInputTokens?: number | null;
  priority?: number;
  quotaLabel?: string;
}

export function addEmbeddingModel(db: Db, input: EmbeddingAddInput): number {
  if (!EMBEDDING_PLATFORMS.has(input.platform) || input.platform === 'custom') {
    throw new OwnershipError(400, `${input.platform} has no built-in embedding adapter`);
  }
  const existing = db.prepare('SELECT id FROM embedding_models WHERE platform = ? AND model_id = ?')
    .get(input.platform, input.modelId) as { id: number } | undefined;
  if (existing) {
    throw new OwnershipError(409, `${input.platform}/${input.modelId} already exists (id ${existing.id}); edit or claim it instead`);
  }
  const family = input.family || input.modelId;
  // Vectors only fail over within a family, so its members must agree on size.
  const sibling = db.prepare('SELECT dimensions FROM embedding_models WHERE family = ? LIMIT 1')
    .get(family) as { dimensions: number } | undefined;
  if (sibling && sibling.dimensions !== input.dimensions) {
    throw new OwnershipError(409, `family ${family} is ${sibling.dimensions}-dimensional, not ${input.dimensions}`);
  }
  clearCatalogModelTombstone(db, 'embedding', input.platform, input.modelId);
  const info = db.prepare(`
    INSERT INTO embedding_models
      (family, platform, model_id, display_name, dimensions, max_input_tokens, priority, enabled, quota_label, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 'user')
  `).run(
    family, input.platform, input.modelId, input.displayName || input.modelId, input.dimensions,
    input.maxInputTokens ?? null, input.priority ?? DEFAULT_USER_PRIORITY, input.quotaLabel ?? DEFAULT_USER_QUOTA_LABEL,
  );
  return Number(info.lastInsertRowid);
}

export interface MediaPatch {
  enabled?: boolean;
  priority?: number;
  displayName?: string;
  quotaLabel?: string;
  meta?: Record<string, unknown> | null;
}

export interface EmbeddingPatch {
  enabled?: boolean;
  priority?: number;
  displayName?: string;
  quotaLabel?: string;
}

/**
 * Apply `content` (column -> value) and `enabled` to one row. A content value
 * that differs from the stored one claims a catalog row; enabled alone never
 * does, because a local disable already survives catalog applies.
 */
function patchRow(db: Db, table: string, id: number, content: Record<string, unknown>, enabled: boolean | undefined): Record<string, unknown> {
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!row) throw new OwnershipError(404, `Unknown model ${id}`);
  const changed = Object.entries(content).filter(([column, value]) => value !== undefined && row[column] !== value);
  const assignments = changed.map(([column]) => `${column} = ?`);
  const values = changed.map(([, value]) => value);
  if (changed.length > 0 && row.source === 'catalog') assignments.push("source = 'user'");
  if (enabled !== undefined) {
    assignments.push('enabled = ?');
    values.push(enabled ? 1 : 0);
  }
  if (assignments.length > 0) db.prepare(`UPDATE ${table} SET ${assignments.join(', ')} WHERE id = ?`).run(...values, id);
  return row;
}

export function patchMediaModel(db: Db, id: number, patch: MediaPatch): void {
  const meta = patch.meta === undefined ? undefined
    : patch.meta && Object.keys(patch.meta).length > 0 ? JSON.stringify(patch.meta) : null;
  const before = patchRow(db, 'media_models', id, {
    display_name: patch.displayName,
    priority: patch.priority,
    quota_label: patch.quotaLabel,
    meta_json: meta,
  }, patch.enabled);
  // The search router ranks by the dashboard's local order first; an explicit
  // priority edit must not stay shadowed by it.
  if (patch.priority !== undefined && before.modality === SEARCH_MODALITY) {
    clearSearchPriorityOverride(before.platform as string, before.model_id as string);
  }
}

export function patchEmbeddingModel(db: Db, id: number, patch: EmbeddingPatch): void {
  patchRow(db, 'embedding_models', id, {
    display_name: patch.displayName,
    priority: patch.priority,
    quota_label: patch.quotaLabel,
  }, patch.enabled);
}

/** Delete a media row for good. Built-in shared rows get a user tombstone so
 *  no catalog brings them back; custom rows also drop an unused endpoint key. */
export function blockMediaModel(db: Db, id: number): { tombstoned: boolean } {
  const row = db.prepare('SELECT platform, model_id, key_id FROM media_models WHERE id = ?')
    .get(id) as { platform: string; model_id: string; key_id: number | null } | undefined;
  if (!row) throw new OwnershipError(404, `Unknown media model ${id}`);
  const tombstoned = row.platform !== 'custom' && row.key_id == null;
  if (tombstoned) recordCatalogModelTombstone(db, 'media', row.platform, row.model_id);
  db.prepare('DELETE FROM media_models WHERE id = ?').run(id);
  if (row.platform === 'custom') deleteUnusedCustomEndpointKey(db, row.key_id);
  return { tombstoned };
}

export function blockEmbeddingModel(db: Db, id: number): { tombstoned: boolean } {
  const row = db.prepare('SELECT family, platform, model_id, key_id FROM embedding_models WHERE id = ?')
    .get(id) as { family: string; platform: string; model_id: string; key_id: number | null } | undefined;
  if (!row) throw new OwnershipError(404, `Unknown embedding model ${id}`);
  const tombstoned = row.platform !== 'custom' && row.key_id == null;
  if (tombstoned) recordCatalogModelTombstone(db, 'embedding', row.platform, row.model_id);
  db.prepare('DELETE FROM embedding_models WHERE id = ?').run(id);
  if (row.platform === 'custom') deleteUnusedCustomEndpointKey(db, row.key_id);
  if (getSetting('embeddings_default_family') === row.family) {
    const replacement = db.prepare('SELECT family FROM embedding_models ORDER BY family, priority LIMIT 1')
      .get() as { family: string } | undefined;
    if (replacement) setSetting('embeddings_default_family', replacement.family);
  }
  return { tombstoned };
}

/** Pre-emptive block of a model that has no local row yet. */
export function blockCatalogIdentity(db: Db, kind: OwnedModelKind, platform: string, modelId: string): void {
  if (platform === 'custom') throw new OwnershipError(400, 'Custom endpoint models are not catalog models');
  const existing = db.prepare(`SELECT id FROM ${TABLE[kind]} WHERE platform = ? AND model_id = ?`)
    .get(platform, modelId) as { id: number } | undefined;
  if (existing) throw new OwnershipError(409, `${platform}/${modelId} has a local row (id ${existing.id}); delete that row instead`);
  recordCatalogModelTombstone(db, kind, platform, modelId);
}

export interface UserTombstone {
  kind: OwnedModelKind;
  platform: string;
  modelId: string;
  reason: string | null;
  createdAt: string;
}

export function listUserTombstones(db: Db): UserTombstone[] {
  return (db.prepare(`
    SELECT kind, platform, model_id, reason, created_at FROM catalog_model_tombstones
     WHERE source = 'user' ORDER BY kind, platform, model_id
  `).all() as { kind: OwnedModelKind; platform: string; model_id: string; reason: string | null; created_at: string }[])
    .map(t => ({ kind: t.kind, platform: t.platform, modelId: t.model_id, reason: t.reason, createdAt: t.created_at }));
}

/** Lift a user block and replay the cached catalog so a listed model returns now.
 *  Returns false when there was none. */
export function unblockCatalogIdentity(db: Db, kind: OwnedModelKind, platform: string, modelId: string): boolean {
  const info = db.prepare("DELETE FROM catalog_model_tombstones WHERE kind = ? AND platform = ? AND model_id = ? AND source = 'user'")
    .run(kind, platform, modelId);
  if (info.changes === 0) return false;
  reapplyCachedCatalog();
  return true;
}

export interface LocalRow {
  kind: OwnedModelKind;
  id: number;
  platform: string;
  modelId: string;
  modality: string;
  displayName: string;
  enabled: boolean;
}

/** Every source='user' row across the three tables. */
export function listUserRows(db: Db): LocalRow[] {
  const map = (kind: OwnedModelKind, modality: (r: Record<string, unknown>) => string) =>
    (r: Record<string, unknown>): LocalRow => ({
      kind, id: r.id as number, platform: r.platform as string, modelId: r.model_id as string,
      modality: modality(r), displayName: r.display_name as string, enabled: r.enabled === 1,
    });
  const select = (table: string) => db.prepare(
    `SELECT * FROM ${table} WHERE source = 'user' ORDER BY platform, model_id`,
  ).all() as Record<string, unknown>[];
  return [
    ...select('models').map(map('chat', () => 'chat')),
    ...select('media_models').map(map('media', r => r.modality as string)),
    ...select('embedding_models').map(map('embedding', () => 'embedding')),
  ];
}

type OwnershipRow = { id: number; platform: string; model_id: string; key_id: number | null; source: string };

function ownershipRow(db: Db, kind: OwnedModelKind, id: number): OwnershipRow {
  const row = db.prepare(`SELECT id, platform, model_id, key_id, source FROM ${TABLE[kind]} WHERE id = ?`)
    .get(id) as OwnershipRow | undefined;
  if (!row) throw new OwnershipError(404, `Unknown ${kind} model ${id}`);
  return row;
}

/** Catalog -> user: the catalog stops updating and pruning this row. */
export function claimModel(db: Db, kind: OwnedModelKind, id: number): void {
  const row = ownershipRow(db, kind, id);
  if (row.source !== 'user') db.prepare(`UPDATE ${TABLE[kind]} SET source = 'user' WHERE id = ?`).run(id);
}

/**
 * User -> catalog. Refused for custom-endpoint and key-bound rows (local by
 * definition) and when the applied catalog does not list the model, because
 * the next prune would delete it. On success the cached catalog is re-applied
 * so the row takes the catalog's values at once; chat also drops its overrides.
 */
export function releaseModel(db: Db, kind: OwnedModelKind, id: number): void {
  const row = ownershipRow(db, kind, id);
  if (row.platform === 'custom' || row.key_id != null) {
    throw new OwnershipError(409, 'Custom endpoint and key-bound models are local by definition and cannot be released');
  }
  if (row.source === 'catalog') return;
  if (!appliedCatalogListsModel(db, kind, row.platform, row.model_id)) {
    throw new OwnershipError(409, `The applied catalog does not list ${row.platform}/${row.model_id}; releasing it would delete it on the next sync`);
  }
  db.transaction(() => {
    db.prepare(`UPDATE ${TABLE[kind]} SET source = 'catalog' WHERE id = ?`).run(id);
    if (kind === 'chat') db.prepare('DELETE FROM model_overrides WHERE platform = ? AND model_id = ?').run(row.platform, row.model_id);
  })();
  reapplyCachedCatalog();
}
