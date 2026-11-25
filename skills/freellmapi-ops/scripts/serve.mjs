// Headless server lifecycle: build, start/stop/status/logs, logon autostart (Windows Startup .vbs, macOS LaunchAgent).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  APPDATA_DIR, REPO, appPort, die, healthStatus, listenerPid, log, parseArgs, processName, run, sleep,
} from './lib.mjs';

const SERVER_ENTRY = path.join(REPO, 'server', 'dist', 'index.js');
const PID_FILE = path.join(APPDATA_DIR, 'serve.pid');
const LOG_DIR = path.join(APPDATA_DIR, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'freeapi.log');
const LOG_ROTATE_BYTES = 20 * 1024 * 1024;
const STARTUP_DIR = path.join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
const AUTOSTART_VBS = path.join(STARTUP_DIR, 'freellmapi-serve.vbs');
const OPS = path.join(REPO, 'skills', 'freellmapi-ops', 'scripts', 'ops.mjs');

/* ---- build ---- */

function newestMtime(target) {
  if (!fs.existsSync(target)) return 0;
  const st = fs.statSync(target);
  if (!st.isDirectory()) return st.mtimeMs;
  let max = 0;
  for (const e of fs.readdirSync(target, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    max = Math.max(max, newestMtime(path.join(target, e.name)));
  }
  return max;
}

const TARGETS = {
  server: { src: ['server/src', 'shared'], out: 'server/dist', ws: 'server' },
  client: { src: ['client/src', 'client/index.html', 'shared'], out: 'client/dist', ws: 'client' },
};

/** Build server and client when `force` or when sources are newer than the output. */
export function build({ force = false } = {}) {
  for (const [name, t] of Object.entries(TARGETS)) {
    const srcT = Math.max(...t.src.map((s) => newestMtime(path.join(REPO, s))));
    const outT = newestMtime(path.join(REPO, t.out));
    if (!force && outT >= srcT) { log(`build: ${name} up to date`); continue; }
    const t0 = Date.now();
    // --noEmitOnError: a failing server build leaves the last good dist in place.
    const r = run('npm', ['run', 'build', '-w', t.ws, ...(name === 'server' ? ['--', '--noEmitOnError'] : [])]);
    if (r.code !== 0) {
      log(r.out.split(/\r?\n/).slice(-25).join('\n'));
      die(`build: ${name} failed (output tail above)`);
    }
    log(`build: ${name} ok (${Math.round((Date.now() - t0) / 1000)}s)`);
  }
}

/* ---- process control ---- */

function pidFromFile() {
  try { return Number(fs.readFileSync(PID_FILE, 'utf8').trim()) || null; } catch { return null; }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

function killTree(pid) {
  if (isWin) { run('taskkill', ['/PID', String(pid), '/T', '/F']); return; }
  // Detached start makes the server a process-group leader; signal the group, then the pid.
  try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
}

/**
 * Stop whatever serves the port: the headless node server (matched by pid file),
 * the dev Electron app, or the installed FreeLLMAPI.exe. Refuses any other process.
 */
export async function stopServer() {
  const notes = [];
  const pid = listenerPid();
  if (pid) {
    const name = processName(pid) ?? 'unknown';
    const ours = /^node(\.exe)?$/i.test(name) && pid === pidFromFile();
    if (!ours && !/^(electron|FreeLLMAPI)(\.exe)?$/i.test(name)) {
      die(`serve: port ${appPort()} is held by pid ${pid} (${name}); stop it manually`);
    }
    killTree(pid);
    for (let i = 0; i < 20 && listenerPid(); i++) await sleep(1000);
    if (listenerPid()) die(`serve: pid ${pid} still holds port ${appPort()} after 20s`);
    notes.push(`stopped ${name} pid ${pid}`);
  }
  // The installed app may sit on a scanned port (31416+) and still shares the DB.
  if (isWin) {
    const packaged = run('tasklist', ['/FI', 'IMAGENAME eq FreeLLMAPI.exe', '/FO', 'CSV', '/NH']).out;
    for (const m of packaged.matchAll(/^"FreeLLMAPI\.exe","(\d+)"/gim)) { killTree(Number(m[1])); notes.push(`stopped FreeLLMAPI.exe pid ${m[1]}`); }
  }
  fs.rmSync(PID_FILE, { force: true });
  return notes.length ? notes.join('; ') : 'nothing running';
}

function rotateLog() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  try {
    if (fs.statSync(LOG_FILE).size > LOG_ROTATE_BYTES) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
  } catch { /* no log yet */ }
}

function serverEnv() {
  const env = { ...process.env };
  // Unset NODE_ENV keeps the dev key fallback: the server reads the key file next to the DB,
  // as the Electron app does. production would demand ENCRYPTION_KEY; development skips migrations.
  delete env.NODE_ENV;
  delete env.ENCRYPTION_KEY;
  return Object.assign(env, {
    PORT: String(appPort()),
    HOST: '127.0.0.1',
    FREEAPI_DB_PATH: path.join(APPDATA_DIR, 'freeapi.db'),
    CLIENT_DIST: path.join(REPO, 'client', 'dist'),
    // Enables loopback-only desktop sign-in (routes/auth.ts desktopSignInAllowed) for ops.mjs and freellm.
    FREEAPI_DESKTOP: '1',
  });
}

/** Start the headless server detached; returns { pid, secs } once /health is 200. */
export async function startServer({ timeoutSec = 90 } = {}) {
  const held = listenerPid();
  if (held) {
    if (held === pidFromFile() && await healthStatus() === 200) return { pid: held, secs: 0, already: true };
    die(`serve: port ${appPort()} is held by pid ${held} (${processName(held) ?? 'unknown'}); run: ops.mjs serve stop`);
  }
  if (!fs.existsSync(SERVER_ENTRY)) die(`serve: ${SERVER_ENTRY} missing; run: ops.mjs serve start (without --no-build)`);
  rotateLog();
  const fd = fs.openSync(LOG_FILE, 'a');
  fs.writeSync(fd, `\n=== serve start ${new Date().toISOString()} ===\n`);
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: path.join(REPO, 'server'), env: serverEnv(), detached: true, windowsHide: true, stdio: ['ignore', fd, fd],
  });
  child.unref();
  fs.closeSync(fd);
  fs.writeFileSync(PID_FILE, String(child.pid));
  const t0 = Date.now();
  while ((Date.now() - t0) / 1000 < timeoutSec) {
    if (!alive(child.pid)) break;
    if (await healthStatus() === 200) return { pid: child.pid, secs: Math.round((Date.now() - t0) / 1000) };
    await sleep(1000);
  }
  console.error(`serve: /health did not return 200 (pid ${child.pid} ${alive(child.pid) ? 'still running' : 'exited'}); log tail:\n${tail(20)}`);
  return null;
}

function tail(n) {
  try { return fs.readFileSync(LOG_FILE, 'utf8').split(/\r?\n/).slice(-n - 1).join('\n'); } catch { return '(no log)'; }
}

/** Stop, start, report. Used by dev-restart and sync-upstream. */
export async function restartServer() {
  log(`serve: ${await stopServer()}`);
  const r = await startServer();
  if (!r) process.exit(1);
  log(`serve: /health=200 after ${r.secs}s (pid ${r.pid})`);
  return r;
}

/* ---- logon autostart (Startup-folder .vbs, same pattern as magpie-gateway.vbs) ---- */

const FOREIGN = /freellm|electron/i;

function foreignAutostart() {
  const found = [];
  for (const f of fs.existsSync(STARTUP_DIR) ? fs.readdirSync(STARTUP_DIR) : []) {
    const p = path.join(STARTUP_DIR, f);
    if (p !== AUTOSTART_VBS && FOREIGN.test(f)) found.push({ kind: 'startup', id: p });
  }
  const runKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
  for (const line of run('reg', ['query', runKey]).out.split(/\r?\n/)) {
    const m = line.match(/^\s{4}(.+?)\s{4}REG_\w+\s{4}(.*)$/);
    if (m && FOREIGN.test(`${m[1]} ${m[2]}`)) found.push({ kind: 'run', id: m[1], key: runKey });
  }
  for (const line of run('schtasks', ['/query', '/fo', 'csv', '/nh']).out.split(/\r?\n/)) {
    const m = line.match(/^"([^"]+)"/);
    if (m && FOREIGN.test(m[1])) found.push({ kind: 'task', id: m[1] });
  }
  return found;
}

function removeForeign(e) {
  if (e.kind === 'startup') fs.rmSync(e.id, { force: true });
  if (e.kind === 'run') run('reg', ['delete', e.key, '/v', e.id, '/f']);
  if (e.kind === 'task') run('schtasks', ['/delete', '/tn', e.id, '/f']);
}

/* macOS: a LaunchAgent runs `serve start --no-build` once at login. */
const LA_LABEL = 'com.freellmapi.serve';
const LA_PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LA_LABEL}.plist`);
const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function autostartMac(action) {
  const domain = `gui/${process.getuid()}`;
  if (action === 'on') {
    const env = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin` };
    // launchd does not read the shell profile; carry a corporate CA bundle over if one is set.
    if (process.env.NODE_EXTRA_CA_CERTS) env.NODE_EXTRA_CA_CERTS = process.env.NODE_EXTRA_CA_CERTS;
    const args = [process.execPath, OPS, 'serve', 'start', '--no-build'];
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Written by: ops.mjs serve autostart on -->
<plist version="1.0">
<dict>
  <key>Label</key><string>${LA_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env).map(([k, v]) => `    <key>${k}</key><string>${xml(v)}</string>`).join('\n')}
  </dict>
  <key>WorkingDirectory</key><string>${xml(REPO)}</string>
  <key>RunAtLoad</key><true/>
  <!-- serve start exits after the detached server is healthy; keep the server alive. -->
  <key>AbandonProcessGroup</key><true/>
  <key>StandardOutPath</key><string>${xml(path.join(LOG_DIR, 'launchd.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(LOG_DIR, 'launchd.log'))}</string>
</dict>
</plist>
`;
    fs.mkdirSync(path.dirname(LA_PLIST), { recursive: true });
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.writeFileSync(LA_PLIST, plist);
    run('launchctl', ['bootout', `${domain}/${LA_LABEL}`]);
    const r = run('launchctl', ['bootstrap', domain, LA_PLIST]);
    if (r.code !== 0) die(`autostart: launchctl bootstrap failed: ${r.out.trim()}`);
    log(`autostart: on (${LA_PLIST})`);
  } else if (action === 'off') {
    run('launchctl', ['bootout', `${domain}/${LA_LABEL}`]);
    fs.rmSync(LA_PLIST, { force: true });
    log('autostart: off');
  } else if (action === 'status') {
    const loaded = run('launchctl', ['print', `${domain}/${LA_LABEL}`]).code === 0;
    log(`autostart: ${fs.existsSync(LA_PLIST) ? `on (${LA_PLIST})${loaded ? '' : ', not loaded'}` : 'off'}`);
  } else die('usage: serve autostart <on|off|status>', 2);
}

function autostart(action) {
  if (isMac) return autostartMac(action);
  if (!isWin) die('autostart: only Windows and macOS are supported', 2);
  if (action === 'on') {
    const vbs = [
      `' Start the headless FreeLLMAPI server at logon, hidden. Written by: ops.mjs serve autostart on`,
      `CreateObject("WScript.Shell").Run """${process.execPath}"" ""${OPS}"" serve start --no-build", 0, False`,
      '',
    ].join('\r\n');
    fs.writeFileSync(AUTOSTART_VBS, vbs);
    for (const e of foreignAutostart()) { removeForeign(e); log(`autostart: removed ${e.kind} entry ${e.id}`); }
    log(`autostart: on (${AUTOSTART_VBS})`);
  } else if (action === 'off') {
    fs.rmSync(AUTOSTART_VBS, { force: true });
    log('autostart: off');
  } else if (action === 'status') {
    log(`autostart: ${fs.existsSync(AUTOSTART_VBS) ? `on (${AUTOSTART_VBS})` : 'off'}`);
    for (const e of foreignAutostart()) log(`autostart: other FreeLLMAPI/Electron entry (${e.kind}) ${e.id}; \`autostart on\` removes it`);
  } else die('usage: serve autostart <on|off|status>', 2);
}

/* ---- subcommand ---- */

export async function serve(argv) {
  const { flags, pos } = parseArgs(argv, ['n']);
  const [action, sub] = pos;
  if (action === 'start') {
    if (!flags['no-build']) build();
    const r = await startServer();
    if (!r) process.exit(1);
    log(r.already ? `serve: already running (pid ${r.pid}), /health=200` : `serve: /health=200 after ${r.secs}s (pid ${r.pid})`);
  } else if (action === 'stop') {
    log(`serve: ${await stopServer()}`);
  } else if (action === 'restart') {
    if (!flags['no-build']) build();
    await restartServer();
  } else if (action === 'status') {
    const pid = listenerPid();
    const filePid = pidFromFile();
    log(`serve: port ${appPort()} listener ${pid ? `pid ${pid} (${processName(pid)})` : 'none'}; pid file ${filePid ?? 'none'}; /health=${await healthStatus()}`);
  } else if (action === 'logs') {
    log(`${LOG_FILE}\n${tail(Number(flags.n) || 40)}`);
  } else if (action === 'autostart') {
    autostart(sub);
  } else {
    die('usage: serve <start|stop|restart|status|logs [-n 40]|autostart <on|off|status>> [--no-build]', 2);
  }
}
