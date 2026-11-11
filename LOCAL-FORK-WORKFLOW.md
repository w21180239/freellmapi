# Local Fork Workflow — upstream + local customizations

This repo is a fork of https://github.com/tashfeenahmed/freellmapi with a `local/customizations` branch that merges upstream and keeps local patches.

## Remotes

- `origin` → your fork
- `upstream` → https://github.com/tashfeenahmed/freellmapi.git

## Pull upstream updates + merge

```powershell
git fetch upstream
git merge upstream/main
```

If it merges cleanly, skip to "Build & run". Otherwise resolve the four recurring conflicts (below), then:

```powershell
git add -A
git commit --no-edit
```

### Conflict resolution (recurring files)

| File | Keep both sides |
|------|-----------------|
| `client/src/components/keys/shared.tsx` | Take upstream's new providers / URL fixes, but drop `hidden: true` from aclide, speka, cerebras, clod, waterfall, mistral, ainative, and remove the jamai line (local un-hide). May auto-merge with a new upstream `hidden: true`: grep for it after every merge. |
| `client/src/components/keys/provider-visibility.test.tsx` | Keep the local version (asserts aclide and waterfall stay pickable). |
| `server/src/routes/keys.ts` | Keep the local `UNLISTED_PLATFORMS` set (superset of upstream's aclide and waterfall). |
| `server/src/routes/models.ts` | Keep `isSearchPlatform` import **and** upstream's imports. The local `/:id/test` redirect message must keep the phrase "does not support chat" (upstream test asserts it). |
| `server/src/routes/search.ts` | Keep local `POST /engines` handler **and** upstream's `POST /engines/:id/test` handler; merge imports (`SEARCH_ENGINE_PLATFORMS`, `runSearch`, `searchStatus`, `SearchError`, `registerLocalCapability`, `getSyncState`). |

After resolving, run `npx vitest run` in both `server/` and `client/`. `fallback-loop-hedge.test.ts` is timing-sensitive: rerun it alone before treating a failure as real.

## Build & run the fused version (local)

Dev mode (fast, hot-reload):
```powershell
npm run desktop:dev
```
Runs on http://127.0.0.1:31415. Stop with Ctrl+C or kill the electron process.

Packaged installer (for persistence / distribution):
```powershell
npm run desktop:dist:win
```
Output: `desktop/dist-electron/FreeLLMAPI-Setup-<version>.exe`. Note: stop the running dev app first, otherwise the locked exe breaks the build.

## One-shot helper

```powershell
powershell -NoProfile -File scripts\sync-upstream.ps1
```

Fetches upstream, merges, and (on success) runs `npm run desktop:dev`. On conflict it stops and prints the resolution hints above.
