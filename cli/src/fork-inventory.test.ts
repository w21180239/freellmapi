import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from './index.js';

const token = 'dashboard-session==';
const secret = 'provider-secret==';
const calls: Array<{ path: string; method: string; body?: unknown }> = [];
let output: string;

const keys = [
  { id: 1, platform: 'groq', enabled: true, status: 'healthy', maskedKey: secret, cooldowns: [{ modelId: 'a' }] },
  { id: 2, platform: 'groq', enabled: true, status: 'error', maskedKey: '[decrypt failed]', cooldowns: [] },
  { id: 3, platform: 'cerebras', enabled: false, status: 'error', maskedKey: secret },
];
const models = [
  { id: 10, platform: 'groq', modelId: 'g1', enabled: true, keyCount: 2, source: 'catalog' },
  { id: 11, platform: 'groq', modelId: 'g2', enabled: false, keyCount: 2, source: 'user' },
  { id: 12, platform: 'groq', modelId: 'g3', enabled: true, keyCount: 0, source: 'user' },
  { id: 13, platform: 'cerebras', modelId: 'c1', enabled: false, keyCount: 0, source: 'catalog' },
];

beforeEach(() => {
  output = '';
  calls.length = 0;
  vi.stubEnv('FREELLMAPI_DASHBOARD_TOKEN', token);
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output += String(chunk); return true; });
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
    const path = new URL(input).pathname;
    const method = init.method ?? 'GET';
    calls.push({ path, method, body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (path === '/api/keys') return Response.json(keys);
    if (path === '/api/models' && method === 'GET') return Response.json(models);
    if (path.startsWith('/api/models/') && method === 'PATCH') return Response.json({ success: true });
    throw new Error(`Unexpected request: ${path}`);
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('inventory', () => {
  it('counts keys and chat models per platform without key material', async () => {
    expect(await main(['inventory'])).toBe(0);
    expect(output).toMatch(/cerebras\s+1\s+0\s+0\s+0\s+0\s+1\s+0\s+0\s+0/);
    expect(output).toMatch(/groq\s+2\s+2\s+1\s+1\s+1\s+3\s+2\s+2\s+1/);
    expect(output).not.toContain(secret);
    expect(output).not.toContain('decrypt failed');
  });

  it('filters by platform and lists chat rows with their source', async () => {
    expect(await main(['inventory', '--platform', 'groq', '--list-models'])).toBe(0);
    expect(output).not.toContain('cerebras');
    expect(output).toMatch(/11\s+groq\s+g2\s+no\s+user/);
  });

  it('--json carries the same counts', async () => {
    await main(['inventory', '--platform=cerebras', '--json']);
    expect(JSON.parse(output)).toEqual({ platforms: [expect.objectContaining({ platform: 'cerebras', keys: 1, models: 1 })], models: [] });
  });

  it('rejects --list-models without --platform and bad platform names', async () => {
    await expect(main(['inventory', '--list-models'])).rejects.toThrow('--list-models needs --platform');
    await expect(main(['inventory', '--platform', 'Bad Name'])).rejects.toThrow('Invalid --platform list');
    expect(calls).toEqual([]);
  });
});

describe('enable-models', () => {
  it('is a dry run unless --apply is given', async () => {
    expect(await main(['enable-models', '--platform', 'groq'])).toBe(0);
    expect(output).toContain('1 disabled chat model(s) on groq.');
    expect(output).toMatch(/11\s+groq\s+g2/);
    expect(output).toContain('Dry run; add --apply');
    expect(calls.some(c => c.method === 'PATCH')).toBe(false);
  });

  it('re-enables every disabled model on the platforms and restores the routing flag', async () => {
    expect(await main(['enable-models', '--platform', 'groq,cerebras', '--apply'])).toBe(0);
    expect(calls.filter(c => c.method === 'PATCH')).toEqual([
      { path: '/api/models/11', method: 'PATCH', body: { enabled: true, fallbackEnabled: true } },
      { path: '/api/models/13', method: 'PATCH', body: { enabled: true, fallbackEnabled: true } },
    ]);
    expect(output).toContain('Re-enabled 2 chat model(s).');
  });

  it('requires --platform', async () => {
    await expect(main(['enable-models', '--apply'])).rejects.toThrow('enable-models needs --platform');
  });
});
