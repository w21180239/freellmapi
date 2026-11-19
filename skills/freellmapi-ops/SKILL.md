---
name: freellmapi-ops
description: Use when maintaining the personal FreeLLMAPI fork (syncing upstream into local/customizations, merge conflicts, restarting or rebuilding the desktop app from source, building the Windows installer) or managing its provider and model catalog through the local management API (inventory, missing models, add-models, test sample, 429 or "No enabled API key" errors, allowlist/blocklist).
---

# FreeLLMAPI ops

Rare tasks, so run the script and read its output. One entry for everything, from the repo root (`D:\VVPlayground\freellmapi`, branch `local/customizations`):

```
node skills/freellmapi-ops/scripts/ops.mjs <subcommand> [options]
```

Fork model, routine and daily-run notes: `AGENTS.md`. The app runs from this checkout in dev mode; the installer is only for handing the app to another machine.

## Subcommands

| Subcommand | Job | Done looks like |
|---|---|---|
| `sync-upstream [--skip-tests] [--no-restart]` | fetch, merge `upstream/main`, install, build, server + client tests, restart | last line `sync-upstream: done (N incoming)` plus the push command |
| `dev-restart [--watch]` | stop the app on the port, start `scripts/dev-desktop.ps1` detached, wait for health | `dev-restart: /health=200 after Ns` |
| `dist-win` | stop the app, `npm run desktop:dist:win` | path of `FreeLLMAPI-Setup-<version>.exe` |
| `health` | status, key and model counts | `health=ok` |
| `inventory [--platform a,b] [--list-models] [--json]` | keys and models per platform, non-secret fields | `inventory: P platforms, K keys, M models` |
| `add-models <file.json> [--dry-run] [--skip <regex>]` | batch `POST /api/models`, then read back | `read-back present N/N` |
| `enable-models --platform a,b [--apply]` | re-enable disabled chat models (dry-run by default) | `re-enabled N/N` |
| `test-sample --platform a,b\|--all [-n 2] [--pace 120] [--seed N]` | live-test random enabled models, one queue per upstream account | `test-sample: Q queues; ok=.. rate-limit=..` |
| `lists list\|pin\|unpin\|block\|unblock ...` | allow/blocklist on top of the signed catalog (`scripts/catalog-lists.mjs`) | `<cmd> <kind> <platform>: N changed` |

`add-models` input: JSON array of `{platform, modelId, displayName?, contextWindow?, supportsTools?, supportsVision?}`. `lists` kinds and arguments: `node scripts/catalog-lists.mjs` header. `pin` keeps media/embedding rows across catalog prunes; `block` tombstones and deletes a row so no catalog sync re-adds it; chat rows added by hand (`source=user`) already win over the catalog.

## Sync upstream

1. Run `sync-upstream`. It refuses off `local/customizations`.
2. Exit at a conflict list: resolve per [references/conflicts.md](references/conflicts.md), `git add -A`, `git commit --no-edit`, rerun `sync-upstream`. A rerun with 0 incoming still builds, tests and restarts.
3. Test failures: `proxy.test.ts > sends a *.localhost subdomain direct` (Windows DNS) and a `fallback-loop-hedge.test.ts` failure that passes on rerun are waived by the script and listed as `non-blocking`. Any other failure stops the sync; fix it or ask the owner.
4. Push only on the owner's go: `git push origin local/customizations`.

## Catalog work

- Auth, endpoints, error classes, provider quirks and the research procedure: [references/catalog.md](references/catalog.md).
- Missing-model loop: `inventory`, research official ids, `add-models --dry-run`, `add-models`, `test-sample -n 2`.
- Triage a `test-sample` class by the table in catalog.md. `no-key` on an enabled model with a healthy key: check `enabled` (`inventory --list-models`), then cooldowns.
- Decision rules:
  - Add a model only when an official source shows the exact id and free eligibility; otherwise list it as unresolved.
  - Before a sweep over more than 100 models, set `--pace` to at least 120 (management API limit: 600/min).
  - A `banned` line means one account is gone: stop probing that provider and tell the owner; leave other queues running.
  - Two `rate-limit` results in a row stop that queue; retest after the cooldown.
- Tokens, keys and whole key objects stay out of output and files; `ops.mjs` keeps the session token in memory and logs out on exit.

## Installer

`dist-win` stops the app first (a running exe locks the build) and leaves it stopped; `dev-restart` resumes daily use. Output: `desktop/dist-electron/`.

## Gotchas

- Dev launches run with `NODE_ENV` unset (`dev-desktop.ps1` drops an inherited `production`, which demands a 64-char `ENCRYPTION_KEY`).
- Dev app and installed app share `%APPDATA%\FreeLLMAPI` and port 31415, so one runs at a time; `dev-restart` stops whichever holds the port.
- Logs: `.scratch/dev-desktop.log` (launcher) and `%APPDATA%\FreeLLMAPI\logs\freeapi.log` (server).
- Server edits need `dev-restart` (the server is bundled into the Electron process); client edits show after `dev-restart --watch` plus Ctrl+R in the window.
- Chat calls through the gateway, search, image, audio: use the `freellm` skill.
