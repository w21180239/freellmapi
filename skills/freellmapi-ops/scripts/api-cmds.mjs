// Management-API subcommands: health, inventory, add-models, enable-models, test-sample, lists.
import fs from 'node:fs';
import {
  baseUrl, die, git, healthStatus, listenerPid, log, parseArgs, sleep, withSession,
} from './lib.mjs';

const arr = (j) => (Array.isArray(j) ? j : j?.data ?? j?.models ?? []);
const clip = (s, n = 140) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);
const platformFilter = (flags) => (flags.platform ? new Set(String(flags.platform).split(',')) : null);

/* ---- health ---- */
export async function health() {
  const status = await healthStatus();
  log(`app: ${baseUrl()}  /health=${status}  listener-pid=${listenerPid() ?? 'none'}`);
  log(`repo: ${git('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim()} @ ${git('rev-parse', '--short', 'HEAD').stdout.trim()}`);
  if (status !== 200) die('health=down (start it: node skills/freellmapi-ops/scripts/ops.mjs dev-restart)');
  await withSession(async ({ call }) => {
    const keys = arr((await call('GET', '/api/keys')).json);
    const models = arr((await call('GET', '/api/models')).json);
    const bad = keys.filter((k) => k.enabled && k.status !== 'healthy').length;
    log(`keys: ${keys.length} (enabled ${keys.filter((k) => k.enabled).length}, enabled-but-not-healthy ${bad})`);
    log(`models: ${models.length} (enabled ${models.filter((m) => m.enabled).length})`);
  });
  log('health=ok');
}

/* ---- inventory (non-secret fields only) ---- */
export async function inventory(argv) {
  const { flags } = parseArgs(argv, ['platform']);
  const only = platformFilter(flags);
  await withSession(async ({ call }) => {
    const keys = arr((await call('GET', '/api/keys')).json);
    const models = arr((await call('GET', '/api/models')).json);
    const rows = new Map();
    const row = (p) => rows.get(p) ?? rows.set(p, { platform: p, keys: 0, keysEnabled: 0, unhealthy: 0, models: 0, enabled: 0, user: 0, noKey: 0 }).get(p);
    for (const k of keys) {
      const r = row(k.platform); r.keys++;
      if (k.enabled) r.keysEnabled++;
      if (k.enabled && k.status !== 'healthy') r.unhealthy++;
    }
    for (const m of models) {
      const r = row(m.platform); r.models++;
      if (m.enabled) r.enabled++;
      if (m.source === 'user') r.user++;
      if (m.enabled && !m.keyCount) r.noKey++;
    }
    const list = [...rows.values()].filter((r) => !only || only.has(r.platform)).sort((a, b) => a.platform.localeCompare(b.platform));
    if (flags.json) { log(JSON.stringify(list, null, 1)); return; }
    log(['platform', 'keys', 'keysOn', 'unhealthy', 'models', 'enabled', 'user', 'enabledNoKey'].join('\t'));
    for (const r of list) log([r.platform, r.keys, r.keysEnabled, r.unhealthy, r.models, r.enabled, r.user, r.noKey].join('\t'));
    if (flags['list-models'] && only) {
      for (const m of models.filter((x) => only.has(x.platform))) log(`${m.id}\t${m.platform}\t${m.modelId}\t${m.enabled ? 'on' : 'off'}\t${m.source}`);
    }
    log(`inventory: ${list.length} platforms, ${keys.length} keys, ${models.length} models`);
  });
}

/* ---- add-models: chat, media (any modality) and embedding rows ---- */
const ADD_FIELDS = {
  chat: ['platform', 'modelId', 'displayName', 'contextWindow', 'supportsTools', 'supportsVision', 'rpmLimit', 'rpdLimit', 'tpmLimit', 'tpdLimit', 'keyId', 'endpointScope'],
  media: ['platform', 'modelId', 'modality', 'displayName', 'priority', 'quotaLabel', 'meta'],
  embedding: ['platform', 'modelId', 'dimensions', 'family', 'displayName', 'maxInputTokens', 'priority', 'quotaLabel'],
};
// Absent modality = chat; 'embedding' = embedding table; anything else = media_models.
const kindOf = (m) => (!m.modality || m.modality === 'chat' || m.modality === 'text' ? 'chat' : m.modality === 'embedding' ? 'embedding' : 'media');

export async function addModels(argv) {
  const { flags, pos } = parseArgs(argv, ['skip', 'pace']);
  if (!pos[0]) die('usage: ops.mjs add-models <file.json> [--dry-run] [--skip <id-regex>] [--pace 120]\n  file = JSON array of {platform, modelId, modality?, displayName?, ...}; modality absent = chat, image|audio|video|transcription|search|decision = media (meta?), embedding = embedding (dimensions, family?)');
  const raw = JSON.parse(fs.readFileSync(pos[0], 'utf8'));
  const input = Array.isArray(raw) ? raw : raw.models ?? [];
  const skip = flags.skip ? new RegExp(flags.skip, 'i') : null;
  const pace = Number(flags.pace ?? 120);
  const bad = input.filter((m) => !m?.platform || !m?.modelId || (kindOf(m) === 'embedding' && !m.dimensions));
  if (bad.length) die(`${bad.length} entries lack platform/modelId (or dimensions for embeddings); fix the file first`);

  await withSession(async ({ call }) => {
    const present = async (kind) => new Set((await rowsOf(call, kind))
      .filter((m) => !m.endpointScope && !m.isCustom).map((m) => `${m.platform}\t${m.modelId}`));
    const kinds = [...new Set(input.map(kindOf))];
    const existing = Object.fromEntries(await Promise.all(kinds.map(async (k) => [k, await present(k)])));
    const todo = []; let exists = 0; let skipped = 0;
    for (const m of input) {
      const kind = kindOf(m);
      if (existing[kind].has(`${m.platform}\t${m.modelId}`)) { exists++; continue; }
      if (skip?.test(m.modelId)) { skipped++; continue; }
      todo.push({ kind, body: Object.fromEntries(ADD_FIELDS[kind].filter((f) => m[f] !== undefined).map((f) => [f, m[f]])) });
    }
    const byKind = kinds.map((k) => `${k} ${todo.filter((t) => t.kind === k).length}`).join(', ');
    log(`add-models: input ${input.length}, already present ${exists}, skipped by --skip ${skipped}, to add ${todo.length} (${byKind})`);
    if (flags['dry-run']) { log('add-models: dry-run, nothing written'); return; }

    let added = 0; const rejected = new Map();
    for (const { kind, body } of todo) {
      const r = await call('POST', KINDS[kind], body);
      if (r.status === 429) die(`add-models: still rate-limited after retry; added ${added} so far, rerun later (existing rows are skipped)`);
      if (r.status === 200 || r.status === 201) added++;
      else { const k = clip(r.json?.error?.message ?? `HTTP ${r.status}`, 100); rejected.set(k, [...(rejected.get(k) ?? []), `${body.platform}/${body.modelId}`]); }
      await sleep(pace);
    }
    const live = Object.fromEntries(await Promise.all(kinds.map(async (k) => [k, await present(k)])));
    const readBack = todo.filter((t) => live[t.kind].has(`${t.body.platform}\t${t.body.modelId}`)).length;
    for (const [msg, ids] of rejected) log(`rejected x${ids.length}: ${msg}  e.g. ${ids.slice(0, 3).join(', ')}`);
    log(`add-models: added ${added}, rejected ${[...rejected.values()].flat().length}, read-back present ${readBack}/${todo.length}`);
  });
}

/* ---- enable-models: re-enable disabled chat models (dry-run unless --apply) ---- */
export async function enableModels(argv) {
  const { flags } = parseArgs(argv, ['platform']);
  const only = platformFilter(flags);
  if (!only) die('usage: ops.mjs enable-models --platform a,b [--apply]');
  await withSession(async ({ call }) => {
    const off = arr((await call('GET', '/api/models')).json).filter((m) => only.has(m.platform) && !m.enabled);
    log(`enable-models: ${off.length} disabled models on ${[...only].join(',')}`);
    if (!flags.apply) { for (const m of off.slice(0, 20)) log(`  ${m.id}\t${m.modelId}`); log('dry-run; add --apply to re-enable'); return; }
    let ok = 0;
    for (const m of off) { const r = await call('PATCH', `/api/models/${m.id}`, { enabled: true }); if (r.json?.success) ok++; await sleep(120); }
    log(`enable-models: re-enabled ${ok}/${off.length}`);
  });
}

/* ---- test-sample ---- */
const CLASSES = [
  ['banned', /banned|status is unavailable|token (has been )?revoked|revoked token|account.*(suspended|disabled)/i],
  ['consent', /needs your consent/i],
  ['modality', /does not support chat|is a search provider|supports \/v1\/|not chat/i],
  ['no-key', /No enabled API key/i],
  ['rate-limit', /\b429\b|rate.?limit|too many requests|daily token cap|throttled/i],
  ['quota', /\b402\b|credit|insufficient|quota|exhausted|free plan/i],
  ['timeout', /timeout|timed out|aborted|ETIMEDOUT|ECONNRESET/i],
  ['not-found', /\b404\b|not found/i],
  ['upstream-5xx', /\b5\d\d\b|unavailable|maintenance/i],
];
const classify = (msg) => CLASSES.find(([, re]) => re.test(msg))?.[0] ?? 'model-error';

function rng(seed) { // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export async function testSample(argv) {
  const { flags } = parseArgs(argv, ['platform', 'n', 'pace', 'seed']);
  const n = Number(flags.n ?? 2); const pace = Number(flags.pace ?? 120);
  const rand = rng(Number(flags.seed ?? Date.now()));
  const only = platformFilter(flags);
  if (!only && !flags.all) die('usage: ops.mjs test-sample --platform a,b | --all  [-n 2] [--pace 120] [--seed N]');

  await withSession(async ({ call }) => {
    const models = arr((await call('GET', '/api/models')).json).filter((m) => m.enabled && (!only || only.has(m.platform)));
    // One queue per upstream account: built-ins by platform, custom endpoints by endpoint scope.
    const queues = new Map();
    for (const m of models) {
      const q = m.platform === 'custom' ? `custom:${m.endpointScope}` : m.platform;
      queues.set(q, [...(queues.get(q) ?? []), m]);
    }
    const tally = {}; const failures = []; const stopped = [];
    for (const [q, list] of [...queues].sort()) {
      const pick = list.map((m) => [rand(), m]).sort((a, b) => a[0] - b[0]).slice(0, n).map((x) => x[1]);
      let ok = 0; let rateRun = 0;
      for (const m of pick) {
        let result;
        try {
          const r = await call('POST', `/api/models/${m.id}/test`, undefined, 45000);
          result = r.status === 200 ? r.json : { success: false, error: r.json?.error?.message ?? `HTTP ${r.status}` };
        } catch (e) { result = { success: false, error: `timeout: ${e.name}` }; }
        const cls = result.success ? 'ok' : classify(String(result.error ?? ''));
        tally[cls] = (tally[cls] ?? 0) + 1;
        if (result.success) { ok++; rateRun = 0; } else failures.push(`${q}\t${m.modelId}\t${cls}\t${clip(result.error)}`);
        rateRun = cls === 'rate-limit' ? rateRun + 1 : 0;
        if (cls === 'banned') { stopped.push(`${q}: ban/revoked message, queue stopped`); break; }
        if (rateRun >= 2) { stopped.push(`${q}: repeated rate limits, queue stopped`); break; }
        await sleep(pace);
      }
      log(`${q}\t${ok}/${pick.length} ok\t(${list.length} enabled models)`);
    }
    if (failures.length) { log('--- failures: queue, model, class, message'); failures.forEach((f) => log(f)); }
    stopped.forEach((s) => log(`STOPPED ${s}`));
    log(`test-sample: ${queues.size} queues; ${Object.entries(tally).map(([k, v]) => `${k}=${v}`).join(' ') || 'nothing tested'}`);
  });
}

/* ---- lists: the local overlay on the signed catalog ---- */
const KINDS = { chat: '/api/models', media: '/api/media', embedding: '/api/embeddings' };
const LISTS_USAGE = `usage: ops.mjs lists <subcommand>
  list                                         user-owned rows per kind, then user blocks
  add <kind> <platform> <modelId> [--modality m] [--meta json] [--dimensions n] [--family f] [--display-name s]
  block|unblock <kind> <platform> <modelId>    delete for good (user tombstone) / lift the block
  claim|release <kind> <platform> <modelId>    take a catalog row over / hand it back to the catalog
  overlap                                      user rows the catalog also lists, with differing fields
kind = chat | media | embedding; media modality = image|audio|video|transcription|search|decision`;

// Every row of one kind as {id, platform, modelId}. Search and decision rows
// are not in GET /api/media, so media also reads their own listings.
async function rowsOf(call, kind) {
  if (kind === 'chat') return arr((await call('GET', '/api/models')).json);
  if (kind === 'embedding') return ((await call('GET', '/api/embeddings')).json?.families ?? []).flatMap((f) => f.providers);
  const media = (await call('GET', '/api/media')).json?.models ?? [];
  const search = arr((await call('GET', '/api/search/engines')).json).map((e) => ({ ...e, modelId: e.engineId }));
  const decision = arr((await call('GET', '/api/decisions/models')).json);
  return [...media, ...search, ...decision];
}

async function findRow(call, kind, platform, modelId) {
  const rows = (await rowsOf(call, kind)).filter((r) => r.platform === platform && r.modelId === modelId && !r.isCustom && !r.endpointScope);
  return rows[0] ?? null;
}

function report(label, r, ok = [200, 201]) {
  if (!ok.includes(r.status)) die(`${label}: HTTP ${r.status} ${clip(r.json?.error?.message ?? '', 200)}`);
  log(`${label}: ok`);
}

export async function lists(argv) {
  const { flags, pos } = parseArgs(argv, ['modality', 'meta', 'dimensions', 'family', 'display-name']);
  const [sub, kind, platform, modelId] = pos;
  if (!sub) die(LISTS_USAGE, 2);
  const needIdentity = () => {
    if (!KINDS[kind] || !platform || !modelId) die(LISTS_USAGE, 2);
    return `${kind} ${platform}/${modelId}`;
  };
  await withSession(async ({ call }) => {
    if (sub === 'list') {
      const local = arr((await call('GET', '/api/catalog/local')).json);
      const blocks = arr((await call('GET', '/api/catalog/tombstones')).json);
      for (const r of local) log(`user\t${r.kind}\t${r.modality}\t${r.platform}\t${r.modelId}\t${r.enabled ? 'on' : 'off'}\tid=${r.id}`);
      for (const t of blocks) log(`blocked\t${t.kind}\t${t.platform}\t${t.modelId}\t${t.createdAt}`);
      log(`lists: ${local.length} user rows, ${blocks.length} blocks`);
    } else if (sub === 'overlap') {
      const overlap = arr((await call('GET', '/api/catalog/overlap')).json);
      for (const o of overlap) log(`${o.kind}\t${o.modality}\t${o.platform}\t${o.modelId}\tid=${o.id}\tdiffers: ${Object.keys(o.differs).join(',') || 'none'}`);
      log(`overlap: ${overlap.length} user rows also listed by the catalog`);
    } else if (sub === 'add') {
      const label = needIdentity();
      const body = { platform, modelId, ...(flags['display-name'] ? { displayName: flags['display-name'] } : {}) };
      if (kind === 'media') {
        if (!flags.modality) die('lists add media needs --modality');
        Object.assign(body, { modality: flags.modality }, flags.meta ? { meta: JSON.parse(flags.meta) } : {});
      } else if (kind === 'embedding') {
        if (!flags.dimensions) die('lists add embedding needs --dimensions');
        Object.assign(body, { dimensions: Number(flags.dimensions) }, flags.family ? { family: flags.family } : {});
      }
      report(`add ${label}`, await call('POST', KINDS[kind], body));
    } else if (sub === 'block') {
      const label = needIdentity();
      const row = await findRow(call, kind, platform, modelId);
      report(`block ${label}`, row
        ? await call('DELETE', `${KINDS[kind]}/${row.id}`)
        : await call('POST', '/api/catalog/tombstones', { kind, platform, modelId }));
    } else if (sub === 'unblock') {
      const label = needIdentity();
      report(`unblock ${label}`, await call('DELETE', '/api/catalog/tombstones', { kind, platform, modelId }));
    } else if (sub === 'claim' || sub === 'release') {
      const label = needIdentity();
      const row = await findRow(call, kind, platform, modelId);
      if (!row) die(`${sub} ${label}: no local row`);
      report(`${sub} ${label}`, await call('POST', `${KINDS[kind]}/${row.id}/${sub}`));
    } else die(LISTS_USAGE, 2);
  });
}
