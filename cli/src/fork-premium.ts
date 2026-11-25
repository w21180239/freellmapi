import { dashboardClient } from './dashboard.js';
import { parseForkArgs } from './fork-args.js';
import { oneLine } from './table.js';

interface PremiumState {
  hasKey?: boolean;
  license?: { valid?: boolean; plan?: string; status?: string } | null;
  catalog?: { appliedVersion?: unknown; appliedTier?: unknown; lastSyncMs?: number | null; lastError?: unknown };
  sync?: unknown;
}

export function premiumHelp(): string {
  return [
    'License and signed-catalog state (dashboard authentication):',
    '  freellmapi premium status [--json]',
    '  freellmapi premium sync [--json]',
    '',
    'Options: --url URL, --token TOKEN, --timeout MS (default 30000; 120000 for sync)',
    'Use FREELLMAPI_DASHBOARD_TOKEN or --token for the dashboard session token.',
    'sync triggers a catalog sync now and prints the state afterwards. The license key is never printed.',
  ].join('\n');
}

export async function runPremium(argv: string[]): Promise<number> {
  const parsed = parseForkArgs(argv, { switches: ['--json'] });
  const [action = 'status', ...extra] = parsed.args;
  if (!['status', 'sync'].includes(action) || extra.length) {
    throw new Error(`Expected premium status or sync.\n\n${premiumHelp()}`);
  }
  const { request } = dashboardClient({
    ...parsed.options,
    timeoutMs: parsed.options.timeoutMs ?? (action === 'sync' ? 120_000 : undefined),
  });
  const state = action === 'sync'
    ? await request<PremiumState>('/api/premium/sync', 'POST', {})
    : await request<PremiumState>('/api/premium');
  if (!state || typeof state !== 'object') throw new Error('The gateway returned an invalid premium state');
  const { hasKey, license, catalog, sync } = state;
  if (parsed.has('--json')) {
    process.stdout.write(`${JSON.stringify({ hasKey: hasKey === true, license, catalog, sync }, null, 2)}\n`);
    return 0;
  }
  const licence = license
    ? oneLine(`${license.valid ? 'valid' : 'invalid'} ${license.plan ?? ''} ${license.status ?? ''}`)
    : 'none';
  const last = catalog?.lastSyncMs ? new Date(catalog.lastSyncMs).toISOString() : 'never';
  process.stdout.write([
    `License  key ${hasKey ? 'set' : 'none'}, ${licence}`,
    `Catalog  version ${oneLine(catalog?.appliedVersion ?? '-', 40)}, tier ${oneLine(catalog?.appliedTier ?? '-', 40)}, last sync ${last}`
      + `${catalog?.lastError ? `, error: ${oneLine(catalog.lastError, 120)}` : ''}`,
    ...(sync === undefined ? [] : [`Sync     ${oneLine(JSON.stringify(sync), 300)}`]),
    '',
  ].join('\n'));
  return 0;
}
