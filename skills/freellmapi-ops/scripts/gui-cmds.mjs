// Dashboard operations over the management API: keys, models (all modalities), usage, requests, settings, premium.
import { die, log, parseArgs, withSession } from './lib.mjs';

const csv = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : null);
const ids = (pos) => pos.map(Number).filter((n) => Number.isInteger(n) && n > 0);
const errMsg = (r) => r.json?.error?.message ?? r.json?.error ?? `HTTP ${r.status}`;
function must(r, what) { if (r.status >= 300) die(`${what}: ${errMsg(r)}`); return r.json; }

/* ---- keys ---- */

async function readSecret() {
  if (process.env.FREELLMAPI_NEW_KEY) return process.env.FREELLMAPI_NEW_KEY.trim();
  if (process.stdin.isTTY) return '';
  let s = '';
  for await (const chunk of process.stdin) s += chunk;
  return s.trim();
}

export async function keys(argv) {
  const { flags, pos } = parseArgs(argv, ['platform', 'label', 'proxy-url']);
  const [action, ...rest] = pos;
  await withSession(async ({ call }) => {
    if (action === 'list' || !action) {
      const plats = csv(flags.platform);
      const rows = must(await call('GET', '/api/keys'), 'keys list').filter((k) => !plats || plats.includes(k.platform));
      // maskedKey is only inspected for the decrypt-failure marker, never printed.
      const out = rows.map((k) => ({
        id: k.id, platform: k.platform, label: k.label ?? '', enabled: k.enabled, status: k.status,
        decrypt: k.maskedKey === '[decrypt failed]' ? 'FAILED' : 'ok', cooldowns: k.cooldowns?.length ?? 0,
        monthReq: k.monthlyUsage?.requests ?? 0,
      }));
      if (flags.json) log(JSON.stringify(out, null, 2));
      else for (const k of out) log(`${String(k.id).padStart(4)}  ${k.platform.padEnd(18)} ${k.enabled ? 'on ' : 'off'} ${String(k.status).padEnd(9)} decrypt=${k.decrypt} cooldowns=${k.cooldowns} month-req=${k.monthReq} ${k.label}`);
      log(`keys: ${out.length} keys, ${out.filter((k) => k.enabled).length} enabled, ${out.filter((k) => k.decrypt === 'FAILED').length} decrypt-failed`);
    } else if (action === 'add') {
      if (!flags.platform) die('usage: keys add --platform P [--label L] [--proxy-url U]  (secret from FREELLMAPI_NEW_KEY or stdin)', 2);
      const key = await readSecret();
      const body = { platform: flags.platform, ...(key ? { key } : {}), ...(flags.label ? { label: flags.label } : {}), ...(flags['proxy-url'] ? { proxyUrl: flags['proxy-url'] } : {}) };
      const j = must(await call('POST', '/api/keys', body, 60000), 'keys add');
      log(`keys add: id ${j.id} platform ${flags.platform} (secret length ${key.length})`);
    } else if (action === 'enable' || action === 'disable') {
      const enabled = action === 'enable';
      if (flags.platform) {
        const j = must(await call('PATCH', `/api/keys/platform/${encodeURIComponent(flags.platform)}`, { enabled }), `keys ${action}`);
        log(`keys ${action}: ${j.updatedKeys} key(s) on ${flags.platform}`);
      } else {
        const list = ids(rest);
        if (!list.length) die(`usage: keys ${action} <id...> | --platform P`, 2);
        for (const id of list) must(await call('PATCH', `/api/keys/${id}`, { enabled }), `keys ${action} ${id}`);
        log(`keys ${action}: ${list.length} key(s)`);
      }
    } else if (action === 'delete') {
      const list = ids(rest);
      if (!list.length) die('usage: keys delete <id...>', 2);
      for (const id of list) must(await call('DELETE', `/api/keys/${id}`), `keys delete ${id}`);
      log(`keys delete: ${list.length} key(s)`);
    } else die('usage: keys <list|add|enable|disable|delete> ...', 2);
  });
}

/* ---- models, every modality ---- */

const MEDIA_KINDS = ['image', 'video', 'audio', 'transcription'];
const KINDS = ['chat', ...MEDIA_KINDS, 'embedding', 'search', 'decision'];

/** Rows of one kind as { id, platform, modelId, enabled }, plus a setter per row. */
async function kindRows(call, kind) {
  if (kind === 'chat') {
    const j = must(await call('GET', '/api/models'), 'models');
    const arr = Array.isArray(j) ? j : j.models ?? j.data ?? [];
    return arr.map((m) => ({ id: m.id, platform: m.platform, modelId: m.modelId, enabled: m.enabled, set: (e) => call('PATCH', `/api/models/${m.id}`, { enabled: e }) }));
  }
  if (MEDIA_KINDS.includes(kind)) {
    const j = must(await call('GET', '/api/media'), 'media');
    return j.models.filter((m) => m.modality === kind)
      .map((m) => ({ id: m.id, platform: m.platform, modelId: m.modelId, enabled: m.enabled, set: (e) => call('PATCH', `/api/media/${m.id}`, { enabled: e }) }));
  }
  if (kind === 'embedding') {
    const j = must(await call('GET', '/api/embeddings'), 'embeddings');
    return j.families.flatMap((f) => f.providers.map((p) => ({
      id: p.id, platform: p.platform, modelId: p.modelId ?? f.family, enabled: p.enabled,
      set: (e) => call('PATCH', `/api/embeddings/${p.id}`, { enabled: e }),
    })));
  }
  if (kind === 'search') {
    const j = must(await call('GET', '/api/search/engines'), 'search engines');
    return j.map((s) => ({ id: s.id, platform: s.platform, modelId: s.engineId, enabled: s.enabled, set: (e) => call('PATCH', `/api/search/engines/${s.id}`, { enabled: e }) }));
  }
  const j = must(await call('GET', '/api/decisions/models'), 'decision models');
  return j.map((d) => ({ id: d.id, platform: d.platform, modelId: d.modelId, enabled: d.enabled, set: (e) => call('PATCH', `/api/decisions/models/${d.id}`, { enabled: e }) }));
}

export async function models(argv) {
  const { flags, pos } = parseArgs(argv, ['kind', 'platform']);
  const [action, ...rest] = pos;
  const kind = flags.kind ?? 'chat';
  if (!KINDS.includes(kind)) die(`--kind must be one of ${KINDS.join(', ')}`, 2);
  const plats = csv(flags.platform);
  await withSession(async ({ call }) => {
    const rows = (await kindRows(call, kind)).filter((r) => !plats || plats.includes(r.platform));
    if (action === 'list' || !action) {
      const shown = flags.disabled ? rows.filter((r) => !r.enabled) : rows;
      if (flags.json) log(JSON.stringify(shown.map(({ set, ...r }) => r), null, 2));
      else for (const r of shown) log(`${String(r.id).padStart(5)}  ${r.enabled ? 'on ' : 'off'} ${r.platform.padEnd(18)} ${r.modelId}`);
      log(`models ${kind}: ${shown.length} shown, ${rows.filter((r) => r.enabled).length}/${rows.length} enabled`);
    } else if (action === 'enable' || action === 'disable') {
      const enabled = action === 'enable';
      const want = ids(rest);
      if (!want.length && !plats) die(`usage: models ${action} --kind K <id...> | --platform a,b`, 2);
      const targets = rows.filter((r) => (want.length ? want.includes(r.id) : true) && r.enabled !== enabled);
      const missing = want.filter((id) => !rows.some((r) => r.id === id));
      if (missing.length) die(`models ${action}: no ${kind} row with id ${missing.join(',')}`);
      for (const r of targets) must(await r.set(enabled), `models ${action} ${r.id}`);
      log(`models ${action}: ${targets.length} ${kind} row(s) changed`);
    } else die('usage: models <list|enable|disable> [--kind K] [--platform a,b] [ids...] [--disabled] [--json]', 2);
  });
}

/* ---- usage and requests ---- */

export async function usage(argv) {
  const { flags } = parseArgs(argv, ['range', 'top']);
  const range = flags.range ?? '7d';
  await withSession(async ({ call }) => {
    const s = must(await call('GET', `/api/analytics/summary?range=${range}`), 'usage');
    const p = must(await call('GET', `/api/analytics/by-platform?range=${range}`), 'usage by-platform');
    log(`usage ${range}: ${s.totalRequests} requests, success ${s.successRate}%, tokens in ${s.totalInputTokens} out ${s.totalOutputTokens}, avg latency ${s.avgLatencyMs}ms`);
    for (const r of p.sort((a, b) => b.requests - a.requests).slice(0, Number(flags.top) || 15)) {
      log(`  ${String(r.endpoint ?? r.platform).padEnd(24)} req=${r.requests} ok=${r.successRate}% err=${r.errorCount} avg=${r.avgLatencyMs}ms`);
    }
  });
}

export async function requests(argv) {
  const { flags } = parseArgs(argv, ['range', 'status', 'limit']);
  const q = new URLSearchParams({ range: flags.range ?? '24h', limit: flags.limit ?? '20', ...(flags.status ? { status: flags.status } : {}) });
  await withSession(async ({ call }) => {
    const j = must(await call('GET', `/api/analytics/requests?${q}`), 'requests');
    for (const r of j.rows) {
      const err = r.error ? ` ${String(r.error).replace(/\s+/g, ' ').slice(0, 100)}` : '';
      log(`${r.createdAt} ${r.status.padEnd(8)} ${r.requestType ?? ''} ${r.platform}/${r.modelId} ${r.latencyMs}ms tok=${r.inputTokens ?? 0}/${r.outputTokens ?? 0}${err}`);
    }
    log(`requests: ${j.rows.length} of ${j.total} in ${q.get('range')}`);
  });
}

/* ---- settings ---- */

// Non-secret GET/PUT pairs under /api/settings. api-key, url-tokens and proxy carry secrets: dashboard only.
const SETTINGS = ['update-check', 'compression', 'unify', 'fusion', 'enable-mcp', 'anthropic-map', 'gemini-map',
  'agent-compatibility', 'output-limit', 'min-context-window', 'guardrails', 'headroom', 'task-weight-share',
  'min-reliability-floor', 'provider-moment-attribution'];

export async function settings(argv) {
  const { pos } = parseArgs(argv);
  const [action, name, value] = pos;
  if (name && !SETTINGS.includes(name)) die(`unknown setting "${name}"; one of: ${SETTINGS.join(', ')}`, 2);
  await withSession(async ({ call }) => {
    if (action === 'get' || !action) {
      for (const n of name ? [name] : SETTINGS) log(`${n}: ${JSON.stringify(must(await call('GET', `/api/settings/${n}`), n))}`);
    } else if (action === 'set') {
      if (!name || value === undefined) die('usage: settings set <name> <json body, as printed by settings get>', 2);
      let body;
      try { body = JSON.parse(value); } catch { die('settings set: value must be JSON, e.g. \'{"enabled":true}\'', 2); }
      must(await call('PUT', `/api/settings/${name}`, body), `settings set ${name}`);
      log(`settings set ${name}: ${JSON.stringify(must(await call('GET', `/api/settings/${name}`), name))}`);
    } else die('usage: settings <get [name]|set <name> <json>>', 2);
  });
}

/* ---- premium / catalog sync ---- */

export async function premium(argv) {
  const { pos } = parseArgs(argv);
  const action = pos[0] ?? 'status';
  if (!['status', 'sync'].includes(action)) die('usage: premium <status|sync>', 2);
  await withSession(async ({ call }) => {
    const j = action === 'sync'
      ? must(await call('POST', '/api/premium/sync', {}, 120000), 'premium sync')
      : must(await call('GET', '/api/premium'), 'premium');
    const c = j.catalog ?? {};
    const lic = j.license ? `${j.license.valid ? 'valid' : 'invalid'} ${j.license.plan ?? ''} ${j.license.status ?? ''}`.trim() : 'none';
    log(`premium: key ${j.hasKey ? 'set' : 'none'}, license ${lic}`);
    log(`catalog: version ${c.appliedVersion ?? '-'} tier ${c.appliedTier ?? '-'} last sync ${c.lastSyncMs ? new Date(c.lastSyncMs).toISOString() : 'never'}${c.lastError ? ` error: ${c.lastError}` : ''}`);
    if (j.sync) log(`premium sync: ${JSON.stringify(j.sync).slice(0, 300)}`);
  });
}
