import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from './index.js';

const token = 'dashboard-session==';
const calls: Array<{ path: string; method: string; body?: unknown }> = [];
let output: string;
let failWith: Record<string, number>;

const local = [
  { id: 4, kind: 'chat', modality: 'chat', platform: 'groq', modelId: 'mine', enabled: true },
  { id: 9, kind: 'media', modality: 'image', platform: 'fal', modelId: 'flux', enabled: false },
];
const media = [
  { id: 9, platform: 'fal', modelId: 'flux', modality: 'image', enabled: false },
  { id: 10, platform: 'fal', modelId: 'custom-one', isCustom: true },
];

beforeEach(() => {
  output = '';
  failWith = {};
  calls.length = 0;
  vi.stubEnv('FREELLMAPI_DASHBOARD_TOKEN', token);
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output += String(chunk); return true; });
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
    const path = new URL(input).pathname;
    const method = init.method ?? 'GET';
    calls.push({ path, method, body: init.body ? JSON.parse(String(init.body)) : undefined });
    expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${token}`);
    if (failWith[`${method} ${path}`]) return new Response('{"error":"secret detail"}', { status: failWith[`${method} ${path}`] });
    if (method === 'GET' && path === '/api/catalog/local') return Response.json(local);
    if (method === 'GET' && path === '/api/catalog/tombstones') return Response.json([{ kind: 'chat', platform: 'groq', modelId: 'gone', createdAt: '2026-11-01T00:00:00Z' }]);
    if (method === 'GET' && path === '/api/catalog/overlap') return Response.json([{ id: 4, kind: 'chat', modality: 'chat', platform: 'groq', modelId: 'mine', differs: { contextWindow: [1, 2] } }]);
    if (method === 'GET' && path === '/api/models') return Response.json([
      { id: 4, platform: 'groq', modelId: 'mine' },
      { id: 5, platform: 'custom', modelId: 'mine', endpointScope: 'x' },
    ]);
    if (method === 'GET' && path === '/api/media') return Response.json({ models: media });
    if (method === 'GET' && path === '/api/search/engines') return Response.json([{ id: 20, platform: 'brave', engineId: 'web' }]);
    if (method === 'GET' && path === '/api/decisions/models') return Response.json([]);
    if (method === 'GET' && path === '/api/embeddings') return Response.json({ families: [{ family: 'e', providers: [{ id: 30, platform: 'jina', modelId: 'emb' }] }] });
    return Response.json({ success: true }, { status: method === 'POST' ? 201 : 200 });
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const writes = (): Array<{ path: string; method: string; body?: unknown }> => calls.filter(c => c.method !== 'GET');

describe('catalog list and overlap', () => {
  it('prints user rows and blocks', async () => {
    expect(await main(['catalog', 'list'])).toBe(0);
    expect(output).toMatch(/chat\s+chat\s+groq\s+mine\s+yes\s+4/);
    expect(output).toMatch(/media\s+image\s+fal\s+flux\s+no\s+9/);
    expect(output).toMatch(/BLOCKED\s+PLATFORM\s+MODEL\s+SINCE/);
    expect(output).toMatch(/chat\s+groq\s+gone\s+2026-11-01/);
    expect(output).not.toContain(token);
  });

  it('prints overlap with the differing fields, and --json', async () => {
    expect(await main(['catalog', 'overlap'])).toBe(0);
    expect(output).toMatch(/groq\s+mine\s+4\s+contextWindow/);
    output = '';
    await main(['catalog', 'list', '--json']);
    expect(JSON.parse(output)).toMatchObject({ local: [{ id: 4 }, { id: 9 }], blocks: [{ modelId: 'gone' }] });
  });

  it('rejects arguments and flags that do not belong', async () => {
    await expect(main(['catalog', 'list', 'chat'])).rejects.toThrow('Invalid arguments for catalog list');
    await expect(main(['catalog', 'block', 'chat', 'groq', 'x', '--json'])).rejects.toThrow('--json is only supported');
    await expect(main(['catalog', 'block', 'chat', 'groq', 'x', '--meta', '{}'])).rejects.toThrow('only supported by catalog add');
    await expect(main(['catalog', 'nope'])).rejects.toThrow('Expected catalog');
    await expect(main(['catalog', 'list', '--bogus'])).rejects.toThrow('Unknown option: --bogus');
    expect(calls).toEqual([]);
  });

  it('prints help without a token', async () => {
    vi.stubEnv('FREELLMAPI_DASHBOARD_TOKEN', '');
    expect(await main(['catalog', '--help'])).toBe(0);
    expect(output).toContain('freellmapi catalog claim');
  });
});

describe('catalog add', () => {
  it('posts each kind to its own route with only that kind\'s fields', async () => {
    await main(['catalog', 'add', 'chat', 'groq', 'm1', '--display-name', 'M One']);
    await main(['catalog', 'add', 'media', 'fal', 'flux', '--modality', 'image', '--meta', '{"size":"1k"}']);
    await main(['catalog', 'add', 'embedding', 'jina', 'emb', '--dimensions=768', '--family', 'e']);
    expect(writes()).toEqual([
      { path: '/api/models', method: 'POST', body: { platform: 'groq', modelId: 'm1', displayName: 'M One' } },
      { path: '/api/media', method: 'POST', body: { platform: 'fal', modelId: 'flux', modality: 'image', meta: { size: '1k' } } },
      { path: '/api/embeddings', method: 'POST', body: { platform: 'jina', modelId: 'emb', dimensions: 768, family: 'e' } },
    ]);
    expect(output).toContain('Added media fal/flux: ok');
  });

  it('validates the kind-specific flags before any request', async () => {
    await expect(main(['catalog', 'add', 'media', 'fal', 'x'])).rejects.toThrow('needs --modality');
    await expect(main(['catalog', 'add', 'media', 'fal', 'x', '--modality', 'bogus'])).rejects.toThrow('needs --modality');
    await expect(main(['catalog', 'add', 'media', 'fal', 'x', '--modality', 'image', '--meta', '{'])).rejects.toThrow('--meta must be a JSON object');
    await expect(main(['catalog', 'add', 'embedding', 'jina', 'x'])).rejects.toThrow('needs --dimensions');
    await expect(main(['catalog', 'add', 'embedding', 'jina', 'x', '--dimensions', '8', '--meta', '{}'])).rejects.toThrow('only apply to media');
    await expect(main(['catalog', 'add', 'chat', 'groq', 'x', '--family', 'f'])).rejects.toThrow('takes only --display-name');
    await expect(main(['catalog', 'add', 'video', 'groq', 'x'])).rejects.toThrow('kind must be one of');
    expect(calls).toEqual([]);
  });

  it('reports the HTTP status without echoing the response body', async () => {
    failWith['POST /api/models'] = 409;
    await expect(main(['catalog', 'add', 'chat', 'groq', 'm1'])).rejects.toThrow('add chat groq/m1: HTTP 409');
    await expect(main(['catalog', 'add', 'chat', 'groq', 'm1'])).rejects.not.toThrow('secret detail');
  });
});

describe('catalog block, unblock, claim, release', () => {
  it('blocks an existing catalog row by deleting it, and a missing one with a tombstone', async () => {
    await main(['catalog', 'block', 'media', 'fal', 'flux']);
    await main(['catalog', 'block', 'chat', 'groq', 'absent']);
    expect(writes()).toEqual([
      { path: '/api/media/9', method: 'DELETE' },
      { path: '/api/catalog/tombstones', method: 'POST', body: { kind: 'chat', platform: 'groq', modelId: 'absent' } },
    ]);
  });

  it('ignores custom-endpoint rows when looking a row up', async () => {
    await expect(main(['catalog', 'claim', 'media', 'fal', 'custom-one'])).rejects.toThrow('no local row');
    await main(['catalog', 'block', 'chat', 'custom', 'mine']);
    expect(writes()).toEqual([{ path: '/api/catalog/tombstones', method: 'POST', body: { kind: 'chat', platform: 'custom', modelId: 'mine' } }]);
  });

  it('unblocks by identity in the request body', async () => {
    await main(['catalog', 'unblock', 'chat', 'groq', 'gone']);
    expect(writes()).toEqual([{ path: '/api/catalog/tombstones', method: 'DELETE', body: { kind: 'chat', platform: 'groq', modelId: 'gone' } }]);
  });

  it('claims and releases through the per-kind route, finding search rows too', async () => {
    await main(['catalog', 'claim', 'chat', 'groq', 'mine']);
    await main(['catalog', 'release', 'embedding', 'jina', 'emb']);
    await main(['catalog', 'claim', 'media', 'brave', 'web']);
    expect(writes().map(c => `${c.method} ${c.path}`)).toEqual([
      'POST /api/models/4/claim', 'POST /api/embeddings/30/release', 'POST /api/media/20/claim',
    ]);
  });

  it('fails release without a local row and on a refused release', async () => {
    await expect(main(['catalog', 'release', 'chat', 'groq', 'absent'])).rejects.toThrow('release chat groq/absent: no local row');
    failWith['POST /api/models/4/release'] = 409;
    await expect(main(['catalog', 'release', 'chat', 'groq', 'mine'])).rejects.toThrow('release chat groq/mine: HTTP 409');
  });
});
