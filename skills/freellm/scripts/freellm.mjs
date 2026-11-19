#!/usr/bin/env node
// freellm: thin CLI over a local FreeLLMAPI router (/v1 + read-only diagnostics).
// Auth: mint a loopback desktop session, read the unified key into memory, log the session out on exit;
// FREELLMAPI_API_KEY only when desktop sign-in is refused. Nothing is written to disk.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HELP = `freellm - use the local FreeLLMAPI free-model pool from a shell

Usage: freellm <command> [args] [options]

Commands:
  ask <prompt> [-]        Chat completion; '-' inserts stdin (e.g. cat f | freellm ask "Summarise:" -)
      --system TEXT  --model ID (default auto)  --max-tokens N  --temperature T
  search <query>          Web search via configured engines
      --max N (default 5)  --news  --answer  --engine ID
  probe [id...]           Pick a model for batches of short answers: prints the first id whose
                          10-token reply ends finish=stop (default candidates: first --limit 6 usable)
  embed <text>...         Embeddings; prints JSON {model, dims, data:[[...]]}
      --model ID
  rerank --query Q <doc>...   Rerank documents; prints index + score
      --top N  --model ID
  decide <state> [-]      Decision model: probabilities, not prose. state = facts (log, diff, text)
      --yesno Q  (P(yes) in 0..1)
      --choice Q --options a,b,c  (one probability per option)
      --score Q --levels low,mid,high  (lowest first; expected level index + distribution)
      --questions-file F.json  (raw questions object, 1-64; merged with the flags above)
      --model ID
  image <prompt> --out FILE   Generate an image (bytes written as returned)
      --size WxH  --n N (N>1 writes FILE-1.ext, FILE-2.ext, ...)  --model ID
  speak <text> --out FILE     Text to speech
      --voice V  --format mp3|wav  --model ID
  transcribe <audio-file>     Speech to text (25 MB limit)
      --lang ISO639-1  --format json|verbose_json|text|vtt  --model ID
  models [--kind K] [--all]   List model ids (default: usable chat models now)
      --kind chat|search|decision|image|audio|transcription|video
  usage                   Month-to-date requests and tokens per provider
  diag [tool]             Read-only diagnostics (default healthcheck: router, search and
                          provider status in one call). Tools:
      healthcheck provider_health provider_list quota_outlook usage_summary
      routing_info cache_stats compression_stats
      usage_summary takes --range 24h|7d|30d

Global: --json (raw JSON response)  --timeout MS (default 120000)
Env: FREELLMAPI_URL (default: port from %APPDATA%/FreeLLMAPI/config.json),
     FREELLMAPI_API_KEY (used only when the router refuses desktop sign-in)
Exit codes: 0 ok, 1 request/upstream error, 2 usage error, 3 router unreachable`;

const DIAG_TOOLS = new Set(['healthcheck', 'provider_health', 'provider_list', 'quota_outlook',
  'usage_summary', 'routing_info', 'cache_stats', 'compression_stats']);
const BOOL_FLAGS = new Set(['json', 'news', 'answer', 'all', 'help']);

class UsageError extends Error {}
class ReachError extends Error {}

function parseArgs(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') { opt.help = true; continue; }
    if (a.startsWith('--')) {
      const name = a.slice(2);
      if (BOOL_FLAGS.has(name)) opt[name] = true;
      else {
        if (i + 1 >= argv.length) throw new UsageError(`--${name} needs a value`);
        opt[name] = argv[++i];
      }
    } else pos.push(a);
  }
  return { pos, opt };
}

function baseUrl() {
  if (process.env.FREELLMAPI_URL) return process.env.FREELLMAPI_URL.replace(/\/+$/, '').replace(/\/v1$/, '');
  const appdata = process.env.APPDATA ?? path.join(os.homedir(), '.config');
  let port = 3001;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(appdata, 'FreeLLMAPI', 'config.json'), 'utf8'));
    if (cfg.port) port = cfg.port;
  } catch { /* no desktop config: server default */ }
  return `http://127.0.0.1:${port}`;
}

let BASE;
let TIMEOUT = 120000;
let sessionToken;

async function http(method, p, { body, headers = {}, raw = false } = {}) {
  let res;
  try {
    res = await fetch(BASE + p, { method, headers, body, signal: AbortSignal.timeout(TIMEOUT) });
  } catch (e) {
    if (e.name === 'TimeoutError') throw new Error(`timeout after ${TIMEOUT} ms: ${method} ${p}`);
    throw new ReachError(`cannot reach FreeLLMAPI at ${BASE} (${e.cause?.code ?? e.message}); is the desktop app running?`);
  }
  if (!res.ok) {
    const text = await res.text();
    let msg = text.slice(0, 500);
    try { msg = JSON.parse(text).error?.message ?? msg; } catch { /* not JSON */ }
    const retry = res.headers.get('retry-after');
    throw new Error(`HTTP ${res.status} ${method} ${p}: ${msg}${retry ? ` (retry after ${retry}s)` : ''}`);
  }
  if (raw) return res;
  const ct = res.headers.get('content-type') ?? '';
  return ct.includes('json') ? res.json() : res.text();
}

// Desktop session first: it always yields the router's current key, while an env key goes stale on regenerate.
async function apiKey() {
  let token;
  try {
    ({ token } = await http('POST', '/api/auth/desktop-session'));
  } catch (e) {
    if (e instanceof ReachError || !process.env.FREELLMAPI_API_KEY) throw e;
    return process.env.FREELLMAPI_API_KEY; // non-loopback router: desktop sign-in is refused
  }
  sessionToken = token;
  const { apiKey: key } = await http('GET', '/api/settings/api-key', { headers: { Authorization: `Bearer ${token}` } });
  if (!key) throw new Error('router returned no unified API key');
  return key;
}

async function logout() {
  if (!sessionToken) return;
  try { await http('POST', '/api/auth/logout', { headers: { Authorization: `Bearer ${sessionToken}` } }); } catch { /* best effort */ }
}

const jsonHeaders = key => ({ Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' });
const postJson = (key, p, obj, extra = {}) => http('POST', p, { body: JSON.stringify(obj), headers: jsonHeaders(key), ...extra });

function readStdin() {
  if (process.stdin.isTTY) throw new UsageError("'-' given but stdin is a terminal");
  return fs.readFileSync(0, 'utf8');
}

function num(v, name) {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new UsageError(`--${name} must be a number`);
  return n;
}

function need(v, what) {
  if (!v) throw new UsageError(`missing ${what}`);
  return v;
}

const out = s => process.stdout.write(s.endsWith('\n') ? s : s + '\n');
const info = s => process.stderr.write(`[freellm] ${s}\n`);

async function cmdAsk(key, pos, opt) {
  // stdin only on explicit '-': an agent shell's stdin can be an open pipe that never hits EOF.
  const dash = pos.indexOf('-');
  if (dash !== -1) pos.splice(dash, 1, readStdin());
  const prompt = pos.join('\n\n');
  need(prompt.trim(), "prompt (argument, or '-' for stdin)");
  const messages = [];
  if (opt.system) messages.push({ role: 'system', content: opt.system });
  messages.push({ role: 'user', content: prompt });
  const body = { model: opt.model ?? 'auto', messages };
  if (opt['max-tokens']) body.max_tokens = num(opt['max-tokens'], 'max-tokens');
  if (opt.temperature) body.temperature = num(opt.temperature, 'temperature');
  const res = await postJson(key, '/v1/chat/completions', body, { raw: true });
  const data = await res.json();
  if (opt.json) return out(JSON.stringify(data, null, 2));
  const choice = data.choices?.[0];
  out(choice?.message?.content ?? '');
  const routed = res.headers.get('x-routed-via');
  info(`model=${data.model ?? '?'}${routed ? ` via=${routed}` : ''} finish=${choice?.finish_reason ?? '?'} tokens=${data.usage?.total_tokens ?? '?'}`);
}

async function cmdSearch(key, pos, opt) {
  const query = need(pos.join(' '), 'query');
  const body = { query, max_results: num(opt.max, 'max') ?? 5 };
  if (opt.news) body.topic = 'news';
  if (opt.answer) body.include_answer = true;
  if (opt.engine) body.engine = opt.engine;
  const data = await postJson(key, '/v1/search', body);
  if (opt.json) return out(JSON.stringify(data, null, 2));
  if (data.answer) out(`Answer: ${data.answer}\n`);
  (data.results ?? []).forEach((r, i) => {
    const text = (r.content ?? r.snippet ?? r.text ?? '').replace(/\s+/g, ' ').slice(0, 300);
    out(`${i + 1}. ${r.title ?? '(no title)'}\n   ${r.url}\n   ${text}`);
  });
  info(`engine=${data.engine ?? '?'} provider=${data.provider ?? '?'} results=${data.results?.length ?? 0}`);
}

async function cmdEmbed(key, pos, opt) {
  need(pos.length, 'text');
  const body = { input: pos.length === 1 ? pos[0] : pos };
  if (opt.model) body.model = opt.model;
  const data = await postJson(key, '/v1/embeddings', body);
  if (opt.json) return out(JSON.stringify(data));
  const vecs = (data.data ?? []).map(d => d.embedding);
  out(JSON.stringify({ model: data.model, dims: vecs[0]?.length ?? 0, data: vecs }));
}

async function cmdRerank(key, pos, opt) {
  const body = { query: need(opt.query, '--query'), documents: pos };
  need(pos.length, 'documents');
  if (opt.top) body.top_n = num(opt.top, 'top');
  if (opt.model) body.model = opt.model;
  const data = await postJson(key, '/v1/rerank', body);
  if (opt.json) return out(JSON.stringify(data, null, 2));
  for (const r of data.results ?? []) out(`${r.index}\t${r.relevance_score.toFixed(4)}\t${(r.document?.text ?? '').slice(0, 80)}`);
  info(`model=${data.model ?? '?'} provider=${data.provider ?? '?'}`);
}

// Providers often return JPEG for a PNG request; detect the real format from the magic bytes.
function sniffExt(b) {
  if (b[0] === 0x89 && b[1] === 0x50) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpg';
  if (b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (b[0] === 0x47 && b[1] === 0x49) return 'gif';
  return 'bin';
}

async function cmdImage(key, pos, opt) {
  const prompt = need(pos.join(' '), 'prompt');
  const file = need(opt.out, '--out FILE');
  const body = { prompt, n: num(opt.n, 'n') ?? 1, response_format: 'b64_json' };
  if (opt.size) body.size = opt.size;
  if (opt.model) body.model = opt.model;
  const data = await postJson(key, '/v1/images/generations', body);
  const items = data.data ?? [];
  if (!items.length) throw new Error('router returned no image');
  const { dir, name, ext } = path.parse(file);
  let total = 0;
  for (const [i, img] of items.entries()) {
    let buf;
    if (img.b64_json) buf = Buffer.from(img.b64_json, 'base64');
    else if (img.url) {
      const r = await fetch(img.url, { signal: AbortSignal.timeout(TIMEOUT) });
      if (!r.ok) throw new Error(`image download HTTP ${r.status}`);
      buf = Buffer.from(await r.arrayBuffer());
    } else throw new Error('router returned no image');
    const target = items.length > 1 ? path.join(dir, `${name}-${i + 1}${ext}`) : file;
    fs.writeFileSync(target, buf);
    total += buf.length;
    out(path.resolve(target));
    const real = sniffExt(buf);
    if (ext.slice(1).toLowerCase().replace('jpeg', 'jpg') !== real) info(`${path.basename(target)} holds ${real} data; rename it before converting or embedding`);
  }
  info(`model=${data.model ?? '?'} provider=${data.provider ?? '?'} files=${items.length} bytes=${total}`);
}

async function cmdSpeak(key, pos, opt) {
  const input = need(pos[0] === '-' ? readStdin() : pos.join(' '), "text (argument, or '-' for stdin)");
  const file = need(opt.out, '--out FILE');
  const body = { input };
  if (opt.voice) body.voice = opt.voice;
  if (opt.format) body.response_format = opt.format;
  if (opt.model) body.model = opt.model;
  const res = await postJson(key, '/v1/audio/speech', body, { raw: true });
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  out(path.resolve(file));
  info(`provider=${res.headers.get('x-provider') ?? '?'} type=${res.headers.get('content-type')} bytes=${fs.statSync(file).size}`);
}

async function cmdTranscribe(key, pos, opt) {
  const file = need(pos[0], 'audio file');
  if (!fs.existsSync(file)) throw new UsageError(`no such file: ${file}`);
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(file)]), path.basename(file));
  form.append('model', opt.model ?? 'auto');
  if (opt.lang) form.append('language', opt.lang);
  if (opt.format) form.append('response_format', opt.format);
  const data = await http('POST', '/v1/audio/transcriptions', { body: form, headers: { Authorization: `Bearer ${key}` } });
  if (opt.json || typeof data !== 'object') return out(typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data));
  out(data.text ?? '');
}

const KINDS = new Set(['chat', 'search', 'decision', 'image', 'audio', 'transcription', 'video']);

async function cmdModels(key, _pos, opt) {
  const kind = opt.kind ?? 'chat';
  if (!KINDS.has(kind)) throw new UsageError(`--kind must be one of: ${[...KINDS].join(' ')}`);
  const auth = { Authorization: `Bearer ${key}` };
  if (kind === 'search' || kind === 'decision') {
    const data = await http('GET', kind === 'search' ? '/v1/search/engines' : '/v1/decisions/models', { headers: auth });
    if (opt.json) return out(JSON.stringify(data, null, 2));
    const rows = (data.data ?? []).filter(m => opt.all || m.available !== false);
    for (const m of rows) out(`${m.id}\t${m.provider ?? ''}`);
    return info(`${rows.length} ${kind} entries${opt.all ? '' : ' available now (--all for every configured one)'}`);
  }
  if (kind !== 'chat') {
    // The media catalog is a desktop-management endpoint: it needs the desktop session, not the unified key.
    if (!sessionToken) throw new Error(`--kind ${kind} needs desktop sign-in (unavailable with FREELLMAPI_API_KEY alone)`);
    const data = await http('GET', '/api/media', { headers: { Authorization: `Bearer ${sessionToken}` } });
    const all = (Array.isArray(data) ? data : data.models ?? []).filter(m => m.modality === kind);
    if (opt.json) return out(JSON.stringify(all, null, 2));
    const rows = all.filter(m => opt.all || m.enabled !== false);
    for (const m of rows) out(`${m.platform}/${m.modelId ?? m.model_id}\t${m.enabled === false ? 'disabled' : 'enabled'}`);
    return info(`${rows.length} ${kind} models${opt.all ? '' : ' enabled (--all includes disabled)'}`);
  }
  const data = await http('GET', '/v1/models', { headers: auth });
  if (opt.json) return out(JSON.stringify(data, null, 2));
  const rows = (data.data ?? []).filter(m => opt.all || m.available !== false);
  for (const m of rows) out(`${m.id}\t${m.context_window ?? m.context_length ?? ''}`);
  info(`${rows.length} models${opt.all ? '' : ' usable now (--all for every configured model)'}`);
}

async function cmdUsage(key, _pos, opt) {
  const data = await http('GET', '/v1/usage', { headers: { Authorization: `Bearer ${key}` } });
  if (opt.json) return out(JSON.stringify(data, null, 2));
  for (const p of data.byPlatform ?? []) out(`${p.platform}\t${p.requests} req\t${p.tokens} tokens`);
  info(`month=${data.month ?? '?'} requests=${data.requests ?? '?'} tokens=${data.tokens ?? '?'} resets=${data.resetsAt ?? '?'}`);
}

// Picks a model for a batch of short answers: first candidate whose tiny reply ends with finish=stop.
async function cmdProbe(key, pos, opt) {
  let ids = pos;
  if (!ids.length) {
    const data = await http('GET', '/v1/models', { headers: { Authorization: `Bearer ${key}` } });
    ids = (data.data ?? []).filter(m => m.available !== false && m.id !== 'auto' && m.id !== 'fusion').map(m => m.id).slice(0, num(opt.limit, 'limit') ?? 6);
  }
  need(ids.length, 'candidate model ids (none usable)');
  for (const id of ids) {
    try {
      const data = await postJson(key, '/v1/chat/completions', { model: id, max_tokens: 10, messages: [{ role: 'user', content: 'Reply with the single word: ok' }] });
      const c = data.choices?.[0];
      const pass = c?.finish_reason === 'stop' && (c.message?.content ?? '').trim().length > 0;
      info(`${id} finish=${c?.finish_reason ?? '?'} ${pass ? 'pass' : 'fail'}`);
      if (pass) return out(id);
    } catch (e) {
      info(`${id} ${e.message.slice(0, 120)}`);
    }
  }
  throw new Error('no candidate returned finish=stop within 10 tokens');
}

const pct = p => `${(Number(p) * 100).toFixed(1)}%`;

async function cmdDecide(key, pos, opt) {
  // '-' reads stdin, like ask.
  const dash = pos.indexOf('-');
  if (dash !== -1) pos.splice(dash, 1, readStdin());
  const state = need(pos.join('\n\n').trim(), "state (argument, or '-' for stdin)");
  const csv = v => String(v).split(',').map(s => s.trim()).filter(Boolean);
  const questions = {};
  if (opt.yesno) questions.yesno = { type: 'noul', instructions: opt.yesno };
  if (opt.choice) {
    const options = csv(need(opt.options, '--options a,b,c (with --choice)'));
    if (options.length < 2) throw new UsageError('--options needs at least two entries');
    questions.choice = { type: 'choice', instructions: opt.choice, criteria: Object.fromEntries(options.map(o => [o, o])) };
  }
  if (opt.score) {
    const levels = csv(need(opt.levels, '--levels low,mid,high (with --score)'));
    if (levels.length < 2) throw new UsageError('--levels needs at least two entries');
    questions.score = { type: 'score', instructions: opt.score, criteria: levels };
  }
  if (opt['questions-file']) {
    if (!fs.existsSync(opt['questions-file'])) throw new UsageError(`no such file: ${opt['questions-file']}`);
    Object.assign(questions, JSON.parse(fs.readFileSync(opt['questions-file'], 'utf8')));
  }
  if (!Object.keys(questions).length) throw new UsageError('give at least one of --yesno, --choice, --score, --questions-file');
  const data = await postJson(key, '/v1/decisions', { model: opt.model ?? 'auto', state, questions });
  if (opt.json) return out(JSON.stringify(data, null, 2));
  for (const [id, a] of Object.entries(data.answers ?? {})) {
    const probs = Object.entries(a.probabilities ?? {});
    if (a.type === 'noul') out(`${id}\tyes=${pct(a.noul)}`);
    else if (a.type === 'choice') out(`${id}\t${a.choice} (confidence ${pct(a.confidence)})\t${probs.map(([k, v]) => `${k}=${pct(v)}`).join(' ')}`);
    else if (a.type === 'score') {
      const top = Object.keys(a.legend ?? {}).length - 1;
      out(`${id}\tlevel~${Number(a.score).toFixed(2)} of 0..${top} (confidence ${pct(a.confidence)})\t${probs.map(([k, v]) => `${a.legend?.[k] ?? k}=${pct(v)}`).join(' ')}`);
    } else out(`${id}\t${JSON.stringify(a)}`);
  }
  info(`model=${data.model ?? '?'} provider=${data.provider ?? '?'}`);
}

async function cmdDiag(key, pos, opt) {
  const tool = pos[0] ?? 'healthcheck';
  if (!DIAG_TOOLS.has(tool)) throw new UsageError(`unknown diag tool '${tool}'; one of: ${[...DIAG_TOOLS].join(' ')}`);
  const args = tool === 'usage_summary' && opt.range ? { range: opt.range } : {};
  const data = await postJson(key, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } },
    { headers: { ...jsonHeaders(key), Accept: 'application/json, text/event-stream' } });
  if (data.error) throw new Error(`diag ${tool}: ${data.error.message}`);
  const r = data.result ?? {};
  if (r.isError) throw new Error(`diag ${tool}: ${r.content?.[0]?.text ?? 'error'}`);
  out(JSON.stringify(r.structuredContent ?? JSON.parse(r.content?.[0]?.text ?? '{}'), null, 2));
}

const COMMANDS = { ask: cmdAsk, search: cmdSearch, decide: cmdDecide, probe: cmdProbe, embed: cmdEmbed, rerank: cmdRerank, image: cmdImage,
  speak: cmdSpeak, transcribe: cmdTranscribe, models: cmdModels, usage: cmdUsage, diag: cmdDiag };

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help' || command === '-h') { out(HELP); return 0; }
  const fn = COMMANDS[command];
  if (!fn) throw new UsageError(`unknown command '${command}'`);
  const { pos, opt } = parseArgs(rest);
  if (opt.help) { out(HELP); return 0; }
  if (opt.timeout) TIMEOUT = num(opt.timeout, 'timeout');
  BASE = baseUrl();
  try {
    await fn(await apiKey(), pos, opt);
  } finally {
    await logout();
  }
  return 0;
}

// Reader closed early (e.g. `| head`): stop quietly.
process.stdout.on('error', e => { if (e.code === 'EPIPE') process.exit(0); throw e; });

main().then(code => { process.exitCode = code; }, err => {
  process.stderr.write(`freellm: ${err.message}\n`);
  process.exitCode = err instanceof UsageError ? 2 : err instanceof ReachError ? 3 : 1;
});
