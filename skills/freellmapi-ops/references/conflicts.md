# Upstream merge conflicts (recurring files)

The fork keeps every upstream feature plus local patches. On a conflict, keep both sides as below.
After resolving: `git add -A`, `git commit --no-edit`, rerun `node skills/freellmapi-ops/scripts/ops.mjs sync-upstream` (0 incoming continues with build and tests).

| File | Resolution |
|------|-----------|
| `client/src/components/keys/shared.tsx` | Take upstream's new providers and URL fixes. Remove `hidden: true` from aclide, speka, cerebras, clod, waterfall, mistral, ainative, and remove the jamai line (local un-hide). A new upstream `hidden: true` can merge silently; `sync-upstream` greps for it after every merge and stops. |
| `client/src/components/keys/provider-visibility.test.tsx` | Keep the local version (asserts aclide and waterfall stay pickable). |
| `server/src/routes/keys.ts` | Keep the local `UNLISTED_PLATFORMS` set (superset of upstream's aclide and waterfall). |
| `server/src/routes/models.ts` | Keep the `isSearchPlatform` import and upstream's imports. The local `/:id/test` redirect message keeps the phrase "does not support chat" (an upstream test asserts it). |
| `server/src/routes/search.ts` | Keep the local `POST /engines` handler and upstream's `POST /engines/:id/test` handler; merge imports (`SEARCH_ENGINE_PLATFORMS`, `runSearch`, `searchStatus`, `SearchError`, `registerLocalCapability`, `getSyncState`). |

Other conflicts: keep both behaviours. Drop a local change only when the owner says so.

## Test failures during sync

- `proxy.test.ts > sends a *.localhost subdomain direct`: Windows DNS cannot resolve `*.localhost`. `sync-upstream` waives it automatically.
- `fallback-loop-hedge.test.ts`: timing-sensitive. `sync-upstream` reruns the file alone and waives it when the rerun passes.
- Any other failure stops the sync.
