import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from './index.js';

const token = 'dashboard-session==';
const license = 'license-key-secret';
const calls: Array<{ path: string; method: string }> = [];
let output: string;

const state = {
  hasKey: true,
  maskedKey: license,
  license: { valid: true, plan: 'annual', status: 'active' },
  catalog: { appliedVersion: '2026.11.20', appliedTier: 'live', lastSyncMs: Date.UTC(2026, 10, 20), lastError: null },
};

beforeEach(() => {
  output = '';
  calls.length = 0;
  vi.stubEnv('FREELLMAPI_DASHBOARD_TOKEN', token);
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output += String(chunk); return true; });
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
    const path = new URL(input).pathname;
    calls.push({ path, method: init.method ?? 'GET' });
    if (path === '/api/premium') return Response.json(state);
    if (path === '/api/premium/sync') return Response.json({ ...state, sync: { changed: false } });
    throw new Error(`Unexpected request: ${path}`);
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('premium', () => {
  it('prints license and catalog state, never the key', async () => {
    expect(await main(['premium', 'status'])).toBe(0);
    expect(output).toContain('key set, valid annual active');
    expect(output).toContain('version 2026.11.20, tier live, last sync 2026-11-20T00:00:00.000Z');
    expect(output).not.toContain(license);
    expect(calls).toEqual([{ path: '/api/premium', method: 'GET' }]);
  });

  it('defaults to status and surfaces a sync error', async () => {
    state.catalog.lastError = 'offline' as unknown as null;
    try {
      expect(await main(['premium'])).toBe(0);
      expect(output).toContain('error: offline');
    } finally {
      state.catalog.lastError = null;
    }
  });

  it('sync posts and prints the sync result; --json omits the key', async () => {
    expect(await main(['premium', 'sync', '--json'])).toBe(0);
    expect(calls).toEqual([{ path: '/api/premium/sync', method: 'POST' }]);
    const json = JSON.parse(output);
    expect(json).toMatchObject({ hasKey: true, sync: { changed: false } });
    expect(output).not.toContain(license);
  });

  it('rejects unknown actions before any request', async () => {
    await expect(main(['premium', 'nope'])).rejects.toThrow('Expected premium status or sync');
    expect(calls).toEqual([]);
  });
});
