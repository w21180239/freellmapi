// self-close: an unattended Orca agent session closes its own terminal tab once Orca has recorded the run.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPDATA_DIR, die, log, parseArgs, run, sleep } from './lib.mjs';

const AUTOMATION_NAME = 'freellmapi daily sync';
const LOG_FILE = path.join(APPDATA_DIR, 'logs', 'self-close.log');
const POLL_MS = 10_000;

function orca(args) {
  const r = run('orca', [...args, '--json']);
  try { return JSON.parse(r.stdout).result; } catch { return null; }
}

function findAutomationId(name) {
  return orca(['automations', 'list'])?.automations?.find((a) => a.name === name)?.id ?? null;
}

const latestRun = (id) =>
  (orca(['automations', 'runs', '--id', id])?.runs ?? []).reduce((a, b) => (!a || b.runNumber > a.runNumber ? b : a), null);

function fileLog(msg) {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
}

/**
 * Default: spawn a detached watcher and return at once, so the agent can still write its final report.
 * The watcher waits until the automation's latest run has an output snapshot captured after it started
 * (Orca captures it when the agent's turn ends), then closes the terminal tab.
 */
export async function selfClose(argv) {
  const { flags } = parseArgs(argv, ['automation', 'terminal', 'max-wait']);
  const handle = flags.terminal ?? process.env.ORCA_TERMINAL_HANDLE;
  if (!handle) { log('self-close: no ORCA_TERMINAL_HANDLE (not an Orca terminal); nothing to close'); return; }
  const automationId = flags.automation ?? findAutomationId(AUTOMATION_NAME);
  if (!automationId) die(`self-close: automation "${AUTOMATION_NAME}" not found; pass --automation <id>`);
  const maxWait = Number(flags['max-wait'] ?? 3600);

  if (!flags.watch) {
    const self = fileURLToPath(new URL('./ops.mjs', import.meta.url));
    const child = spawn(process.execPath,
      [self, 'self-close', '--watch', '--terminal', handle, '--automation', automationId, '--max-wait', String(maxWait)],
      { detached: true, windowsHide: true, stdio: 'ignore' });
    child.unref();
    log(`self-close: watcher pid ${child.pid} closes ${handle} once the run is recorded (log: ${LOG_FILE})`);
    return;
  }

  const t0 = Date.now();
  fileLog(`watch ${handle} automation ${automationId} max-wait ${maxWait}s`);
  let reason = 'timeout';
  while ((Date.now() - t0) / 1000 < maxWait) {
    const r = latestRun(automationId);
    if ((r?.outputSnapshot?.capturedAt ?? 0) > t0) { reason = `run ${r.runNumber} ${r.status}`; break; }
    await sleep(POLL_MS);
  }
  await sleep(5000); // let Orca finish persisting the run
  const res = run('orca', ['terminal', 'close', '--terminal', handle, '--tab', '--json']);
  fileLog(`${reason}; terminal close exit ${res.code} ${res.out.replace(/\s+/g, ' ').trim().slice(0, 300)}`);
}
