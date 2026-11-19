# FreeLLMAPI personal fork

This checkout is the owner's personal fork of https://github.com/tashfeenahmed/freellmapi, run locally as the desktop app.

## Fork model

- Goal: every upstream feature, always, plus the owner's own local features on top. Divergence from upstream is intended; the fork exists because upstream does not ship some providers and model lists the owner needs.
- `local/customizations` is the working branch: `upstream/main` merged in, local commits on top. The desktop app is built from it.
- `main` tracks `upstream/main`. Fork `origin/main` is unused; its divergence is fine, do not force-reset it.
- Local commits are kept on purpose. When an upstream change overlaps a local one, keep both behaviours; do not drop the local one to match upstream unless the owner says so. When upstream ships an equivalent, the local copy can stay if it merges cleanly.
- Upstream PRs go from a feature branch cut from `upstream/main`, never from `local/customizations`.

## Running it day to day

The fork runs headless: plain node on `server/dist`, bound to 127.0.0.1:31415, data in `%APPDATA%\FreeLLMAPI`, started at logon by a Startup-folder `.vbs`. The web UI stays at http://127.0.0.1:31415 for occasional use; everything routine goes through the CLI.

- `node skills/freellmapi-ops/scripts/ops.mjs serve start|stop|status|logs`; `serve autostart on|off|status`.
- Source edits: `dev-restart` rebuilds server and client (`tsc --noEmitOnError`, so a broken tree keeps the last good dist) and restarts.
- Logs: `%APPDATA%\FreeLLMAPI\logs\freeapi.log`.

The Electron installer (`npm run desktop:dist:win`) is only for handing the app to another machine; it shares `%APPDATA%\FreeLLMAPI` and port 31415, so stop the headless server before running it.

## Routine

Operator skill: `skills/freellmapi-ops/SKILL.md` (conflict table in its `references/conflicts.md`). Everything runs through `node skills/freellmapi-ops/scripts/ops.mjs <subcommand>`:

1. `sync-upstream`: fetch, merge `upstream/main` into `local/customizations`, install, build, server and client tests, restart the headless server. A conflict stops it; resolve per the table, commit, rerun.
2. `dev-restart`: rebuild and restart, wait for 127.0.0.1:31415/health = 200.
3. Catalog: the signed catalog is a baseline; `lists` adds, blocks, claims and releases rows of any modality on top of it. Also `health`, `inventory`, `add-models`, `test-sample`.
4. `sync-upstream` pushes `local/customizations` to `origin` after a green run; push other local commits with `git push origin local/customizations`.
