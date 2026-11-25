import { DashboardHttpError, dashboardClient } from './dashboard.js';
import { parseForkArgs } from './fork-args.js';
import { MEDIA_MODALITIES } from './fork-models-add.js';
import { formatTable, oneLine } from './table.js';

// The owner's overlay on the signed catalog: rows with source=user are never
// updated or pruned by a catalog sync. Routes: /api/catalog/{local,overlap,tombstones}
// plus POST /api/{models,media,embeddings}/:id/claim|release.

const KINDS = ['chat', 'media', 'embedding'] as const;
type Kind = typeof KINDS[number];
const ROUTES: Record<Kind, string> = { chat: '/api/models', media: '/api/media', embedding: '/api/embeddings' };
const ACTIONS = ['list', 'overlap', 'add', 'block', 'unblock', 'claim', 'release'];
const ADD_FLAGS = ['--modality', '--meta', '--dimensions', '--family', '--display-name'];

type Raw = Record<string, unknown>;

export function catalogHelp(): string {
  return [
    'Local overlay on the signed catalog (dashboard authentication):',
    '  freellmapi catalog list [--json]                 user rows per kind, then user blocks',
    '  freellmapi catalog overlap [--json]              user rows the catalog also lists, with differing fields',
    '  freellmapi catalog add <kind> <platform> <modelId> [--display-name S]',
    '      media: --modality M [--meta JSON]; embedding: --dimensions N [--family F]',
    '  freellmapi catalog block <kind> <platform> <modelId>     delete for good (user tombstone)',
    '  freellmapi catalog unblock <kind> <platform> <modelId>   lift the block',
    '  freellmapi catalog claim <kind> <platform> <modelId>     take a catalog row over',
    '  freellmapi catalog release <kind> <platform> <modelId>   hand it back (refused unless the applied catalog lists it)',
    '',
    `kind is ${KINDS.join(', ')}; media modality is ${MEDIA_MODALITIES.join(', ')}.`,
    'Options: --url URL, --token TOKEN, --timeout MS (default 30000)',
    'Use FREELLMAPI_DASHBOARD_TOKEN or --token for the dashboard session token.',
  ].join('\n');
}

function array(value: unknown, what: string): Raw[] {
  if (!Array.isArray(value) || value.some(r => typeof r !== 'object' || r === null)) {
    throw new Error(`The gateway returned an invalid ${what} list`);
  }
  return value as Raw[];
}

export async function runCatalog(argv: string[]): Promise<number> {
  const parsed = parseForkArgs(argv, { values: ADD_FLAGS, switches: ['--json'] });
  const [action, kindArg, platform, modelId, ...extra] = parsed.args;
  if (!action || !ACTIONS.includes(action)) {
    throw new Error(`Expected catalog ${ACTIONS.join(', ')}.\n\n${catalogHelp()}`);
  }
  const listing = action === 'list' || action === 'overlap';
  if (parsed.has('--json') && !listing) throw new Error('--json is only supported by catalog list and overlap');
  if (action !== 'add' && ADD_FLAGS.some(f => parsed.has(f))) throw new Error(`${ADD_FLAGS.find(f => parsed.has(f))} is only supported by catalog add`);
  if (listing ? kindArg !== undefined : !modelId || extra.length) {
    throw new Error(`Invalid arguments for catalog ${action}.\n\n${catalogHelp()}`);
  }
  const { request } = dashboardClient(parsed.options);

  if (action === 'list') {
    const local = array(await request('/api/catalog/local'), 'local row');
    const blocks = array(await request('/api/catalog/tombstones'), 'block');
    if (parsed.has('--json')) {
      process.stdout.write(`${JSON.stringify({ local, blocks }, null, 2)}\n`);
      return 0;
    }
    const out = [local.length ? formatTable(['KIND', 'MODALITY', 'PLATFORM', 'MODEL', 'ENABLED', 'ID'],
      local.map(r => [oneLine(r.kind, 12), oneLine(r.modality, 20), oneLine(r.platform, 40), oneLine(r.modelId, 60), r.enabled ? 'yes' : 'no', oneLine(r.id, 12)]), [5])
      : 'No local rows.'];
    out.push(blocks.length ? formatTable(['BLOCKED', 'PLATFORM', 'MODEL', 'SINCE'],
      blocks.map(t => [oneLine(t.kind, 12), oneLine(t.platform, 40), oneLine(t.modelId, 60), oneLine(t.createdAt, 30)]))
      : 'No user blocks.');
    process.stdout.write(`${out.join('\n\n')}\n`);
    return 0;
  }
  if (action === 'overlap') {
    const overlap = array(await request('/api/catalog/overlap'), 'overlap');
    if (parsed.has('--json')) {
      process.stdout.write(`${JSON.stringify(overlap, null, 2)}\n`);
      return 0;
    }
    process.stdout.write(`${overlap.length ? formatTable(['KIND', 'MODALITY', 'PLATFORM', 'MODEL', 'ID', 'DIFFERS'],
      overlap.map(o => [oneLine(o.kind, 12), oneLine(o.modality, 20), oneLine(o.platform, 40), oneLine(o.modelId, 60), oneLine(o.id, 12),
        oneLine(Object.keys((o.differs ?? {}) as object).join(',') || 'none', 60)]))
      : 'No local rows overlap the catalog.'}\n`);
    return 0;
  }

  if (!KINDS.includes(kindArg as Kind)) throw new Error(`kind must be one of ${KINDS.join(', ')}.\n\n${catalogHelp()}`);
  const kind = kindArg as Kind;
  const label = `${kind} ${oneLine(platform, 40)}/${oneLine(modelId, 60)}`;
  const run = async (verb: string, done: string, call: () => Promise<unknown>): Promise<number> => {
    try {
      await call();
    } catch (error) {
      if (error instanceof DashboardHttpError) throw new Error(`${verb} ${label}: HTTP ${error.status}`);
      throw error;
    }
    process.stdout.write(`${done} ${label}: ok\n`);
    return 0;
  };
  const identity = { kind, platform, modelId };

  if (action === 'add') {
    const body: Raw = { platform, modelId };
    if (parsed.value('--display-name')) body.displayName = parsed.value('--display-name');
    if (kind === 'media') {
      const modality = parsed.value('--modality');
      if (!MEDIA_MODALITIES.includes(modality as typeof MEDIA_MODALITIES[number])) {
        throw new Error(`catalog add media needs --modality, one of ${MEDIA_MODALITIES.join(', ')}`);
      }
      body.modality = modality;
      if (parsed.value('--meta')) {
        try { body.meta = JSON.parse(parsed.value('--meta')!); } catch { throw new Error('--meta must be a JSON object'); }
      }
      if (parsed.has('--dimensions') || parsed.has('--family')) throw new Error('--dimensions and --family only apply to embedding rows');
    } else if (kind === 'embedding') {
      const dimensions = Number(parsed.value('--dimensions'));
      if (!Number.isSafeInteger(dimensions) || dimensions <= 0) throw new Error('catalog add embedding needs --dimensions, a positive integer');
      body.dimensions = dimensions;
      if (parsed.value('--family')) body.family = parsed.value('--family');
      if (parsed.has('--modality') || parsed.has('--meta')) throw new Error('--modality and --meta only apply to media rows');
    } else if (ADD_FLAGS.some(f => f !== '--display-name' && parsed.has(f))) {
      throw new Error('catalog add chat takes only --display-name');
    }
    return run('add', 'Added', () => request(ROUTES[kind], 'POST', body));
  }
  if (action === 'unblock') return run('unblock', 'Unblocked', () => request('/api/catalog/tombstones', 'DELETE', identity));

  // Catalog rows only: custom-endpoint rows are not part of the overlay.
  const row = await findRow(request, kind, platform, modelId);
  if (action === 'block') {
    return run('block', 'Blocked', () => (row
      ? request(`${ROUTES[kind]}/${row.id}`, 'DELETE')
      : request('/api/catalog/tombstones', 'POST', identity)));
  }
  if (!row) throw new Error(`${action} ${label}: no local row`);
  return run(action, action === 'claim' ? 'Claimed' : 'Released', () => request(`${ROUTES[kind]}/${row.id}/${action}`, 'POST'));
}

async function findRow(
  request: <T>(path: string) => Promise<T>,
  kind: Kind,
  platform: string,
  modelId: string,
): Promise<{ id: number } | undefined> {
  let rows: Raw[];
  if (kind === 'chat') {
    rows = array(await request('/api/models'), 'model');
  } else if (kind === 'embedding') {
    const body = await request<{ families?: unknown }>('/api/embeddings');
    rows = array(body?.families, 'embedding family').flatMap(f => array(f.providers, 'embedding model'));
  } else {
    // Search and decision rows are not in GET /api/media; they have their own listings.
    const media = await request<{ models?: unknown }>('/api/media');
    const engines = array(await request('/api/search/engines'), 'search engine').map(e => ({ ...e, modelId: e.engineId }));
    rows = [...array(media?.models, 'media model'), ...engines, ...array(await request('/api/decisions/models'), 'decision model')];
  }
  const match = rows.find(r => r.platform === platform && r.modelId === modelId && !r.isCustom && !r.endpointScope);
  return match && Number.isSafeInteger(match.id) ? { id: match.id as number } : undefined;
}
