// `ops.mjs cli <args...>`: run the npm CLI (cli/dist) with a loopback desktop-session token in its environment.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, baseUrl, die, withSession } from './lib.mjs';

const ENTRY = path.join(REPO, 'cli', 'dist', 'index.js');

export async function cli(argv) {
  if (!fs.existsSync(ENTRY)) die('cli: cli/dist is not built (run: node skills/freellmapi-ops/scripts/ops.mjs dev-restart)');
  // The token goes to the child's env only; the session is revoked when it exits.
  const code = await withSession(({ token }) => spawnSync(process.execPath, [ENTRY, ...argv], {
    stdio: 'inherit',
    env: { ...process.env, FREELLMAPI_URL: baseUrl(), FREELLMAPI_DASHBOARD_TOKEN: token },
  }).status ?? 1);
  process.exit(code);
}
