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
# Terminal 1 — API (includes embedded worker pool)
pnpm --filter @ai-sdlc/api dev serve     # http://127.0.0.1:4319

# Terminal 2 — Web dashboard
pnpm --filter @ai-sdlc/web dev           # http://127.0.0.1:4310
```

## Worker Modes

The orchestrator supports two worker modes that are **mutually exclusive for a single control plane**:

| Mode       | Command                                       | Worker Pool            | Use Case                              |
| ---------- | --------------------------------------------- | ---------------------- | ------------------------------------- |
| Embedded   | `pnpm --filter @ai-sdlc/api dev serve`        | Built into API process | Local development, single-machine VPS |
| Standalone | `pnpm --filter @ai-sdlc/api dev worker start` | Separate process(es)   | Multi-worker production               |

**Warning:** Do not run both `serve` (with embedded pool) and standalone `worker start` simultaneously against the same control plane. They compete for the same job queue and will produce duplicate dispatches. Choose one mode per deployment.

### Embedded pool (`serve`)

When running `pnpm --filter @ai-sdlc/api dev serve`, the API process includes an embedded scheduler that polls the job queue and dispatches workers directly. The worker pool runs in the same process as the API.

### Standalone worker (`worker start`)

```bash
# Start one or more standalone worker processes
pnpm --filter @ai-sdlc/api dev worker start

# With custom global concurrency
pnpm --filter @ai-sdlc/api dev worker start --global-concurrency 4
```

Workers poll the API for available jobs. Multiple worker processes can run concurrently on the **same machine** as long as they share access to the same SQLite database and control plane. Running workers across multiple machines is not supported — the scheduler uses local PID checks and hostname comparison for liveness detection, which are ambiguous across hosts.

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

| Path                                           | Contents                    |
| ---------------------------------------------- | --------------------------- |
| `.ai-runs/orchestrator.sqlite`                 | SQLite database of all runs |
| `.ai-runs/agent-artifacts/<inv-id>/stdout.log` | Agent stdout per invocation |
| `.ai-runs/agent-artifacts/<inv-id>/stderr.log` | Agent stderr per invocation |

Worktrees for active runs are under `.ai-worktrees/issue-<N>/`. Completed run artifacts (design.md, plan.md, reviews, PR metadata) are archived to `ai/issues/<N>/`.

## Configuration

`.ai-orchestrator.json` at the repo root defines validation commands, phase skip-list, agent profiles, and timeouts. See [`packages/shared/src/config/schema.ts`](../packages/shared/src/config/schema.ts) for the full schema.

CLI flags for the `run` command:

| Flag                     | Purpose                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------ |
| `--base-branch <branch>` | Base branch (default: target repository default branch). Used for worktree creation and PR base. |
| `--model <model>`        | `AI_AGENT_MODEL` env var (Bash executor only). Rejected for `--executor ts`.                     |
| `--agent-cli <cli>`      | `AI_RUNTIME` env var (Bash executor only). Rejected for `--executor ts`.                         |
| `--executor <engine>`    | `ts` (default) or `bash` (legacy, emergency only)                                                |

## Managing a targeted run

When you start a run against a different repository using `--target-repo-root <path>`, every follow-up command must point at the same target — otherwise it will read the orchestrator's own database and artifact directories. Pass `--target-repo-root` to each follow-up command:

```bash
# Start a run against /path/to/target-repo
pnpm --filter @ai-sdlc/api dev run --issue 123 --target-repo-root /path/to/target-repo

# Operate on that run from the orchestrator repo
pnpm --filter @ai-sdlc/api dev runs logs --issue 123 --target-repo-root /path/to/target-repo
pnpm --filter @ai-sdlc/api dev runs check-merge-ready --uuid <uuid> --target-repo-root /path/to/target-repo
pnpm --filter @ai-sdlc/api dev runs execute --uuid <uuid> --target-repo-root /path/to/target-repo
pnpm --filter @ai-sdlc/api dev runs resume --uuid <uuid> --target-repo-root /path/to/target-repo
pnpm --filter @ai-sdlc/api dev runs cancel --uuid <uuid> --target-repo-root /path/to/target-repo
```

The path must point at an existing directory that is inside a git working tree. Omitting the flag preserves the existing single-repo behavior (the orchestrator repo is used).

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

## Serving a target repository

The orchestrator server can be bound to a specific target repository. This is useful when you want to inspect or manage runs for a repository other than the one where the orchestrator is installed.

```bash
pnpm --filter @ai-sdlc/api dev serve --target-repo-root /path/to/target/repo
```

When bound to a target repository, the API and dashboard will:

- Use the target repository's `.ai-runs/orchestrator.sqlite` database.
- Read and write artifacts to the target repository's `.ai-runs/` directory.
- Perform Git and worktree operations inside the target repository.
- Display the target repository's name and path in the dashboard header.

## Emergency: legacy Bash executor

The legacy Bash orchestrator is preserved at `scripts/legacy/ai-run-issue-v2` for emergency use. To invoke it explicitly:

```bash
pnpm --filter @ai-sdlc/api dev run --issue 123 --executor bash
```

This path is not the default and is not maintained going forward. See `docs/adr/ADR-0002-typescript-cutover.md` for the cutover history.

## Cross-repository configuration

A single installation of the orchestrator can drive runs against multiple
target repositories. Each target may ship its own
`.ai-orchestrator.json` and `.ai-orchestrator.local.json`. The precedence
is deterministic:

1. `automation/.ai-orchestrator.json` (committed, automation repo)
2. `automation/.ai-orchestrator.local.json` (gitignored)
3. `target/.ai-orchestrator.json` (committed, target repo)
4. `target/.ai-orchestrator.local.json` (gitignored, target repo)
5. Explicit supported CLI overrides (`--base-branch`, `--model`,
   `--agent-cli`)

Important merge semantics:

- Plain objects are deep-merged.
- Arrays (`validation.commands`, `phases.skip`) are deep-merged by index.
  When the override array is longer, extras append — this means target
  `validation.commands` _extend_ the automation list, not replace it.
- `agent.phaseProfiles` and any future phase-route maps are replaced
  wholesale, not key-by-key, because individual entries contain
  mutually exclusive fields.

Run metadata records both the **effective configuration fingerprint**
(sha256 of the merged config) and the **source files used** (paths only,
never file contents). Local files are never copied into run artifacts.

Example: two projects with different test runners:

```jsonc
// automation/.ai-orchestrator.json
{
  "validation": { "commands": ["echo base-validation"], "timeouts": { "build": 60 } },
  "agent": { "model": "shared-default-model" },
}
```

```jsonc
// /srv/repos/frontend/.ai-orchestrator.json
{
  "validation": { "commands": ["pnpm test"] },
}
```

```jsonc
// /srv/repos/backend/.ai-orchestrator.json
{
  "validation": { "commands": ["make test"], "timeouts": { "build": 180 } },
  "agent": { "model": "backend-finetuned" },
}
```

When run against `frontend`: commands are `["echo base-validation", "pnpm test"]`, model is `shared-default-model`.

When run against `backend`: commands are `["echo base-validation", "make test"]`, timeouts override build to `180`, model is `backend-finetuned`.

## Migration

- Multi-repo: migration 0025 backfills every run with a stable `repositoryId`; new `POST /api/runs` requires `repositoryId` when more than one repository is enabled.

## Scheduler Configuration

The scheduler drives multi-repository dispatch. Key settings in `.ai-orchestrator.json`:

```jsonc
{
  "scheduler": {
    "globalConcurrency": 1, // Max dispatches across ALL repos (default: 1)
    "pollIntervalMs": 2000, // How often to poll for new work (default: 2000)
  },
}
```

### Global Concurrency Override

```bash
# Standalone worker with custom concurrency
pnpm --filter @ai-sdlc/api dev worker start --global-concurrency 4

# In .ai-orchestrator.local.json
{
  "scheduler": {
    "globalConcurrency": 4
  }
}
```

With `globalConcurrency=1`, only one dispatch is active across all repositories at once. Each repository still enforces one-lease-at-a-time via `WorkerLease`.

### Disable Policy

Setting `enabled=false` on a repository:

- **Drains admitted work:** In-flight dispatches complete normally
- **Blocks new work:** Subsequent schedule passes skip the disabled repository

```jsonc
// Via API
PUT /api/repositories/{id}
{ "enabled": false }
```

### Unhealthy/Unavailable Skip Policy

Repositories with `healthStatus` of `degraded`, `unreachable`, or `unknown` are skipped without blocking healthy repositories. The scheduler records a `scheduler.repository.skipped` telemetry event with reason `disabled`, `unhealthy`, or `unavailable`.

### Telemetry Identity Fields

Every scheduler event includes stable identity fields:

| Field             | Source                            | Example        |
| ----------------- | --------------------------------- | -------------- |
| `repository_id`   | Stable repo identifier (fullName) | `acme/api`     |
| `repository_name` | Current full name                 | `acme/api`     |
| `worker_id`       | Per-repo sequence                 | `w-acme/api-0` |

Events: `scheduler.dispatch.started`, `scheduler.dispatch.completed`, `scheduler.dispatch.failed`, `scheduler.repository.skipped`, `scheduler.pool.active`, `scheduler.repository.queue_depth`.

## Recovery Operations

For details on scheduler recovery behavior, lease/claim token fencing, startup barriers, shutdown/grace fallback, and operator procedures for restoring a moved or deleted checkout, see [`docs/operations/scheduler-recovery.md`](../operations/scheduler-recovery.md).
