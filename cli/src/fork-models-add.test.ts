import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from './index.js';

const token = 'dashboard-session==';
const calls: Array<{ path: string; method: string; body?: unknown }> = [];
let output: string;
let dir: string;
let stored: Record<string, Array<{ id: number; platform: string; modelId: string; enabled: boolean }>>;
let rejectWith: Record<string, number>;

const file = (rows: unknown): string => {
  const path = join(dir, 'models.json');
  writeFileSync(path, JSON.stringify(rows));
  return path;
};
const posts = (): Array<{ path: string; body: unknown }> => calls.filter(c => c.method === 'POST').map(c => ({ path: c.path, body: c.body }));

beforeEach(() => {
  output = '';
  calls.length = 0;
  rejectWith = {};
  dir = mkdtempSync(join(tmpdir(), 'freellmapi-fork-add-'));
  stored = {
    '/api/models': [{ id: 1, platform: 'groq', modelId: 'llama', enabled: true }],
    media: [{ id: 2, platform: 'fal', modelId: 'flux', enabled: true }],
    search: [],
    decision: [{ id: 3, platform: 'beatapi', modelId: 'jev-1', enabled: true }],
    embedding: [],
  };
  vi.stubEnv('FREELLMAPI_DASHBOARD_TOKEN', token);
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output += String(chunk); return true; });
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
    const path = new URL(input).pathname;
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, method, body });
    if (method === 'GET') {
      if (path === '/api/models') return Response.json(stored['/api/models']);
      if (path === '/api/media') return Response.json({ models: stored.media });
      if (path === '/api/search/engines') return Response.json(stored.search.map(r => ({ ...r, engineId: r.modelId })));
      if (path === '/api/decisions/models') return Response.json(stored.decision);
      if (path === '/api/embeddings') return Response.json({ families: [{ family: 'f', providers: stored.embedding }] });
      throw new Error(`Unexpected request: ${path}`);
    }
    if (rejectWith[body.modelId]) return new Response('{"error":"x"}', { status: rejectWith[body.modelId] });
    const list = path === '/api/models' ? stored['/api/models'] : path === '/api/embeddings' ? stored.embedding
      : body.modality === 'search' ? stored.search : body.modality === 'decision' ? stored.decision : stored.media;
    list.push({ id: 100 + list.length, platform: body.platform, modelId: body.modelId, enabled: true });
    return Response.json({ success: true }, { status: 201 });
  }));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('models add, other modalities', () => {
  it('routes each row by modality, skips present ones and reads back', async () => {
    const rows = [
      { platform: 'fal', modelId: 'new-image', modality: 'image', meta: { size: '1k' }, quotaLabel: 'free' },
      { platform: 'fal', modelId: 'flux', modality: 'image' },
      { platform: 'brave', modelId: 'web', modality: 'search' },
      { platform: 'beatapi', modelId: 'jev-1', modality: 'decision' },
      { platform: 'jina', modelId: 'emb', modality: 'embedding', dimensions: 768, family: 'f', maxInputTokens: null },
      { platform: 'groq', modelId: 'new-chat', contextWindow: 8192 },
      { platform: 'groq', modelId: 'llama', modality: 'chat' },
    ];
    expect(await main(['models', 'add', file(rows)])).toBe(0);
    expect(posts()).toEqual([
      { path: '/api/media', body: rows[0] },
      { path: '/api/media', body: rows[2] },
      { path: '/api/embeddings', body: { platform: 'jina', modelId: 'emb', dimensions: 768, family: 'f', maxInputTokens: null } },
      { path: '/api/models', body: { platform: 'groq', modelId: 'new-chat', contextWindow: 8192 } },
    ]);
    expect(output).toMatch(/1\s+media\s+fal\s+new-image\s+added/);
    expect(output).toMatch(/2\s+media\s+fal\s+flux\s+present/);
    expect(output).toMatch(/4\s+media\s+beatapi\s+jev-1\s+present/);
    expect(output).toMatch(/6\s+chat\s+groq\s+new-chat\s+added/);
    expect(output).toContain('4 added, 3 already present, 0 failed.');
    expect(calls.at(-1)?.method).toBe('GET');
  });

  it('dry run sends nothing', async () => {
    expect(await main(['models', 'add', file([{ platform: 'fal', modelId: 'x', modality: 'audio' }]), '--dry-run'])).toBe(0);
    expect(posts()).toEqual([]);
    expect(output).toContain('Dry run, nothing sent. 1 to add');
  });

  it('validates every row before any request', async () => {
    const rows = [
      { platform: 'fal', modelId: 'a', modality: 'bogus' },
      { platform: 'fal', modelId: 'b', modality: 'image', dimensions: 3 },
      { platform: 'jina', modelId: 'c', modality: 'embedding' },
      { platform: 'fal', modelId: 'b', modality: 'image' },
      { platform: 'groq', modelId: 'd', contextWindow: -1 },
    ];
    await expect(main(['models', 'add', file(rows)])).rejects.toThrow(
      /row 1: unknown modality "bogus"[\s\S]*row 2: unknown field "dimensions"[\s\S]*row 3: missing dimensions[\s\S]*row 4: duplicate[\s\S]*chat row 1: invalid contextWindow/);
    expect(calls).toEqual([]);
  });

  it('counts a 409 as present and a 400 as failed', async () => {
    rejectWith.dup = 409;
    rejectWith.bad = 400;
    const rows = [
      { platform: 'fal', modelId: 'dup', modality: 'video' },
      { platform: 'fal', modelId: 'bad', modality: 'video' },
    ];
    expect(await main(['models', 'add', file(rows)])).toBe(1);
    expect(output).toMatch(/dup\s+present/);
    expect(output).toMatch(/bad\s+failed\s+Dashboard request failed \(HTTP 400\)/);
  });

  it('stops at the first 429 and leaves the rest unsent', async () => {
    rejectWith.first = 429;
    const rows = ['first', 'second'].map(modelId => ({ platform: 'fal', modelId, modality: 'image' }));
    expect(await main(['models', 'add', file(rows)])).toBe(1);
    expect(posts()).toHaveLength(1);
    expect(output).toMatch(/second\s+not sent\s+stopped after HTTP 429/);
    expect(output).toContain('2 not sent');
  });

  it('leaves pure chat files to the upstream path', async () => {
    expect(await main(['models', 'add', file([{ platform: 'groq', modelId: 'new' }])])).toBe(0);
    expect(posts()).toEqual([{ path: '/api/models', body: { platform: 'groq', modelId: 'new' } }]);
    expect(output).not.toContain('KIND');
  });

  it('documents the extra modalities in models --help', async () => {
    await main(['models', '--help']);
    expect(output).toContain('/api/embeddings');
  });
});
