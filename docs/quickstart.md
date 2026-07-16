# Orchestrator Quickstart

This guide covers the implemented TypeScript orchestrator: installation, repository registration, local services, run creation and control, multi-repository scheduling, configuration, state, and recovery.

## Prerequisites

- Node.js 22 or newer (`node --version`)
- pnpm 9 or newer (`pnpm --version`)
- Git
- GitHub CLI authenticated for every repository you will operate (`gh auth status`)
- A local checkout of this automation repository
- A valid `.ai-orchestrator.json` in the automation repository

Target repositories must be existing local Git working trees whose GitHub identity can be resolved through Git/`gh`. The control plane will not clone arbitrary repositories or operate on unregistered paths.

## Install

From the automation repository:

```bash
corepack enable
corepack prepare pnpm@9.12.3 --activate
pnpm install
pnpm -r build
```

Confirm the CLI is available:

```bash
pnpm --filter @ai-sdlc/api dev --help
```

All examples below use the workspace development command. After packaging, the equivalent binary form is `orchestrator ...`.

## Choose a process topology

| Mode          | Command                                       | Use                                                                         |
| ------------- | --------------------------------------------- | --------------------------------------------------------------------------- |
| API scheduler | `pnpm --filter @ai-sdlc/api dev serve`        | Required control-plane/API process and the simplest single-host deployment. |
| Extra worker  | `pnpm --filter @ai-sdlc/api dev worker start` | Optional same-host scheduler worker process supervised independently.       |

Run only one API/control-plane process. Additional workers are supported only when every process shares the same host, state root, and SQLite files. Each process enforces its own `globalConcurrency`; Repository leases prevent concurrent ownership of one Repository across processes.

## Start the API and dashboard

Open two terminals:

```bash
# Terminal 1: API plus embedded scheduler/worker pool
pnpm --filter @ai-sdlc/api dev serve

# Terminal 2: browser dashboard
pnpm --filter @ai-sdlc/web dev
```

Default addresses:

- API: `http://127.0.0.1:4319`
- Dashboard: `http://127.0.0.1:4310`

For a separate worker topology, start the API according to your deployment configuration and run one or more same-host workers:

```bash
pnpm --filter @ai-sdlc/api dev worker start
pnpm --filter @ai-sdlc/api dev worker start --global-concurrency 4
```

`--global-concurrency` and `--poll-interval-ms` override scheduler configuration for that process. The global counter is process-local; it is not a distributed cluster-wide limit.

## Register repositories

Register every checkout the control plane may operate on:

```bash
pnpm --filter @ai-sdlc/api dev repo register \
  --local-path /absolute/path/to/acme-api

pnpm --filter @ai-sdlc/api dev repo register \
  --local-path /absolute/path/to/acme-web
```

The command validates the local path and GitHub identity before persisting the Repository. `--full-name owner/repo` may be supplied as a consistency check, but it must match the identity resolved through Git/`gh`.

Inspect the registry:

```bash
pnpm --filter @ai-sdlc/api dev repo list
pnpm --filter @ai-sdlc/api dev repo list --all --json
pnpm --filter @ai-sdlc/api dev repo inspect --full-name acme/api
```

Repository IDs are stable SHA-256 identifiers. Commands that accept `<id|owner/name>` resolve either form; commands documented as `--id` require the stable ID unless their help says otherwise.

Manage repository availability:

```bash
pnpm --filter @ai-sdlc/api dev repo disable --id <repository-id>
pnpm --filter @ai-sdlc/api dev repo enable --id <repository-id>
pnpm --filter @ai-sdlc/api dev repo refresh --id <repository-id>
```

Disabling a Repository blocks new admission while already admitted work drains. A degraded, unreachable, or otherwise unavailable Repository is skipped without preventing healthy repositories from running. `repo refresh` re-resolves Git/GitHub metadata and health after an operator repairs a path or remote.

## Start a run

The TypeScript `RunExecutor` is the default:

```bash
pnpm --filter @ai-sdlc/api dev run \
  --repository-id acme/api \
  --target-repo-root /absolute/path/to/acme-api \
  --issue 123
```

When exactly one Repository is enabled, `--repository-id` may be omitted. With more than one enabled Repository it is required.

Useful run options:

```text
--base-branch <branch>     Override the Repository default branch.
--executor ts              TypeScript executor (default).
--executor bash            Deprecated emergency fallback.
--verbose / --no-verbose   Control progress streaming.
--target-repo-root <path>  Use a target checkout's legacy/single-target state context.
```

On successful enqueue/start, the command emits JSON containing the Run UUID, display ID, repository identity, exit code, and status. Keep the UUID for management commands.

## Canonical phases

The TypeScript executor advances through:

```text
read_issue
→ plan-design
→ plan-write
→ plan-review
→ implement
→ validate
→ fix-validate
→ review-fix
→ compound
→ create-pr
→ post-pr-review
```

The top-level phases are durable orchestration state. Review, fix, arbitration, and terminal-repair invocations inside a phase may have more specific labels in logs and artifacts.

## Run statuses

| Status               | Operator interpretation                                             |
| -------------------- | ------------------------------------------------------------------- |
| `queued`             | Waiting for a Worker to claim the Job.                              |
| `running`            | Active execution.                                                   |
| `waiting`            | Waiting for external PR review activity; eligible for reactivation. |
| `blocked`            | Waiting for an external condition or explicit operator action.      |
| `needs_human_review` | Automated policy exhausted; inspect artifacts before resuming.      |
| `passed`             | Successful terminal state.                                          |
| `failed`             | Failed terminal state.                                              |
| `cancelled`          | Cancelled terminal state.                                           |

Only `passed`, `failed`, and `cancelled` are terminal in the domain model.

## Manage runs

### Follow logs

`runs logs` currently selects the Repository through its target root and the Run through its issue number:

```bash
pnpm --filter @ai-sdlc/api dev runs logs \
  --issue 123 \
  --target-repo-root /absolute/path/to/acme-api

pnpm --filter @ai-sdlc/api dev runs logs \
  --issue 123 \
  --target-repo-root /absolute/path/to/acme-api \
  --no-follow \
  --lines 100
```

### Cancel

Cancel by UUID or by Repository-scoped issue number, but not both:

```bash
pnpm --filter @ai-sdlc/api dev runs cancel \
  --uuid <run-uuid> \
  --repository-id acme/api \
  --target-repo-root /absolute/path/to/acme-api \
  --reason "operator requested"
```

### Execute queued or waiting work

```bash
pnpm --filter @ai-sdlc/api dev runs execute \
  --uuid <run-uuid> \
  --repository-id acme/api \
  --target-repo-root /absolute/path/to/acme-api
```

`execute` accepts Runs in `queued`, `running`, or `waiting` state, acquires the Repository lease, and advances them through the `RunExecutor`.

### Resume or retry

```bash
pnpm --filter @ai-sdlc/api dev runs resume \
  --uuid <run-uuid> \
  --repository-id acme/api \
  --target-repo-root /absolute/path/to/acme-api

pnpm --filter @ai-sdlc/api dev runs resume \
  --uuid <run-uuid> \
  --repository-id acme/api \
  --target-repo-root /absolute/path/to/acme-api \
  --from-phase implement \
  --confirm
```

The command auto-detects the failed or blocked phase unless `--from-phase` is supplied. Unsafe phase retries stop with guidance and require `--confirm`; inspect the Run and worktree before confirming.

### Check merge readiness

```bash
pnpm --filter @ai-sdlc/api dev runs check-merge-ready \
  --uuid <run-uuid> \
  --repository-id acme/api \
  --target-repo-root /absolute/path/to/acme-api
```

The command fails for unknown Runs and for PRs with unverified or blocked review comments.

Use `pnpm --filter @ai-sdlc/api dev runs --help` and the individual subcommand help before scripting these interfaces.

## Dashboard and API context

The dashboard provides:

- a global run view with Repository identity;
- Repository selection and Repository-specific run views;
- Repository health and enabled state;
- explicit Repository selection for run creation when multiple repositories are enabled;
- Repository-preserving links to run detail, logs, artifacts, phases, jobs, and workers.

The API accepts stable Repository IDs and resolves `owner/name` compatibility inputs where documented. Runs, jobs, leases, artifacts, and mutations are checked against persisted Repository ownership; clients do not supply arbitrary filesystem paths as resource identity.

## Configuration

The automation repository's `.ai-orchestrator.json` is required. A gitignored `.ai-orchestrator.local.json` may contain operator-specific overrides. For a selected target Repository, configuration is layered in this order:

1. `automation/.ai-orchestrator.json`
2. `automation/.ai-orchestrator.local.json`
3. `target/.ai-orchestrator.json`
4. `target/.ai-orchestrator.local.json`
5. supported CLI overrides

Plain objects deep-merge. Arrays follow the loader's indexed deep-merge behavior. Phase routing maps are replaced as policy units rather than partially combined. The persisted Run records the effective configuration fingerprint and source paths without copying local configuration contents into artifacts.

Key sections include:

```jsonc
{
  "validation": {
    "commands": ["pnpm -r build", "pnpm -r test"],
    "timeout": 1800,
  },
  "phases": {
    "skip": [],
    "implement": { "maxIterations": 3 },
    "reviewFix": { "maxIterations": 3 },
  },
  "scheduler": {
    "globalConcurrency": 1,
    "pollIntervalMs": 2000,
    "shutdownGraceMs": 30000,
  },
  "agent": {
    "defaultProfile": "opencode-frontier",
    "profiles": {},
    "phaseProfiles": {},
  },
}
```

The example is structural, not a complete usable agent configuration. The authoritative schema is [`packages/shared/src/config/schema.ts`](../packages/shared/src/config/schema.ts).

### Agent profiles and fallback

Each Agent Profile declares a runtime, provider, model, timeout, and optional prompt/context/output budgets. `agent.phaseProfiles` maps a phase to its primary profile and optional fallback profile/triggers. Phase and loop use cases own semantic fallback decisions; the runtime router owns mechanical dispatch and objective adapter failures.

Supported runtime kinds in the current schema are `opencode`, `pi`, `antigravity`, `claude-code`, and `codex`.

## State, artifacts, and worktrees

There are two active path models because the CLI preserves the original single-target interface while the centralized runtime namespaces repositories.

### Single-target/default CLI context

Unless overridden by `--db-path`, `--runs-dir`, or `--target-repo-root`:

| Path                                    | Contents                                                       |
| --------------------------------------- | -------------------------------------------------------------- |
| `<target>/.ai-runs/orchestrator.sqlite` | Registry and composed runtime database for the target context. |
| `<target>/.ai-runs/agent-artifacts/`    | Captured invocation stdout/stderr and durable agent artifacts. |
| `<target>/.ai-worktrees/issue-<N>/`     | Active issue worktree.                                         |
| `<target>/ai/issues/<N>/`               | Completed issue artifacts archived by the pipeline.            |

### Centralized RepositoryRuntime context

Centralized runtimes use a state root. It is `opts.baseTmpDir` when embedded programmatically, otherwise `$TMPDIR/.ai-tmp` when `TMPDIR` is set, or `<target>/.ai-tmp` by default. Under that root, every Repository is namespaced by `owner/name`:

| Path under `<state-root>`                      | Contents                                        |
| ---------------------------------------------- | ----------------------------------------------- |
| `.ai-state/<owner>/<name>/orchestrator.sqlite` | Repository operational database.                |
| `.ai-runs/<owner>/<name>/`                     | Repository Run directories and validation logs. |
| `.ai-worktrees/<owner>/<name>/issue-<N>/`      | Collision-free worktrees.                       |
| `.ai-artifacts/<owner>/<name>/`                | Agent artifacts.                                |
| `.ai-tmp/<owner>/<name>/`                      | Repository-scoped prompts and temporary files.  |

Do not assume two repositories with the same issue number share any runtime path. Repository namespacing is a safety boundary.

## Recovery and shutdown

Recovery runs as an all-Repository startup barrier before new admission. It evaluates worker health, expired job claims, expired leases, Run state, and worktree safety. Ownership tokens fence old processes after reclamation.

On SIGTERM/SIGINT, the scheduler stops new admission and drains in-flight work up to `scheduler.shutdownGraceMs`. Cooperative work releases ownership. If a child does not settle before the grace window, the process follows the crash-equivalent path: ownership remains fenced and expires for the next recovery pass.

If a Repository path moves or becomes unavailable:

1. Stop or disable admission for that Repository.
2. Restore the checkout/mount or correct its registered metadata.
3. Run `repo refresh --id <repository-id>`.
4. Inspect leases, jobs, Run state, and recovery events.
5. Re-enable the Repository only after health is restored.

See [Scheduler Recovery Operations](operations/scheduler-recovery.md) for the state machine, fencing rules, SQL inspection, and operator procedures.

## Emergency legacy executor

The Bash orchestrator is quarantined under `scripts/legacy/` and is not maintained as the default path:

```bash
pnpm --filter @ai-sdlc/api dev run \
  --repository-id acme/api \
  --target-repo-root /absolute/path/to/acme-api \
  --issue 123 \
  --executor bash
```

`--model`, `--agent-cli`, and `--script` exist for this fallback. They are rejected for `--executor ts`. Use the Bash path only for a deliberate emergency rollback and expect it to lack newer TypeScript-only orchestration behavior.

## Troubleshooting

### More than one Repository is enabled

Pass `--repository-id <id|owner/name>` to `run`, `cancel`, `execute`, `resume`, and `check-merge-ready`.

### Repository is unavailable

Run `repo inspect` and `repo refresh`, repair the local checkout or GitHub authentication, then enable the Repository after it reports healthy.

### Active Run already exists

Only one active Run is allowed for a `(Repository, issue)` pair. Inspect the existing Run and choose resume, cancel, or wait for it to finish.

### Repository lease conflict

Another Worker owns that Repository. Do not delete lease rows manually. Inspect worker/lease state and follow the recovery guide; generation fencing and worktree safety checks are part of reclamation.

### Dashboard cannot load runs

Confirm the API is listening on port 4319 and that the dashboard is pointed at that API.

## Before contributing a PR

Run all mandatory gates:

```bash
pnpm -r build
pnpm -r typecheck
pnpm lint
pnpm -r test
```

When changing imports across packages or apps, also run `pnpm depcruise`.
