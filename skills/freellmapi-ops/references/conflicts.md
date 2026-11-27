# Upstream merge conflicts (recurring files)

The fork keeps every upstream feature plus local patches. On a conflict, keep both sides as below.
After resolving: `git add -A`, `git commit --no-edit`, rerun `node skills/freellmapi-ops/scripts/ops.mjs sync-upstream` (0 incoming continues with build and tests).

| File | Resolution |
|------|-----------|
| `client/src/components/keys/shared.tsx` | Take upstream's new providers and URL fixes. Remove `hidden: true` from aclide, speka, cerebras, clod, waterfall, mistral, ainative, and remove the jamai line (local un-hide). A new upstream `hidden: true` can merge silently; `sync-upstream` greps for it after every merge and stops. |
| `client/src/components/keys/provider-visibility.test.tsx` | Keep the local version (asserts aclide and waterfall stay pickable). |
| `server/src/routes/keys.ts` | Keep the local `UNLISTED_PLATFORMS` set (superset of upstream's aclide and waterfall). |
| `server/src/routes/models.ts` | Keep the `isSearchPlatform` import and upstream's imports. The local `/:id/test` redirect message keeps the phrase "does not support chat" (an upstream test asserts it). |
| `server/src/routes/search.ts` | Keep upstream's `POST /engines/:id/test` handler; local search engines are added through `POST /api/media` (`routes/media.ts`), so search.ts has no local `POST /engines`. |
| `server/src/services/catalog-sync.ts` | Keep the local ownership rule: `applyMedia`/`pruneMedia` skip `source = 'user'` rows in every media snapshot and embeddings, and the apply writes `catalog_overlap`. Port upstream changes to individual snapshot blocks into the shared helpers. Upstream's per-block `source === 'user'` skips (#2099) are already covered by the helpers: keep the local side of those hunks. |
| `cli/src/index.ts` | Keep upstream; re-add the three fork seams: the `fork-commands.js` import, the `...FORK_HELP_LINES` help entry and the `isForkCommand` dispatch at the top of `main` (all marked `Fork-only commands`). Take upstream's `readStdin`/`promptForKey` (upstream ships the `FREELLMAPI_PROVIDER_KEY`/stdin read since #2100). Local fields in `CliOptions` and the flag checks in `main` stay next to upstream's (e.g. `--context-window`). |
| `cli/src/keys.test.ts` | Take upstream (`git checkout --theirs`); the stdin tests are upstream's now. |
| `server/src/lib/proxy.ts` | Keep the local `getLocalhostFetch` (npm undici fetch when Node's bundled undici is 8+, i.e. Node 26) alongside upstream changes. |
| `cli/src/dashboard-models.ts` | Keep upstream; re-add the `forkAddHelp` import and spread in `modelsHelp` and the `forkAddModels(...) ?? addModels(...)` call in `runModels`. |

Other conflicts: keep both behaviours. Drop a local change only when the owner says so.

## Test failures during sync

- `proxy.test.ts > sends a *.localhost subdomain direct`: Windows DNS cannot resolve `*.localhost`. `sync-upstream` waives it automatically.
- `fallback-loop-hedge.test.ts`: timing-sensitive. `sync-upstream` reruns the file alone and waives it when the rerun passes.
- Any other failure stops the sync.
