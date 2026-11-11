# FreeLLMAPI personal fork

This checkout is the owner's personal fork of https://github.com/tashfeenahmed/freellmapi, run locally as the desktop app.

## Fork model

- Goal: every upstream feature, always, plus the owner's own local features on top. Divergence from upstream is intended; the fork exists because upstream does not ship some providers and model lists the owner needs.
- `local/customizations` is the working branch: `upstream/main` merged in, local commits on top. The desktop app is built from it.
- `main` tracks `upstream/main`. Fork `origin/main` is unused; its divergence is fine, do not force-reset it.
- Local commits are kept on purpose. When an upstream change overlaps a local one, keep both behaviours; do not drop the local one to match upstream unless the owner says so. When upstream ships an equivalent, the local copy can stay if it merges cleanly.
- Upstream PRs go from a feature branch cut from `upstream/main`, never from `local/customizations`.

## Routine

Sync, conflict table and build steps: `LOCAL-FORK-WORKFLOW.md`. In short:

1. `git fetch upstream` then merge `upstream/main` into `local/customizations`.
2. Resolve conflicts per the table; after merging, grep `client/src/components/keys/shared.tsx` for new `hidden: true` on locally un-hidden providers.
3. `npx vitest run` in `server/` and `client/`; typecheck both.
4. `npm run desktop:dist:win`, install `desktop/dist-electron/FreeLLMAPI-Setup-<version>.exe`.
5. Push `local/customizations` to `origin`.
