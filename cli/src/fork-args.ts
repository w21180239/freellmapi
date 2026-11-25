import type { DashboardOptions } from './dashboard.js';

// Argument parsing for the fork-only commands. They keep their own flag set so
// index.ts parseArgs and its per-flag validation stay identical to upstream.

export interface ForkSpec {
  values?: string[];
  switches?: string[];
}

export interface ForkArgs {
  options: DashboardOptions;
  args: string[];
  help: boolean;
  value(flag: string): string | undefined;
  has(flag: string): boolean;
}

export function parseForkArgs(argv: string[], spec: ForkSpec = {}): ForkArgs {
  const valueFlags = ['--url', '--token', '--timeout', ...(spec.values ?? [])];
  const switchFlags = spec.switches ?? [];
  const values = new Map<string, string>();
  const switches = new Set<string>();
  const args: string[] = [];
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('-')) {
      args.push(arg);
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    const equals = arg.indexOf('=');
    const flag = equals < 0 ? arg : arg.slice(0, equals);
    const inline = equals < 0 ? undefined : arg.slice(equals + 1);
    if (switchFlags.includes(flag)) {
      if (inline !== undefined) throw new Error(`${flag} takes no value`);
      switches.add(flag);
    } else if (valueFlags.includes(flag)) {
      let value = inline;
      if (value === undefined) {
        index += 1;
        value = argv[index];
        if (!value || value.startsWith('-')) throw new Error(`${flag} requires a value`);
      }
      if (!value) throw new Error(`${flag} requires a value`);
      values.set(flag, value);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  const timeout = values.get('--timeout');
  const options: DashboardOptions = {
    url: values.get('--url') ?? (process.env.FREELLMAPI_URL || 'http://localhost:3001'),
    token: values.get('--token') ?? process.env.FREELLMAPI_DASHBOARD_TOKEN,
    timeoutMs: timeout === undefined ? undefined : Number(timeout),
  };
  return { options, args, help, value: flag => values.get(flag), has: flag => switches.has(flag) || values.has(flag) };
}
