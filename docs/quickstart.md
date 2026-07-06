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

The default executor is the TypeScript `RunExecutor`. On success the CLI prints a JSON line containing the run and worker metadata.

Exit code 0 means the run passed; exit code 1 means it failed or was blocked.

### CLI Options for `run`

| Flag                     | Purpose                                           |
| ------------------------ | ------------------------------------------------- |
| `--issue <number>`       | GitHub issue number (required)                    |
| `--base-branch <branch>` | Base branch (default: main)                       |
| `--model <model>`        | Override the AI model for this run                |
| `--agent-cli <cli>`      | Sets `AI_RUNTIME`                                 |
| `--executor <engine>`    | `ts` (default) or `bash` (legacy, emergency only) |
| `--target-repo-root <p>` | Target repository for worktrees and DB            |
| `--verbose`              | Stream progress to terminal                       |

## Manage runs

The `orchestrator runs` subcommand provides tools for managing active and completed runs.

### Resume a failed run
If a run fails or hits a human-review gate, you can resume it:
```bash
pnpm --filter @ai-sdlc/api dev runs resume --uuid <uuid>
```
Use `--from-phase <phase>` to override the auto-detected resume point.

### Cancel a run
```bash
pnpm --filter @ai-sdlc/api dev runs cancel --uuid <uuid>
```

### Tail logs
```bash
pnpm --filter @ai-sdlc/api dev runs logs --issue 123
```

### Check merge readiness
Verify that all review comments are addressed and verified:
```bash
pnpm --filter @ai-sdlc/api dev runs check-merge-ready --uuid <uuid>
```

## Where things live

All run data is stored under the `.ai-runs/` directory in the repository root (or the target repo root if specified).

| Path                                           | Contents                           |
| ---------------------------------------------- | ---------------------------------- |
| `.ai-runs/orchestrator.sqlite`                 | SQLite database of all runs        |
| `.ai-runs/<displayId>/phase-artifacts/`        | Orchestration artifacts (MD, JSON) |
| `.ai-runs/agent-artifacts/<inv-id>/stdout.log` | Agent stdout per invocation        |
| `.ai-runs/agent-artifacts/<inv-id>/stderr.log` | Agent stderr per invocation        |

Worktrees for active runs are created under `.ai-worktrees/issue-<N>/`.

## Configuration

`.ai-orchestrator.json` at the repo root defines validation commands, phase skip-list, agent profiles, and timeouts.

### Agent Profiles and Routing
You can configure which models are used for different phases in the `agent` section of the config:

```json
{
  "agent": {
    "profiles": {
      "opencode-frontier": {
        "runtime": "opencode",
        "model": "claude-3-5-sonnet-latest"
      }
    },
    "phaseProfiles": {
      "implement": { "profile": "opencode-frontier" }
    }
  }
}
```

## Troubleshooting

**Run stuck in `running`**
If a worker process crashed, the run might be stuck. You can use `runs cancel` or `runs resume` to recover.

**`active run already exists for issue N`**
A previous run for that issue is in a non-terminal state. Resume or cancel it before starting a new one.

**Next.js shows `Failed to load runs: 500`**
The API server is not running. Start it with `pnpm --filter @ai-sdlc/api dev serve` and refresh the dashboard.
