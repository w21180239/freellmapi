// Shared helpers for ops.mjs: repo paths, process runner, desktop-session client, port lookup.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
/** Per-user data dir: %APPDATA% on Windows, Application Support on macOS, XDG config elsewhere. */
export const APPDATA_DIR = path.join(
  isWin ? (process.env.APPDATA ?? '')
    : isMac ? path.join(os.homedir(), 'Library', 'Application Support')
      : (process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config')),
  'FreeLLMAPI');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const log = (msg = '') => console.log(msg);
export function die(msg, code = 1) { console.error(msg); process.exit(code); }

/** Parse `--flag`, `--key value` and `-n value`; remaining items are positionals. */
export function parseArgs(argv, valueFlags = []) {
  const flags = {}; const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('-') && a.length > 1) {
      const key = a.replace(/^-+/, '');
      if (valueFlags.includes(key)) flags[key] = argv[++i];
      else flags[key] = true;
    } else pos.push(a);
  }
  return { flags, pos };
}

/** Run a command to completion. Arguments are fixed strings from this file, never user input. */
export function run(cmd, args, { cwd = REPO, inherit = false, capture = false } = {}) {
  const viaShell = isWin && /^(npm|npx)$/.test(cmd); // .cmd shims need a shell; a single string avoids the DEP0190 warning
  const r = spawnSync(viaShell ? [cmd, ...args].join(' ') : cmd, viaShell ? [] : args, {
    cwd, shell: viaShell, encoding: 'utf8',
    stdio: inherit ? 'inherit' : 'pipe', maxBuffer: 64 * 1024 * 1024,
  });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, stdout: r.stdout ?? '' };
}
export const git = (...args) => run('git', args);

export function baseUrl() {
  if (process.env.FREELLMAPI_BASE) return process.env.FREELLMAPI_BASE.replace(/\/$/, '');
  try {
    const port = JSON.parse(fs.readFileSync(path.join(APPDATA_DIR, 'config.json'), 'utf8')).port;
    if (port) return `http://127.0.0.1:${port}`;
  } catch { /* fall through */ }
  return 'http://127.0.0.1:31415';
}
export const appPort = () => Number(new URL(baseUrl()).port || 31415);

export async function healthStatus(timeoutMs = 3000) {
  try {
    const res = await fetch(`${baseUrl()}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.status;
  } catch { return 0; }
}

export async function waitForHealth(timeoutSec = 120) {
  const t0 = Date.now();
  while ((Date.now() - t0) / 1000 < timeoutSec) {
    if (await healthStatus() === 200) return Math.round((Date.now() - t0) / 1000);
    await sleep(1500);
  }
  return null;
}

/**
 * Desktop-session client. The token stays in this closure; it is never printed
 * and is revoked in `finally`. `call` retries once after a 429, honouring Retry-After.
 */
export async function withSession(fn) {
  const base = baseUrl();
  const res = await fetch(`${base}/api/auth/desktop-session`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) die(`desktop-session failed: HTTP ${res.status} (is the server running? try: node skills/freellmapi-ops/scripts/ops.mjs serve start)`);
  const { token } = await res.json();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  async function call(method, route, body, timeoutMs = 30000) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await fetch(`${base}${route}`, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (r.status === 429 && attempt === 0) {
        const wait = Math.min(Number(r.headers.get('retry-after')) || 5, 65);
        await sleep(wait * 1000);
        continue;
      }
      let json = null;
      try { json = await r.json(); } catch { /* empty body */ }
      return { status: r.status, json };
    }
  }
  try { return await fn({ call }); }
  finally {
    try { await fetch(`${base}/api/auth/logout`, { method: 'POST', headers, signal: AbortSignal.timeout(5000) }); } catch { /* app gone */ }
  }
}


/** Pid listening on the app port (netstat on Windows, lsof elsewhere), or null. */
export function listenerPid(port = appPort()) {
  if (!isWin) {
    const pid = Number(run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']).stdout.trim().split('\n')[0]);
    return pid || null;
  }
  const r = run('netstat', ['-ano', '-p', 'tcp']);
  for (const line of r.out.split(/\r?\n/)) {
    const m = line.trim().match(/^TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)$/i);
    if (m && Number(m[1]) === port) return Number(m[2]);
  }
  return null;
}

export function processName(pid) {
  if (!isWin) return path.basename(run('ps', ['-p', String(pid), '-o', 'comm=']).stdout.trim()) || null;
  const r = run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
  const m = r.out.match(/^"([^"]+)"/m);
  return m ? m[1] : null;
}
