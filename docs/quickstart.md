# Orchestrator Quickstart (M1)

## Prerequisites

- **Node 22+** (`node -v` to check)
- **pnpm 9+** — enable via corepack:
  ```bash
  corepack enable
  corepack prepare pnpm@9.12.3 --activate
  ```
- **`gh` CLI** authenticated (`gh auth status` to verify) — required by the legacy Bash script.
- A repository that contains `scripts/ai-run-issue-v2` and a valid `.ai-orchestrator.json`.

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

On success the CLI prints a JSON line:

<!-- prettier-ignore -->
```json
{"uuid":"a1b2c3d4-…","displayId":"issue-123-20260516-143000","exitCode":0,"status":"passed"}
```

Exit code 0 means the run passed; exit code 1 means it failed.

## Where things live

All run data is under `.ai-runs/` in the repo root.

| Path                                | Contents                               |
| ----------------------------------- | -------------------------------------- |
| `.ai-runs/<displayId>/run.json`     | Structured run metadata                |
| `.ai-runs/<displayId>/stdout.log`   | Script stdout                          |
| `.ai-runs/<displayId>/stderr.log`   | Script stderr                          |
| `.ai-runs/<displayId>/combined.log` | Merged stdout + stderr                 |
| `.ai-runs/<displayId>/failure.json` | Classified failure (if the run failed) |
| `.ai-runs/<displayId>/events.jsonl` | Structured event log                   |
| `.ai-runs/orchestrator.sqlite`      | SQLite database of all runs            |

Each run directory also contains `phases/` and `artifacts/` subdirectories.

## Configuration

`.ai-orchestrator.json` at the repo root configures validation commands, skip-list, and timeouts.
See [`packages/shared/src/config/schema.ts`](../packages/shared/src/config/schema.ts) for the full schema.

CLI flags for the `run` command:

| Flag                     | Wrapper env var  | Script env var | Purpose                     |
| ------------------------ | ---------------- | -------------- | --------------------------- |
| `--base-branch <branch>` | `AI_BASE_BRANCH` | `BASE_BRANCH`  | Base branch (default: main) |
| `--model <model>`        | `AI_MODEL`       | `AGENT_MODEL`  | Override the AI model       |
| `--agent-cli <cli>`      | `AI_RUNTIME`     | `AGENT_CLI`    | Override the agent CLI      |

The wrapper passes CLI flags as `AI_*` env vars to the script's process
environment, but the legacy Bash script reads `BASE_BRANCH`, `AGENT_MODEL`,
and `AGENT_CLI` instead. Until the script is updated to read the `AI_*` names,
set the script's env vars directly to override defaults.

## Troubleshooting

**Run row stuck in `running`**
The wrapper process died without updating the row. This will be fixed in a future milestone. For now, update the row directly:

```bash
sqlite3 .ai-runs/orchestrator.sqlite "UPDATE runs SET status = 'failed' WHERE display_id = '<displayId>' AND status = 'running';"
```

Replace `<displayId>` with the stuck run's display ID (visible in the run list or the `displayId` field from the CLI output).

Verify the schema first with `.schema runs` in the SQLite shell. If the table or column names differ, adjust the statement accordingly.

**`active run already exists for issue N`**
A previous run for that issue is in a non-terminal state. Resolve or fail the previous run before starting a new one.

**Next.js shows `Failed to load runs: 500`**
The API server is not running. Start it with `pnpm --filter @ai-sdlc/api dev serve` and refresh the dashboard.
