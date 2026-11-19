// Fork-maintenance subcommands: sync-upstream, dev-restart.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APPDATA_DIR, REPO, die, git, log, parseArgs, run, withSession } from './lib.mjs';
import { providerReport } from './gui-cmds.mjs';
import { build, restartServer } from './serve.mjs';

const BRANCH = 'local/customizations';
const CONFLICTS_DOC = 'skills/freellmapi-ops/references/conflicts.md';

// Failures that do not block a sync. Anything else stops it.
const NON_BLOCKING = [
  { file: /proxy\.test\.ts$/, name: /sends a \*\.localhost subdomain direct/, why: 'Windows DNS cannot resolve *.localhost' },
];
// Last fully verified HEAD; a sync with nothing new since then skips straight to push.
const VERIFIED_FILE = path.join(APPDATA_DIR, 'sync-verified.json');
const readVerified = () => { try { return JSON.parse(fs.readFileSync(VERIFIED_FILE, 'utf8')).head ?? null; } catch { return null; } };

// Providers un-hidden locally; a new upstream `hidden: true` on them must be removed.
const UNHIDDEN = ['aclide', 'speka', 'cerebras', 'clod', 'waterfall', 'mistral', 'ainative', 'jamai'];

export async function devRestartCmd() {
  build({ force: true });
  await restartServer();
}

function checkUnhidden() {
  const file = path.join(REPO, 'client/src/components/keys/shared.tsx');
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const hits = [];
  for (const [i, l] of lines.entries()) {
    const m = l.match(/value: '([a-z0-9-]+)'/);
    if (m && UNHIDDEN.includes(m[1]) && (m[1] === 'jamai' || /hidden: true/.test(l))) hits.push(`${file}:${i + 1} ${m[1]}`);
  }
  return hits;
}

function vitestFailures(cwd, args, label) {
  const out = path.join(os.tmpdir(), `freellmapi-ops-${label}-${process.pid}.json`);
  const r = run('npx', ['vitest', 'run', ...args, '--reporter=json', `--outputFile=${out}`], { cwd });
  if (!fs.existsSync(out)) return { crashed: true, tail: r.out.split(/\r?\n/).slice(-15).join('\n'), failed: [], total: 0 };
  const j = JSON.parse(fs.readFileSync(out, 'utf8')); fs.rmSync(out, { force: true });
  const failed = [];
  for (const f of j.testResults) {
    for (const t of f.assertionResults) if (t.status === 'failed') failed.push({ file: f.name.replace(/\\/g, '/'), name: t.fullName });
    if (f.status === 'failed' && f.assertionResults.every((t) => t.status !== 'failed')) failed.push({ file: f.name.replace(/\\/g, '/'), name: '(suite failed to run)' });
  }
  return { crashed: false, failed, total: j.numTotalTests };
}

// Server tests run in parallel; files that fail there get one serial rerun, and a pass
// there clears them (timing and shared-state flakes under load).
function classifyFailures(res, cwd) {
  const blocking = []; const waived = [];
  const rest = [];
  for (const f of res.failed) {
    const known = NON_BLOCKING.find((k) => k.file.test(f.file) && k.name.test(f.name));
    if (known) waived.push(`${f.name} (${known.why})`); else rest.push(f);
  }
  for (const file of [...new Set(rest.map((f) => f.file))]) {
    const again = vitestFailures(cwd, ['--pool=forks', '--fileParallelism=false', file], 'rerun');
    const names = rest.filter((f) => f.file === file).map((f) => f.name);
    if (!again.crashed && again.failed.length === 0) names.forEach((n) => waived.push(`${n} (passed on serial rerun)`));
    else names.forEach((n) => blocking.push(`${file}: ${n}`));
  }
  return { blocking, waived };
}

export async function syncUpstream(argv) {
  const { flags } = parseArgs(argv);
  const steps = [];
  const step = (name, detail = '') => { steps.push(`${name}${detail ? `: ${detail}` : ''}`); log(`== ${name}${detail ? `: ${detail}` : ''}`); };

  const branch = git('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim();
  if (branch !== BRANCH) die(`sync-upstream: on "${branch}", expected ${BRANCH}; run: git switch ${BRANCH}`);
  if (fs.existsSync(path.join(REPO, '.git', 'MERGE_HEAD'))) {
    die(`sync-upstream: a merge is already in progress. Resolve per ${CONFLICTS_DOC}, then: git add -A; git commit --no-edit; rerun sync-upstream.`);
  }

  const dirty = git('status', '--porcelain', '--untracked-files=no').stdout.trim().split('\n').filter(Boolean);
  if (dirty.length) log(`note: ${dirty.length} tracked file(s) have uncommitted changes (git refuses the merge if upstream touches them)`);

  const f = git('fetch', 'upstream');
  if (f.code !== 0) die(`sync-upstream: git fetch upstream failed\n${f.out}`);
  const incoming = Number(git('rev-list', '--count', 'HEAD..upstream/main').stdout.trim());
  step('fetch', `${incoming} incoming commit(s)`);
  if (incoming > 0) {
    const l = git('log', '--oneline', '--no-decorate', '-n', '50', 'HEAD..upstream/main').stdout.trim();
    log(l); if (incoming > 50) log(`... ${incoming - 50} more`);
    const m = git('merge', 'upstream/main', '--no-edit');
    log(m.out.trim().split('\n').slice(-6).join('\n'));
    const conflicts = git('diff', '--name-only', '--diff-filter=U').stdout.trim();
    if (conflicts) {
      log('\nCONFLICTS in:'); conflicts.split('\n').forEach((c) => log(`  ${c}`));
      die(`\nsync-upstream: stopped. Resolve per ${CONFLICTS_DOC}, then: git add -A; git commit --no-edit; rerun sync-upstream (0 incoming continues with build and tests).`);
    }
    if (m.code !== 0) die(`sync-upstream: git merge failed without conflicts (see output above)`);
    step('merge', `upstream/main merged, HEAD ${git('rev-parse', '--short', 'HEAD').stdout.trim()}`);
  }

  const head = git('rev-parse', 'HEAD').stdout.trim();
  const verified = readVerified();
  if (incoming === 0 && verified === head && !flags.full) {
    step('verify', `HEAD ${head.slice(0, 8)} already built, tested and running; skipped (--full forces)`);
    return finish(flags, steps, []);
  }

  const hidden = checkUnhidden();
  if (hidden.length) { hidden.forEach((h) => log(`  ${h}`)); die(`sync-upstream: shared.tsx re-hides a locally un-hidden provider or re-adds jamai; fix per ${CONFLICTS_DOC} (row shared.tsx), then rerun.`); }
  step('unhidden-check', 'ok');

  // npm install only when a manifest or lockfile moved since the last verified HEAD.
  const depsDiff = verified ? git('diff', '--name-only', verified, head, '--', 'package.json', 'package-lock.json', '*/package.json') : null;
  const depsMoved = !depsDiff || depsDiff.code !== 0 || depsDiff.stdout.trim() !== ''
    || !fs.existsSync(path.join(REPO, 'node_modules')) || flags.full;
  if (!depsMoved) step('npm install', 'skipped (no package.json / lockfile change)');
  for (const [name, cmd, args] of [...(depsMoved ? [['npm install', 'npm', ['install']]] : []), ['build', 'npm', ['run', 'build']]]) {
    const r = run(cmd, args);
    if (r.code !== 0) { log(r.out.split(/\r?\n/).slice(-25).join('\n')); die(`sync-upstream: ${name} failed (output tail above)`); }
    step(name, 'ok');
  }

  const waived = [];
  if (flags['skip-tests']) step('tests', 'SKIPPED (--skip-tests)');
  else {
    for (const [label, cwd, args] of [['server', path.join(REPO, 'server'), []], ['client', path.join(REPO, 'client'), []]]) {
      const res = vitestFailures(cwd, args, label);
      if (res.crashed) { log(res.tail); die(`sync-upstream: ${label} tests produced no result (output tail above)`); }
      const { blocking, waived: w } = classifyFailures(res, cwd);
      waived.push(...w);
      if (blocking.length) { blocking.forEach((b) => log(`  FAIL ${b}`)); die(`sync-upstream: ${label} tests failed (${blocking.length} blocking); stopped`); }
      step(`${label} tests`, `${res.total - res.failed.length}/${res.total} passed${res.failed.length ? `, ${res.failed.length} waived` : ''}`);
    }
    const i18n = run('npm', ['run', 'check:i18n', '-w', 'client']);
    if (i18n.code !== 0) { log(i18n.out.split(/\r?\n/).slice(-15).join('\n')); die('sync-upstream: client check:i18n failed'); }
    step('client check:i18n', 'ok');
  }

  if (flags['no-restart']) step('restart', 'SKIPPED (--no-restart)');
  else {
    const r = await restartServer(); // exits with the log tail if the server does not come back
    step('restart', `/health=200 after ${r.secs}s`);
  }

  if (!flags['skip-tests'] && !flags['no-restart']) fs.writeFileSync(VERIFIED_FILE, JSON.stringify({ head, at: new Date().toISOString() }));
  return finish(flags, steps, waived, incoming);
}

async function finish(flags, steps, waived, incoming = 0) {
  if (!flags['no-restart']) {
    log('\n== providers still needing a key');
    await withSession(({ call }) => providerReport(call, { record: true }));
  }

  // Push only a fully verified run; a skipped test pass leaves it to the owner.
  if (flags['no-push'] || flags['skip-tests']) steps.push(`push: SKIPPED (${flags['no-push'] ? '--no-push' : '--skip-tests'}); run: git push origin ${BRANCH}`);
  else {
    const p = git('push', 'origin', BRANCH);
    if (p.code !== 0) { log(p.out); die(`sync-upstream: git push origin ${BRANCH} failed (output above); merge, build and restart are done`); }
    steps.push(`push: origin/${BRANCH} at ${git('rev-parse', '--short', 'HEAD').stdout.trim()}`);
  }

  log('\n== summary');
  steps.forEach((s) => log(`  ${s}`));
  waived.forEach((w) => log(`  non-blocking: ${w}`));
  log(`sync-upstream: done (${incoming} incoming)`);
}
