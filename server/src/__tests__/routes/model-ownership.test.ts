import { beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { getDb, initDb, setSetting } from '../../db/index.js';
import { applyCatalog } from '../../services/catalog-sync.js';
import { mintDashboardToken } from '../helpers/auth.js';

// Management API for the local overlay on the catalog: add, edit (content
// edits claim), block/unblock, claim/release, overlap.

type AnyCatalog = Parameters<typeof applyCatalog>[1];
let dashToken = '';

async function call(app: Express, method: string, path: string, body?: unknown) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${dashToken}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

function catalog(over: Partial<AnyCatalog>): AnyCatalog {
  return { version: '2099.01.01', generatedAt: new Date().toISOString(), tier: 'live', models: [], quirks: [], ...over };
}

const CHAT = (displayName: string): AnyCatalog['models'][number] => ({
  platform: 'groq', modelId: 'catalog-chat', displayName, intelligenceRank: 3, speedRank: 5, sizeLabel: 'Medium',
  limits: { rpm: 30, rpd: 1000, tpm: null, tpd: null }, monthlyTokenBudget: '~1M', contextWindow: 8192,
  enabled: true, supportsVision: false, supportsTools: true,
});

const VIDEO = (displayName: string) => ({ platform: 'pollinations', modelId: 'catalog-video', displayName, priority: 1, enabled: true });
const EMBED = (displayName: string) => ({
  family: 'catalog-embed', platform: 'silvr', modelId: 'catalog-embed', displayName,
  dimensions: 1536, maxInputTokens: 8192, priority: 1, enabled: true, quotaLabel: '',
});

function mediaRow(modelId: string) {
  return getDb().prepare('SELECT id, source, display_name, enabled FROM media_models WHERE model_id = ?').get(modelId) as
    { id: number; source: string; display_name: string; enabled: number } | undefined;
}

describe('model ownership routes', () => {
  let app: Express;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  it('POST /api/media adds a user row of any modality on a built-in platform', async () => {
    getDb().prepare("INSERT INTO catalog_model_tombstones (kind, platform, model_id, source) VALUES ('media', 'pollinations', 'my-image', 'user')").run();
    const created = await call(app, 'POST', '/api/media', { platform: 'pollinations', modelId: 'my-image', modality: 'image', meta: { requestStyle: 'json' } });
    expect(created.status).toBe(201);
    const listed = await call(app, 'GET', '/api/media');
    expect(listed.body.models.find((m: any) => m.id === created.body.id)).toMatchObject({ modality: 'image', enabled: true, source: 'user' });
    expect((await call(app, 'GET', '/api/catalog/tombstones')).body).toEqual([]);

    expect((await call(app, 'POST', '/api/media', { platform: 'pollinations', modelId: 'my-image', modality: 'image' })).status).toBe(409);
    expect((await call(app, 'POST', '/api/media', { platform: 'tavily', modelId: 'x', modality: 'image' })).status).toBe(400);
    expect((await call(app, 'POST', '/api/media', { platform: 'custom', modelId: 'x', modality: 'search' })).status).toBe(400);
  });

  it('POST /api/embeddings adds a user row and guards family dimensions', async () => {
    const created = await call(app, 'POST', '/api/embeddings', { platform: 'silvr', modelId: 'my-embed', dimensions: 1024 });
    expect(created.status).toBe(201);
    const listed = await call(app, 'GET', '/api/embeddings');
    const provider = listed.body.families.flatMap((f: any) => f.providers).find((p: any) => p.id === created.body.id);
    expect(provider).toMatchObject({ source: 'user', enabled: true });
    const clash = await call(app, 'POST', '/api/embeddings', { platform: 'nvidia', modelId: 'other', family: 'my-embed', dimensions: 2048 });
    expect(clash.status).toBe(409);
  });

  it('PATCH claims a catalog row on a content edit but not on an enabled toggle', async () => {
    applyCatalog(getDb(), catalog({ videoModels: [VIDEO('Catalog Video')], embeddings: [EMBED('Catalog Embed')] }));
    const video = mediaRow('catalog-video')!;
    expect((await call(app, 'PATCH', `/api/media/${video.id}`, { enabled: false })).status).toBe(200);
    expect(mediaRow('catalog-video')).toMatchObject({ source: 'catalog', enabled: 0 });
    expect((await call(app, 'PATCH', `/api/media/${video.id}`, { priority: 3 })).status).toBe(200);
    expect(mediaRow('catalog-video')!.source).toBe('user');

    const embed = getDb().prepare("SELECT id FROM embedding_models WHERE model_id = 'catalog-embed'").get() as { id: number };
    await call(app, 'PATCH', `/api/embeddings/${embed.id}`, { enabled: false });
    expect((getDb().prepare('SELECT source FROM embedding_models WHERE id = ?').get(embed.id) as { source: string }).source).toBe('catalog');
    await call(app, 'PATCH', `/api/embeddings/${embed.id}`, { displayName: 'Mine' });
    expect((getDb().prepare('SELECT source FROM embedding_models WHERE id = ?').get(embed.id) as { source: string }).source).toBe('user');

    expect((await call(app, 'PATCH', '/api/media/999999', { enabled: true })).status).toBe(404);
    expect((await call(app, 'PATCH', `/api/media/${video.id}`, {})).status).toBe(400);
  });

  it('DELETE blocks built-in rows; the tombstone API lists, adds and lifts blocks', async () => {
    applyCatalog(getDb(), catalog({ videoModels: [VIDEO('Catalog Video')], embeddings: [EMBED('Catalog Embed')] }));
    const video = mediaRow('catalog-video')!;
    expect((await call(app, 'DELETE', `/api/media/${video.id}`)).body).toEqual({ success: true, tombstoned: true });
    const embed = getDb().prepare("SELECT id FROM embedding_models WHERE model_id = 'catalog-embed'").get() as { id: number };
    expect((await call(app, 'DELETE', `/api/embeddings/${embed.id}`)).body).toEqual({ success: true, tombstoned: true });

    const cached = catalog({ videoModels: [VIDEO('Catalog Video')], embeddings: [EMBED('Catalog Embed')] });
    applyCatalog(getDb(), cached);
    setSetting('catalog_applied_json', JSON.stringify(cached));
    expect(mediaRow('catalog-video')).toBeUndefined();
    const listed = await call(app, 'GET', '/api/catalog/tombstones');
    expect(listed.body.map((t: any) => `${t.kind}:${t.platform}:${t.modelId}`)).toEqual([
      'embedding:silvr:catalog-embed', 'media:pollinations:catalog-video',
    ]);

    const identity = { kind: 'media', platform: 'pollinations', modelId: 'catalog-video' };
    expect((await call(app, 'DELETE', '/api/catalog/tombstones', identity)).status).toBe(200);
    expect((await call(app, 'DELETE', '/api/catalog/tombstones', identity)).status).toBe(404);
    // Unblock replays the cached catalog, so the row is back without a new version.
    expect(mediaRow('catalog-video')!.source).toBe('catalog');

    expect((await call(app, 'POST', '/api/catalog/tombstones', identity)).status).toBe(409);
    const ahead = { kind: 'chat', platform: 'groq', modelId: 'not-yet' };
    expect((await call(app, 'POST', '/api/catalog/tombstones', ahead)).status).toBe(201);
    applyCatalog(getDb(), catalog({ models: [{ ...CHAT('Later'), modelId: 'not-yet' }] }));
    expect(getDb().prepare("SELECT 1 FROM models WHERE model_id = 'not-yet'").get()).toBeUndefined();
  });

  it('claim and release move rows between catalog and user', async () => {
    const doc = catalog({ models: [CHAT('Catalog Chat')], videoModels: [VIDEO('Catalog Video')] });
    applyCatalog(getDb(), doc);
    setSetting('catalog_applied_json', JSON.stringify(doc));
    const chat = getDb().prepare("SELECT id FROM models WHERE model_id = 'catalog-chat'").get() as { id: number };

    expect((await call(app, 'POST', `/api/models/${chat.id}/claim`)).body).toEqual({ success: true, id: chat.id, source: 'user' });
    getDb().prepare("UPDATE models SET display_name = 'Mine' WHERE id = ?").run(chat.id);
    expect((await call(app, 'GET', '/api/catalog/local')).body).toEqual([
      expect.objectContaining({ kind: 'chat', id: chat.id, modality: 'chat', displayName: 'Mine' }),
    ]);
    applyCatalog(getDb(), doc);
    const overlap = await call(app, 'GET', '/api/catalog/overlap');
    expect(overlap.body).toEqual([expect.objectContaining({
      kind: 'chat', id: chat.id, differs: { displayName: { local: 'Mine', catalog: 'Catalog Chat' } },
    })]);

    expect((await call(app, 'POST', `/api/models/${chat.id}/release`)).status).toBe(200);
    expect(getDb().prepare('SELECT source, display_name FROM models WHERE id = ?').get(chat.id))
      .toEqual({ source: 'catalog', display_name: 'Catalog Chat' });

    const added = await call(app, 'POST', '/api/media', { platform: 'pollinations', modelId: 'unlisted-video', modality: 'video' });
    const refused = await call(app, 'POST', `/api/media/${added.body.id}/release`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toMatch(/does not list/);
    expect((await call(app, 'POST', '/api/embeddings/999999/claim')).status).toBe(404);
  });

  it('removed duplicate routes are gone', async () => {
    expect((await call(app, 'POST', '/api/search/engines', { platform: 'tavily', engineId: 'x', displayName: 'X' })).status).toBe(404);
    expect((await call(app, 'POST', '/api/decisions/models', { platform: 'cloudflare', modelId: 'x', displayName: 'X' })).status).toBe(404);
    expect((await call(app, 'DELETE', '/api/media/custom/1')).status).toBe(404);
    expect((await call(app, 'PUT', '/api/media/1', { enabled: false })).status).toBe(404);
  });
});
