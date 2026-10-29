import { getDb } from '../db/index.js';

export function registerLocalCapability(platform: string, modelId: string, displayName: string, modality: 'search' | 'decision', quotaLabel = 'user configured'): number {
  const db = getDb();
  const existing = db.prepare('SELECT id, modality FROM media_models WHERE platform = ? AND model_id = ?').get(platform, modelId) as { id: number; modality: string } | undefined;
  if (existing) {
    if (existing.modality !== modality) throw Object.assign(new Error('Model ID is already registered for another capability'), { status: 409 });
    return existing.id;
  }
  const result = db.prepare(`INSERT INTO media_models (platform, model_id, display_name, modality, priority, enabled, quota_label, meta_json)
    VALUES (?, ?, ?, ?, 1000, 0, ?, ?)`).run(platform, modelId, displayName, modality, quotaLabel, JSON.stringify({ userAdded: true }));
  return Number(result.lastInsertRowid);
}

export function isLocalCapability(raw: string | null): boolean {
  try { return JSON.parse(raw ?? '{}')?.userAdded === true; } catch { return false; }
}
