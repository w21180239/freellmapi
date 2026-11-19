# FreeLLMAPI personal fork

This checkout is the owner's personal fork of https://github.com/tashfeenahmed/freellmapi, run locally as the desktop app.

## Fork model

- Goal: every upstream feature, always, plus the owner's own local features on top. Divergence from upstream is intended; the fork exists because upstream does not ship some providers and model lists the owner needs.
- `local/customizations` is the working branch: `upstream/main` merged in, local commits on top. The desktop app is built from it.
- `main` tracks `upstream/main`. Fork `origin/main` is unused; its divergence is fine, do not force-reset it.
- Local commits are kept on purpose. When an upstream change overlaps a local one, keep both behaviours; do not drop the local one to match upstream unless the owner says so. When upstream ships an equivalent, the local copy can stay if it merges cleanly.
- Upstream PRs go from a feature branch cut from `upstream/main`, never from `local/customizations`.

## Running it day to day

Dev mode is the default way to run this fork — no repackaging, no reinstall:

```powershell
powershell -NoProfile -File scripts\dev-desktop.ps1 -Watch
```

- Electron loads this checkout (`client/dist` + `desktop/build/server.mjs`), so source edits show up without building an installer.
- `-Watch` rebuilds `client/dist` on save; press Ctrl+R in the window to pick it up. Server edits need a restart of the script (~15 s) because the server is bundled into the Electron process.
- The script drops an inherited `NODE_ENV=production` (which would demand a 64-char `ENCRYPTION_KEY` and refuse to boot) and stops the packaged app, because both use `%APPDATA%\FreeLLMAPI` and port 31415.
- Logs: `.scratch\dev-desktop.log` (launcher/stdout) and `%APPDATA%\FreeLLMAPI\logs\freeapi.log` (server).

The installed build (`FreeLLMAPI-Setup-<version>.exe`) is only for handing the app to another machine or for keeping it out of a dev checkout; it is not the daily driver.

## Routine

Operator skill: `skills/freellmapi-ops/SKILL.md` (conflict table in its `references/conflicts.md`). Everything runs through `node skills/freellmapi-ops/scripts/ops.mjs <subcommand>`:

1. `sync-upstream`: fetch, merge `upstream/main` into `local/customizations`, install, build, server and client tests, restart the dev app. A conflict stops it; resolve per the table, commit, rerun.
2. `dev-restart [--watch]`: restart the dev app and wait for 127.0.0.1:31415/health = 200.
3. `dist-win`: build the installer, only when asked for one.
4. Catalog: `health`, `inventory`, `add-models`, `test-sample`, `lists`.
5. Push `local/customizations` to `origin`: `git push origin local/customizations`.
