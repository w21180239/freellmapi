#!/usr/bin/env node
// FreeLLMAPI fork operator entry. Run from anywhere: node skills/freellmapi-ops/scripts/ops.mjs <subcommand> [options]
import { addModels, enableModels, health, inventory, lists, testSample } from './api-cmds.mjs';
import { devRestartCmd, distWin, syncUpstream } from './fork-cmds.mjs';

const USAGE = `subcommands:
  health                                   app status, key/model counts (read-only)
  inventory [--platform a,b] [--list-models] [--json]   keys and models per platform, non-secret fields
  add-models <file.json> [--dry-run] [--skip <regex>]   batch POST /api/models, then read back
  enable-models --platform a,b [--apply]   re-enable disabled chat models (dry-run by default)
  test-sample --platform a,b|--all [-n 2] [--pace 120] [--seed N]   live-test random models, one queue per account
  lists <list|pin|unpin|block|unblock> ...  allow/blocklist on top of the signed catalog (scripts/catalog-lists.mjs)
  sync-upstream [--skip-tests] [--no-restart]   merge upstream/main, build, test, restart
  dev-restart [--watch]                    restart the dev app, wait for /health 200
  dist-win                                 stop the app and build the Windows installer`;

const [cmd, ...rest] = process.argv.slice(2);
const table = {
  health, inventory, 'add-models': addModels, 'enable-models': enableModels, 'test-sample': testSample,
  lists, 'sync-upstream': syncUpstream, 'dev-restart': devRestartCmd, 'dist-win': distWin,
};
if (!table[cmd]) { console.error(USAGE); process.exit(cmd ? 2 : 0); }
await table[cmd](rest);
