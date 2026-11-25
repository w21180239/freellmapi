#!/usr/bin/env node
// FreeLLMAPI fork operator entry. Run from anywhere: node skills/freellmapi-ops/scripts/ops.mjs <subcommand> [options]
import { cli } from './cli-cmd.mjs';
import { devRestartCmd, syncUpstream, upstreamPending } from './fork-cmds.mjs';
import { providers } from './providers.mjs';
import { serve } from './serve.mjs';
import { selfClose } from './session-cmds.mjs';

const USAGE = `subcommands:
  serve <start|stop|restart|status|logs [-n 40]> [--no-build]   headless server on 127.0.0.1:31415
  serve autostart <on|off|status>          start the headless server at Windows logon
  dev-restart                              rebuild server, client and cli, restart the headless server
  sync-upstream [--full] [--skip-tests] [--no-restart] [--no-push]   merge, build, test, restart, push (~90 s; ~3 s when nothing is new)
  upstream-pending                         scheduler precheck: exit 0 when sync-upstream has work, 1 when not
  self-close [--automation <id>] [--max-wait 3600]   scheduled run's last step: close this Orca terminal tab once the run is recorded
  providers                                providers without a key; NEW = added upstream in the last sync-upstream
  cli <args...>                            run the freellmapi CLI against the local server (status, usage, keys, models, catalog, premium, ...; cli --help)`;

const [cmd, ...rest] = process.argv.slice(2);
const table = {
  serve, 'dev-restart': devRestartCmd, 'sync-upstream': syncUpstream, 'upstream-pending': upstreamPending, 'self-close': selfClose, providers, cli,
};
if (!table[cmd]) { console.error(USAGE); process.exit(cmd ? 2 : 0); }
await table[cmd](rest);
