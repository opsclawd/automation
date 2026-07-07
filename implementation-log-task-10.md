# Task 10 — Wire loadLayeredConfig into apps/cli/src/run-agent.ts and run-review-fix.ts

## Scope
Modify two files in CLI:
- `apps/cli/src/run-agent.ts`
- `apps/cli/src/run-review-fix.ts`

## Changes

### run-agent.ts
- Modified imports to load `loadLayeredConfig` and `writeFileSync`.
- Added safety warning comments about not inlining file contents in `config-sources.json`.
- Updated `Flags` interface and `parseArgs` to support the `--target-repo-root` string option.
- Replaced `loadConfig` call with `loadLayeredConfig` loading (using optional `target-repo-root`).
- Wrote `config-sources.json` to the run directory after ensuring the run row exists/is created.

### run-review-fix.ts
- Modified imports to load `loadLayeredConfig`, `writeFileSync`, and `mkdirSync`.
- Imported `join` from `node:path`.
- Added safety warning comments.
- Updated `Flags` interface and `parseArgs` to support the `--target-repo-root` string option.
- Replaced `loadConfig` call with `loadLayeredConfig` loading.
- Wrote `config-sources.json` to the run directory after ensuring the run row exists/is created.

## Verification
- Run `pnpm -F @ai-sdlc/cli typecheck` → PASS
- Run `pnpm -F @ai-sdlc/cli test` → PASS (106/106 tests)

## Files changed
- `apps/cli/src/run-agent.ts`
- `apps/cli/src/run-review-fix.ts`
