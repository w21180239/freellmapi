import { dashboardClient } from './dashboard.js';
import { parseForkArgs } from './fork-args.js';
import { formatTable, oneLine } from './table.js';

type Raw = Record<string, unknown>;

const PACE_MS = 120; // management API limit is 600 requests/minute

export function inventoryHelp(): string {
  return [
    'Keys and models per platform (dashboard authentication, no key material):',
    '  freellmapi inventory [--platform a,b] [--list-models] [--json]',
    '  freellmapi enable-models --platform a,b [--apply]',
    '',
    'inventory counts keys (enabled, unhealthy while enabled, undecryptable, active cooldowns) and chat models',
    '(enabled, user-owned, enabled without a usable key) per platform. --list-models also lists the chat',
    'rows of the selected platforms with their source (catalog or user).',
    'enable-models re-enables the disabled chat models of the platforms; without --apply it only lists them.',
    'Options: --url URL, --token TOKEN, --timeout MS (default 30000)',
    'Use FREELLMAPI_DASHBOARD_TOKEN or --token for the dashboard session token.',
  ].join('\n');
}

function rowsOf(value: unknown, what: string): Raw[] {
  if (!Array.isArray(value) || value.some(r => typeof r !== 'object' || r === null || typeof (r as Raw).platform !== 'string')) {
    throw new Error(`The gateway returned an invalid ${what} list`);
  }
  return value as Raw[];
}

function platformsOf(value: string | undefined): string[] | undefined {
  const platforms = value?.split(',').map(p => p.trim().toLowerCase());
  if (platforms?.some(p => !/^[a-z][a-z0-9_-]*$/.test(p))) throw new Error('Invalid --platform list');
  return platforms;
}

export async function runInventory(argv: string[]): Promise<number> {
  const parsed = parseForkArgs(argv, { values: ['--platform'], switches: ['--list-models', '--json'] });
  if (parsed.args.length) throw new Error(`Unknown option: ${parsed.args[0]}`);
  const only = platformsOf(parsed.value('--platform'));
  if (parsed.has('--list-models') && !only) throw new Error('--list-models needs --platform');
  const { request } = dashboardClient(parsed.options);
  const keys = rowsOf(await request('/api/keys'), 'key');
  const models = rowsOf(await request('/api/models'), 'model');

  const stats = new Map<string, Record<string, number | string>>();
  const row = (platform: string): Record<string, number | string> => {
    const found = stats.get(platform) ?? {
      platform, keys: 0, keysEnabled: 0, unhealthy: 0, decryptFailed: 0, cooldowns: 0, models: 0, enabled: 0, user: 0, noKey: 0,
    };
    stats.set(platform, found);
    return found;
  };
  for (const key of keys) {
    const r = row(key.platform as string);
    (r.keys as number) += 1;
    if (key.enabled) (r.keysEnabled as number) += 1;
    if (key.enabled && key.status !== 'healthy') (r.unhealthy as number) += 1;
    // maskedKey is only checked for the failure marker, never printed.
    if (key.maskedKey === '[decrypt failed]') (r.decryptFailed as number) += 1;
    if (Array.isArray(key.cooldowns)) (r.cooldowns as number) += key.cooldowns.length;
  }
  for (const model of models) {
    const r = row(model.platform as string);
    (r.models as number) += 1;
    if (model.enabled) (r.enabled as number) += 1;
    if (model.source === 'user') (r.user as number) += 1;
    if (model.enabled && !model.keyCount) (r.noKey as number) += 1;
  }
  const list = [...stats.values()].filter(r => !only || only.includes(r.platform as string))
    .sort((a, b) => String(a.platform).localeCompare(String(b.platform)));
  const listed = parsed.has('--list-models') ? models.filter(m => only!.includes(m.platform as string)) : [];

  if (parsed.has('--json')) {
    process.stdout.write(`${JSON.stringify({
      platforms: list,
      models: listed.map(m => ({ id: m.id, platform: m.platform, modelId: m.modelId, enabled: m.enabled === true, source: m.source })),
    }, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`${list.length ? formatTable(
    ['PLATFORM', 'KEYS', 'ENABLED', 'UNHEALTHY', 'DECRYPT_FAIL', 'COOLDOWNS', 'MODELS', 'ENABLED', 'USER', 'NO_KEY'],
    list.map(r => [oneLine(r.platform, 40), ...['keys', 'keysEnabled', 'unhealthy', 'decryptFailed', 'cooldowns', 'models', 'enabled', 'user', 'noKey']
      .map(k => String(r[k]))]),
    [1, 2, 3, 4, 5, 6, 7, 8, 9]) : 'No platforms match.'}\n`);
  if (listed.length) {
    process.stdout.write(`\n${formatTable(['ID', 'PLATFORM', 'MODEL', 'ENABLED', 'SOURCE'],
      listed.map(m => [oneLine(m.id, 12), oneLine(m.platform, 40), oneLine(m.modelId, 60), m.enabled ? 'yes' : 'no', oneLine(m.source, 12)]), [0])}\n`);
  }
  return 0;
}

export async function runEnableModels(argv: string[]): Promise<number> {
  const parsed = parseForkArgs(argv, { values: ['--platform'], switches: ['--apply'] });
  if (parsed.args.length) throw new Error(`Unknown option: ${parsed.args[0]}`);
  const only = platformsOf(parsed.value('--platform'));
  if (!only) throw new Error(`enable-models needs --platform.\n\n${inventoryHelp()}`);
  const { request } = dashboardClient(parsed.options);
  const off = rowsOf(await request('/api/models'), 'model')
    .filter(m => only.includes(m.platform as string) && !m.enabled && Number.isSafeInteger(m.id));
  process.stdout.write(`${off.length} disabled chat model(s) on ${only.join(',')}.\n`);
  if (!parsed.has('--apply')) {
    if (off.length) {
      process.stdout.write(`${formatTable(['ID', 'PLATFORM', 'MODEL'],
        off.slice(0, 20).map(m => [oneLine(m.id, 12), oneLine(m.platform, 40), oneLine(m.modelId, 60)]), [0])}\n`);
      if (off.length > 20) process.stdout.write(`...and ${off.length - 20} more\n`);
    }
    process.stdout.write('Dry run; add --apply to re-enable.\n');
    return 0;
  }
  for (const [i, m] of off.entries()) {
    if (i) await new Promise<void>(resolve => { setTimeout(resolve, PACE_MS); });
    // Enabling must restore the routing flag that disabling clears.
    await request(`/api/models/${m.id}`, 'PATCH', { enabled: true, fallbackEnabled: true });
  }
  process.stdout.write(`Re-enabled ${off.length} chat model(s).\n`);
  return 0;
}
