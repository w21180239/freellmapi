import { readFileSync } from 'node:fs';
import { DashboardHttpError, dashboardClient } from './dashboard.js';
import { fetchRows, parseNewModels, type ModelsCommandOptions, type Row } from './dashboard-models.js';
import { formatTable, oneLine } from './table.js';

// `models add` for every modality. Upstream registers chat rows only; a file
// that names any other modality is handled here, chat rows included, so one
// file can mix kinds. Pure chat files stay on the upstream path.

export const MEDIA_MODALITIES = ['image', 'audio', 'video', 'transcription', 'search', 'decision'] as const;

type Kind = 'chat' | 'media' | 'embedding';
type Raw = Record<string, unknown>;
interface Entry { kind: Kind; row: Raw; result: string; detail: string }

const ROUTES: Record<Kind, string> = { chat: '/api/models', media: '/api/media', embedding: '/api/embeddings' };
const PACE_MS = 120; // management API limit is 600 requests/minute

const text = (v: unknown): boolean => typeof v === 'string' && v.length >= 1 && v.length <= 200;
const natural = (v: unknown): boolean => Number.isSafeInteger(v) && (v as number) >= 0;
const positive = (v: unknown): boolean => Number.isSafeInteger(v) && (v as number) > 0;
const platform = (v: unknown): boolean => typeof v === 'string' && v.length >= 1 && v.length <= 50;
const quotaLabel = (v: unknown): boolean => typeof v === 'string' && v.length <= 200;
const FIELDS: Record<'media' | 'embedding', Record<string, (v: unknown) => boolean>> = {
  media: {
    platform,
    modelId: text,
    modality: v => (MEDIA_MODALITIES as readonly unknown[]).includes(v),
    displayName: text,
    priority: natural,
    quotaLabel,
    meta: v => v === null || (typeof v === 'object' && !Array.isArray(v)),
  },
  embedding: {
    platform,
    modelId: text,
    modality: v => v === 'embedding',
    dimensions: positive,
    family: text,
    displayName: text,
    maxInputTokens: v => v === null || positive(v),
    priority: natural,
    quotaLabel,
  },
};
const REQUIRED = { media: ['platform', 'modelId', 'modality'], embedding: ['platform', 'modelId', 'dimensions'] };

export function forkAddHelp(): string[] {
  return [
    'Other modalities (fork): add "modality" to a row. image, audio, video, transcription, search, decision go to',
    '/api/media (optional: priority, quotaLabel, meta object); embedding goes to /api/embeddings (required:',
    'dimensions; optional: family, maxInputTokens, priority, quotaLabel). Such a file may also hold chat rows.',
    'Rows are sent one at a time; the run stops at the first HTTP 429 (rerun later, present rows are skipped).',
  ];
}

function kindOf(modality: unknown): Kind | undefined {
  if (modality === undefined || modality === 'chat' || modality === 'text') return 'chat';
  if (modality === 'embedding') return 'embedding';
  return (MEDIA_MODALITIES as readonly unknown[]).includes(modality) ? 'media' : undefined;
}

/** Undefined when the file holds no non-chat modality, so the upstream parser (and its errors) apply. */
function parseEntries(content: string): Entry[] | undefined {
  let rows: unknown;
  try { rows = JSON.parse(content); } catch { return undefined; }
  if (!Array.isArray(rows) || !rows.every(r => typeof r === 'object' && r !== null && !Array.isArray(r))) return undefined;
  if (!rows.some(r => kindOf((r as Raw).modality) !== 'chat')) return undefined;

  const problems: string[] = [];
  const seen = new Set<string>();
  const entries: Entry[] = [];
  (rows as Raw[]).forEach((row, i) => {
    const label = `row ${i + 1}`;
    const kind = kindOf(row.modality);
    if (!kind) {
      problems.push(`${label}: unknown modality "${oneLine(row.modality, 40)}"`);
      return;
    }
    if (kind !== 'chat') {
      for (const [key, value] of Object.entries(row)) {
        const check = Object.hasOwn(FIELDS[kind], key) ? FIELDS[kind][key] : undefined;
        if (!check) problems.push(`${label}: unknown field "${oneLine(key, 40)}"`);
        else if (!check(value)) problems.push(`${label}: invalid ${key}`);
      }
      for (const key of REQUIRED[kind]) if (!(key in row)) problems.push(`${label}: missing ${key}`);
      const id = JSON.stringify([kind, row.platform, row.modelId]);
      if (seen.has(id)) problems.push(`${label}: duplicate of an earlier row`);
      seen.add(id);
    }
    entries.push({ kind, row: kind === 'media' ? row : Object.fromEntries(Object.entries(row).filter(([k]) => k !== 'modality')), result: 'would add', detail: '' });
  });
  const chat = entries.filter(e => e.kind === 'chat').map(e => e.row);
  if (chat.length) {
    try { parseNewModels(JSON.stringify(chat)); } catch (error) {
      // The upstream parser numbers rows within the array it was given.
      problems.push(...(error as Error).message.split('\n').slice(1).map(l => l.trim().replace(/^row /, 'chat row ')));
    }
  }
  if (problems.length) {
    const shown = problems.slice(0, 10);
    const more = problems.length > shown.length ? `\n  ...and ${problems.length - shown.length} more` : '';
    throw new Error(`Invalid models file:\n  ${shown.join('\n  ')}${more}`);
  }
  return entries;
}

/** Rows of one kind as the presence check sees them; search and decision rows have their own listings. */
async function listed(request: <T>(path: string) => Promise<T>, kind: Kind): Promise<Row[]> {
  if (kind !== 'media') return fetchRows(request, kind);
  return [...await fetchRows(request, 'media'), ...await fetchRows(request, 'search'), ...await fetchRows(request, 'decision')];
}

const wait = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms); });

/** Returns undefined when the file is not a multi-modality file, so the upstream chat path runs. */
export async function forkAddModels(options: ModelsCommandOptions, file: string | undefined): Promise<number | undefined> {
  if (!file) return undefined;
  let content: string;
  try { content = readFileSync(file, 'utf8'); } catch { return undefined; }
  const results = parseEntries(content);
  if (!results) return undefined;

  const { request } = dashboardClient(options);
  const kinds = [...new Set(results.map(e => e.kind))];
  const load = async (): Promise<Record<string, Row[]>> => Object.fromEntries(
    await Promise.all(kinds.map(async k => [k, await listed(request, k)] as const)));
  const has = (rows: Record<string, Row[]>, e: Entry): boolean => rows[e.kind]
    .some(r => r.platform === e.row.platform && r.modelId === e.row.modelId);
  const before = await load();

  let stopped = false;
  let sent = 0;
  for (const r of results) {
    // Custom rows are keyed by endpoint scope too, so the server's 409 decides for them.
    if (r.row.platform !== 'custom' && has(before, r)) { r.result = 'present'; continue; }
    if (options.dryRun) continue;
    if (stopped) { r.result = 'not sent'; r.detail = 'stopped after HTTP 429'; continue; }
    if (sent++) await wait(PACE_MS);
    try {
      await request(ROUTES[r.kind], 'POST', r.row);
      r.result = 'added';
    } catch (error) {
      if (!(error instanceof DashboardHttpError)) throw error;
      if (error.status === 409) r.result = 'present';
      else if (error.status === 429) { r.result = 'not sent'; r.detail = error.message; stopped = true; }
      else { r.result = 'failed'; r.detail = error.message; }
    }
  }
  if (results.some(r => r.result === 'added')) {
    const after = await load();
    for (const r of results) {
      if (r.result === 'added' && !has(after, r)) { r.result = 'failed'; r.detail = 'not found on read-back'; }
    }
  }
  process.stdout.write(`${formatTable(['ROW', 'KIND', 'PLATFORM', 'MODEL', 'RESULT', 'DETAIL'],
    results.map((r, i) => [String(i + 1), r.kind, oneLine(r.row.platform, 40), oneLine(r.row.modelId, 60), r.result, oneLine(r.detail, 60)]), [0])}\n`);
  const tally = (name: string): number => results.filter(r => r.result === name).length;
  const pending = options.dryRun ? `${tally('would add')} to add` : `${tally('added')} added`;
  const unsent = tally('not sent') ? `, ${tally('not sent')} not sent` : '';
  process.stdout.write(`${options.dryRun ? 'Dry run, nothing sent. ' : ''}${pending}, ${tally('present')} already present, ${tally('failed')} failed${unsent}.\n`);
  return tally('failed') || tally('not sent') ? 1 : 0;
}
