#!/usr/bin/env node
// FreeLLMAPI fork operator entry. Run from anywhere: node skills/freellmapi-ops/scripts/ops.mjs <subcommand> [options]
import { addModels, enableModels, health, inventory, lists, testSample } from './api-cmds.mjs';
import { devRestartCmd, syncUpstream, upstreamPending } from './fork-cmds.mjs';
import { keys, models, premium, providers, requests, settings, usage } from './gui-cmds.mjs';
import { serve } from './serve.mjs';
import { selfClose } from './session-cmds.mjs';

const USAGE = `subcommands:
  serve <start|stop|restart|status|logs [-n 40]> [--no-build]   headless server on 127.0.0.1:31415
  serve autostart <on|off|status>          start the headless server at Windows logon
  dev-restart                              rebuild server + client, restart the headless server
  sync-upstream [--full] [--skip-tests] [--no-restart] [--no-push]   merge, build, test, restart, push (~90 s; ~3 s when nothing is new)
  upstream-pending                         scheduler precheck: exit 0 when sync-upstream has work, 1 when not
  self-close [--automation <id>] [--max-wait 3600]   scheduled run's last step: close this Orca terminal tab once the run is recorded
  health                                   app status, key/model counts (read-only)
  inventory [--platform a,b] [--list-models] [--json]   keys and models per platform, non-secret fields
  keys <list|add|enable|disable|delete> [--platform P] [--label L] [ids...]   secret for add: FREELLMAPI_NEW_KEY or stdin
  models <list|enable|disable> [--kind chat|image|video|audio|transcription|embedding|search|decision] [--platform a,b] [ids...]
  usage [--range 24h|7d|30d|all] [--top 15]   request totals and per-provider split
  requests [--range 24h] [--status success|error|canceled] [--limit 20]   recent request log
  settings <get [name]|set <name> <json>>  non-secret router settings
  premium <status|sync>                    license and signed-catalog sync state; sync triggers a catalog sync
  providers                                providers without a key; NEW = added upstream in the last sync-upstream
  add-models <file.json> [--dry-run] [--skip <regex>]   batch add (chat or any media/embedding modality), then read back
  enable-models --platform a,b [--apply]   re-enable disabled chat models (dry-run by default)
  test-sample --platform a,b|--all [-n 2] [--pace 120] [--seed N]   live-test random models, one queue per account
  lists <list|add|block|unblock|claim|release|overlap> ...   local overlay on the catalog baseline, any modality`;

const [cmd, ...rest] = process.argv.slice(2);
const table = {
  serve, 'dev-restart': devRestartCmd, 'sync-upstream': syncUpstream, 'upstream-pending': upstreamPending, 'self-close': selfClose,
  health, inventory, keys, models, providers, usage, requests, settings, premium,
  'add-models': addModels, 'enable-models': enableModels, 'test-sample': testSample, lists,
};
if (!table[cmd]) { console.error(USAGE); process.exit(cmd ? 2 : 0); }
await table[cmd](rest);
