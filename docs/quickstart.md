# Orchestrator Quickstart

## Prerequisites

- **Node 22+** (`node -v` to check)
- **pnpm 9+** — enable via corepack:
  ```bash
  corepack enable
  corepack prepare pnpm@9.12.3 --activate
  ```
- **`gh` CLI** authenticated (`gh auth status` to verify)
- A valid `.ai-orchestrator.json` at the repo root

## Install

```bash
corepack enable   # idempotent; safe to re-run if already enabled
pnpm install
```

## Start the API and UI

Open **two terminals**:

```bash
# Terminal 1 — API
pnpm --filter @ai-sdlc/api dev serve     # http://127.0.0.1:4319

# Terminal 2 — Web dashboard
pnpm --filter @ai-sdlc/web dev           # http://127.0.0.1:4310
```

## Start a run

```bash
pnpm --filter @ai-sdlc/api dev run --issue 123
```

The default executor is the TypeScript `RunExecutor`. On success the CLI prints a JSON line:

<!-- prettier-ignore -->
```json
{"uuid":"a1b2c3d4-…","displayId":"issue-123-20260516-143000","exitCode":0,"status":"passed"}
```

Exit code 0 means the run passed; exit code 1 means it failed.

## Where things live

All run data is under `.ai-runs/` in the repo root.

| Path                                | Contents                               |
| ----------------------------------- | -------------------------------------- |
| `.ai-runs/orchestrator.sqlite`      | SQLite database of all runs            |
| `.ai-runs/agent-artifacts/<inv-id>/stdout.log` | Agent stdout per invocation |
| `.ai-runs/agent-artifacts/<inv-id>/stderr.log` | Agent stderr per invocation |

Worktrees for active runs are under `.ai-worktrees/issue-<N>/`. Completed run artifacts (design.md, plan.md, reviews, PR metadata) are archived to `ai/issues/<N>/`.

## Configuration

`.ai-orchestrator.json` at the repo root defines validation commands, phase skip-list, agent profiles, and timeouts. See [`packages/shared/src/config/schema.ts`](../packages/shared/src/config/schema.ts) for the full schema.

CLI flags for the `run` command:

| Flag                     | Purpose                                            |
| ------------------------ | -------------------------------------------------- |
| `--base-branch <branch>` | Base branch (default: main)                        |
| `--model <model>`        | Override the AI model for this run                 |
| `--agent-cli <cli>`      | Sets `AI_RUNTIME`                                  |
| `--executor <engine>`    | `ts` (default) or `bash` (legacy, emergency only)  |

## Troubleshooting

**Run row stuck in `running`**
Update the row directly:

```bash
sqlite3 .ai-runs/orchestrator.sqlite "UPDATE runs SET status = 'failed' WHERE display_id = '<displayId>' AND status = 'running';"
```

**`active run already exists for issue N`**
A previous run for that issue is in a non-terminal state. Resume or fail it before starting a new one.

**Next.js shows `Failed to load runs: 500`**
The API server is not running. Start it with `pnpm --filter @ai-sdlc/api dev serve` and refresh the dashboard.

## Emergency: legacy Bash executor

The legacy Bash orchestrator is preserved at `scripts/legacy/ai-run-issue-v2` for emergency use. To invoke it explicitly:

```bash
pnpm --filter @ai-sdlc/api dev run --issue 123 --executor bash
```

This path is not the default and is not maintained going forward. See `docs/adr/ADR-0002-typescript-cutover.md` for the cutover history.
