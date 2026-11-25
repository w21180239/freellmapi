---
name: freellmapi-ops
description: Use when maintaining the personal FreeLLMAPI fork (syncing upstream into local/customizations, merge conflicts, starting, stopping, rebuilding or autostarting the headless server) or operating it from the CLI through the local management API (provider keys, enabling or disabling models of any modality, usage and request log, settings, catalog sync, inventory, missing models, models add, test sample, 429 or "No enabled API key" errors, allowlist/blocklist).
---

# FreeLLMAPI ops

Rare tasks, so run the script and read its output. One entry for everything, from the repo root (`D:\VVPlayground\freellmapi`, branch `local/customizations`):

```
node skills/freellmapi-ops/scripts/ops.mjs <subcommand> [options]
```

Management commands (keys, models, usage, catalog, ...) run through the npm CLI in `cli/`: `node skills/freellmapi-ops/scripts/ops.mjs cli <command>` (see "CLI commands"). Fork model and routine: `AGENTS.md`. The router runs headless from this checkout: plain `node server/dist/index.js` on 127.0.0.1:31415, data in `%APPDATA%\FreeLLMAPI`, dashboard at http://localhost:31415. The Electron app is not used.

## Subcommands

| Subcommand | Job | Done looks like |
|---|---|---|
| `serve start [--no-build]` | build server, client and cli if sources are newer, start the server detached and hidden, wait for health | `serve: /health=200 after Ns (pid P)` |
| `serve stop` | stop whatever holds port 31415 (headless node, dev Electron, installed `FreeLLMAPI.exe`) | `serve: stopped <exe> pid P` or `serve: nothing running` |
| `serve restart [--no-build]` / `serve status` / `serve logs [-n 40]` | restart; port listener, pid file, health; server log tail | `serve: port 31415 listener pid P (node.exe); pid file P; /health=200` |
| `serve autostart on\|off\|status` | Startup-folder `freellmapi-serve.vbs` runs `serve start --no-build` hidden at logon; `on` also removes other FreeLLMAPI/Electron autostart entries | `autostart: on (<path>)` |
| `dev-restart` | force-build server, client and cli, restart the server | `serve: /health=200 after Ns (pid P)` |
| `sync-upstream [--full] [--skip-tests] [--no-restart] [--no-push]` | fetch, merge `upstream/main`, install (only when a manifest or lockfile moved), build, parallel server + client tests, restart the headless server, list providers still needing a key, push `origin/local/customizations` (skipped with `--skip-tests`) | `providers: N without a key (M new upstream)`, `push: origin/local/customizations at <sha>`, last line `sync-upstream: done (N incoming)` |
| `self-close [--automation <id>] [--max-wait 3600]` | scheduled run only: detached watcher closes this Orca terminal tab after the automation run is recorded (default automation `freellmapi daily sync`) | `self-close: watcher pid P closes term_… once the run is recorded` |
| `providers` | providers without a key; `NEW` marks those added upstream in the last `sync-upstream` (state: `%APPDATA%\FreeLLMAPI\providers-seen.json`) | `providers: N without a key (M new upstream)` |
| `cli <args...>` | run `node cli/dist/index.js <args...>` against the local server; the session token goes to the child's env only, the exit code passes through; `cli --help` lists commands | the command's own output |

## CLI commands

Everything below is `ops.mjs cli <command>`; `<command> --help` prints the options. Stdin and env pass through, so a secret never lands in argv.

| Command | Job | Done looks like |
|---|---|---|
| `status [--json]` | reachability, version, keys per platform, enabled models per kind | `Status   ok` |
| `inventory [--platform a,b] [--list-models] [--json]` | fork: keys (unhealthy, undecryptable, cooldowns) and chat models (enabled, user, enabled without a usable key) per platform | one row per platform |
| `keys list\|add\|remove\|test\|enable\|disable <platform> [--id N]` | provider keys; `add` reads the secret from `FREELLMAPI_PROVIDER_KEY`, piped stdin or a hidden prompt, then checks it | `Saved <platform> key N` and a `healthy` line |
| `models list\|enable\|disable [--kind chat\|media\|embedding\|search\|decision] [--platform a,b] [ids...] [--enabled\|--disabled]` | ids from `models list`; `media` covers image, audio, video and transcription rows | `Enabled <kind> model N` |
| `enable-models --platform a,b [--apply]` | fork: re-enable disabled chat models (dry run by default) | `Re-enabled N chat model(s).` |
| `models add <file.json> [--dry-run]` | batch add with read-back; a file naming any non-chat `modality` goes through the fork path (below) | `N added, M already present, 0 failed.` |
| `usage [--range 24h\|7d\|30d\|all] [--top 15]` / `requests [--range 24h] [--status error] [--limit 20]` | totals plus per-provider split; recent request log | tables |
| `settings get [name]` / `settings set <name> '<json>'` | non-secret settings (`unify`, `fusion`, `guardrails`, `output-limit`, ...); set takes the body shape `get` prints | the new value |
| `test-sample --platform a,b\|--all [-n 2] [--pace 120] [--seed N]` | live-test random enabled models, one queue per upstream account | summary table |
| `premium status\|sync` | fork: license and signed-catalog state; `sync` triggers a catalog sync now | `Catalog  version V, tier T, last sync <ISO>` |
| `catalog list\|add\|block\|unblock\|claim\|release\|overlap ...` | fork: local overlay on the signed catalog for every modality (`/api/catalog/*` plus the per-kind routes) | `<verb> <kind> <platform>/<modelId>: ok` |

`models add` input: JSON array of `{platform, modelId, ...}`; no `modality` = chat (`contextWindow?, supportsTools?, supportsVision?, ...`), `image|audio|video|transcription|search|decision` = `/api/media` (`priority?, quotaLabel?, meta?`), `embedding` = `/api/embeddings` (`dimensions`, `family?`). The fork path paces 120 ms and stops at the first 429 (rerun; present rows are skipped). `catalog` kinds are `chat`, `media`, `embedding`. Rows with `source=user` are the owner's and no catalog sync updates or prunes them; `add` creates one, `claim` takes a catalog row over, `release` hands it back (refused unless the applied catalog lists it), `block` deletes for good with a user tombstone, `overlap` shows user rows the catalog also lists. Fork commands live in `cli/src/fork-*.ts` and parse their own flags; the command comes first (`catalog --url U list` is rejected).

## Sync upstream

1. Run `sync-upstream`. It refuses off `local/customizations`.
2. Exit at a conflict list: resolve per [references/conflicts.md](references/conflicts.md), `git add -A`, `git commit --no-edit`, rerun `sync-upstream`. A rerun after a conflict commit builds, tests and restarts (HEAD differs from the last verified one); with nothing new since the last green run it skips straight to push in ~3 s, `--full` forces the whole pipeline.
3. Test failures: server tests run in parallel (~35 s); each failing file gets one serial rerun and a pass there is listed as `non-blocking`, as is `proxy.test.ts > sends a *.localhost subdomain direct` (Windows DNS). A failure that survives the rerun stops the sync; fix it or ask the owner.
4. A green run pushes `origin/local/customizations` itself (owner standing order); `--no-push` holds it.
5. New providers: the `providers` block at the end of the run lists every provider without a key (`NEW` = added upstream). Configure each one: sign up in the Orca browser with "Continue with Google" on the owner's personal Gmail (`lw21180239@gmail.com`), create the key, add it through stdin (`cli keys add <platform>`), register its models when the catalog has none (`cli models add`, ids from the adapter or its public `/v1/models`), then `freellm ask --model <platform>:<id>` until it answers. Flow details and known gates: [references/catalog.md](references/catalog.md) "Provider notes". Stop on a step only the owner can do (phone or SMS verification, payment card, captcha) and list it in the report.

## Scheduled run

Orca automation `freellmapi daily sync` runs daily in the main checkout. Its precheck is `ops.mjs upstream-pending` (exit 0 = new upstream commits or an unverified HEAD), so a quiet day starts no agent. The run follows "Sync upstream" steps 1-5 end to end without asking, then ends with a Chinese report: incoming commits, conflicts and how each was resolved, test summary line, push hash, each new provider's status (configured and tested, or the owner step it waits on).

Last tool call, right before that report: `ops.mjs self-close` (prints `self-close: watcher pid P closes term_… once the run is recorded`). Its detached watcher waits until Orca has captured the run's output snapshot (when the turn ends), then closes the session's terminal tab, so a finished run holds no resources. Owner-only steps go in the report; the session does not stay open waiting for them. Watcher log: `%APPDATA%\FreeLLMAPI\logs\self-close.log`.

## Catalog work

- Auth, endpoints, error classes, provider quirks and the research procedure: [references/catalog.md](references/catalog.md).
- Missing-model loop: `cli inventory`, research official ids, `cli models add <file> --dry-run`, `cli models add <file>`, `cli test-sample -n 2`.
- Triage a `test-sample` class by the table in catalog.md. `no-key` on an enabled model with a healthy key: check `enabled` (`cli inventory --platform p --list-models`), then cooldowns (`cli inventory` column).
- Decision rules:
  - Add a model only when an official source shows the exact id and free eligibility; otherwise list it as unresolved.
  - Before a sweep over more than 100 models, set `--pace` to at least 120 (management API limit: 600/min).
  - A `banned` line means one account is gone: stop probing that provider and tell the owner; leave other queues running.
  - Two `rate-limit` results in a row stop that queue; retest after the cooldown.
- Tokens, keys and whole key objects stay out of output and files; `ops.mjs` keeps the session token in memory (the `cli` child gets it in its env) and logs out on exit.

## Headless server

1. First setup on a machine: `serve stop` (ends a running Electron app), `serve start`, `serve autostart on`. Done: `autostart: on (...)` and `serve status` showing `node.exe` with `/health=200`.
2. After source edits: `dev-restart`. Client edits show on browser reload.
3. Auth: `serve` starts the server with `FREEAPI_DESKTOP=1` and `HOST=127.0.0.1`, so `ops.mjs` (including `ops.mjs cli`) and `freellm` mint a loopback desktop session (`POST /api/auth/desktop-session`) in memory and log out on exit. The server refuses that session for a non-localhost `Host`, a cross-site `Origin`/`Sec-Fetch-Site`, or a forwarded hop (403). Nothing is written to disk.
4. Windows installer, only when asked for one: `npm run desktop:dist:win` (output `desktop/dist-electron/`).

## macOS

- Data dir `~/Library/Application Support/FreeLLMAPI` (same files as `%APPDATA%\FreeLLMAPI`); port lookup via `lsof`, stop via a process-group SIGTERM.
- Run `ops.mjs` with a Node inside `.nvmrc`'s range (Homebrew `node` may be newer than `engines` allows); `serve autostart on` pins that Node's absolute path.
- `serve autostart on` writes and bootstraps `~/Library/LaunchAgents/com.freellmapi.serve.plist` (RunAtLoad, AbandonProcessGroup, carries `NODE_EXTRA_CA_CERTS` from the calling shell for a corporate TLS proxy). Launchd output: `<data dir>/logs/launchd.log`.

## Gotchas

- `serve` runs node with `NODE_ENV` unset and `ENCRYPTION_KEY` removed, so provider keys decrypt with `%APPDATA%\FreeLLMAPI\.encryption-key`, the same key file the Electron app used. `production` would demand a 64-char `ENCRYPTION_KEY`; `development` skips migrations.
- A failing server build (`build: server failed`) keeps the last good `server/dist` (`tsc --noEmitOnError`); `serve start` then stops. Fix the build, or run the last good dist with `serve start --no-build`.
- Electron, the installed app and `serve` share `%APPDATA%\FreeLLMAPI` and port 31415; `serve stop` ends any of them.
- Logs: `%APPDATA%\FreeLLMAPI\logs\freeapi.log` (stdout and stderr, rotated to `.1` past 20 MB at start). Pid file: `%APPDATA%\FreeLLMAPI\serve.pid`.
- Chat calls through the gateway, search, image, audio: use the `freellm` skill.
