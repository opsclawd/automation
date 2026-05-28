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

The legacy Bash script works in `.ai-worktrees/issue-<N>` and archives its
outputs (design.md, plan.md, validation logs, reviews, PR metadata) to
`ai/issues/<N>/` on completion. In M1 the wrapper does not copy those files
into `.ai-runs/<displayId>/artifacts`; find the legacy script's working
artifacts in `ai/issues/<N>/` instead.

## Configuration

`.ai-orchestrator.json` at the repo root defines a schema for validation
commands, skip-list, and timeouts
(see [`packages/shared/src/config/schema.ts`](../packages/shared/src/config/schema.ts)),
but the M1 wrapper run path does **not** read this file.
The legacy Bash script also hard-codes its own validation commands and
timeouts. Editing `.ai-orchestrator.json` will not affect M1 runs.

CLI flags for the `run` command:

| Flag                     | Wrapper env var  | Script env var   | Purpose                                            |
| ------------------------ | ---------------- | ---------------- | -------------------------------------------------- |
| `--base-branch <branch>` | `AI_BASE_BRANCH` | `BASE_BRANCH`    | Base branch (default: main)                        |
| `--model <model>`        | `AI_AGENT_MODEL` | `AI_AGENT_MODEL` | Override the AI model                              |
| `--agent-cli <cli>`      | `AI_RUNTIME`     | —                | Sets `AI_RUNTIME` (runtime resolved from profiles) |

The wrapper passes CLI flags as `AI_*` env vars to the script's process
environment. The script reads `BASE_BRANCH` for branch config, and
`AI_AGENT_MODEL` / `AI_AGENT_PROVIDER` are handled by `run-agent.ts` via
`AgentRuntimeRouter`. `AI_RUNTIME` is set by the wrapper but not consumed
by the routed agent path (runtime is determined by profiles in
`.ai-orchestrator.json`).

For the orchestrator's agent runtime, set `AI_AGENT_PROVIDER` and
`AI_AGENT_MODEL` to override the provider and model from
`.ai-orchestrator.json` for a single run:

```bash
AI_AGENT_PROVIDER=opencode-go AI_AGENT_MODEL=glm-5.1 \
  pnpm --filter @ai-sdlc/api dev run --issue 115
```

These apply to all phases for the run, including fallback profiles.
Blank values fall through to the profile default.

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
