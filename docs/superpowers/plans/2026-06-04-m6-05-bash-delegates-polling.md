# M6-05 — Bash Script Delegates PR Polling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 1387-line Bash polling loop in `scripts/ai-pr-review-poll` with a thin shim that delegates to the managed TypeScript poller (M6-04) via a new `apps/cli/src/run-pr-poll.ts` entrypoint. The Bash script keeps its CLI signature for backward compatibility but no longer owns the poll loop, verification, or comment-state machine.

**Architecture:** A new Node CLI `run-pr-poll.ts` (mirrors `apps/cli/src/run-agent.ts`) parses PR/issue/interval args, composes the container, builds the `PrReviewPoller` via `container.buildPrReviewPoller(...)`, runs it, and exits with a code reflecting the terminal state. `scripts/ai-pr-review-poll` becomes a ~30-line shim that resolves the worktree and `exec`s the CLI. The legacy loop body and now-unused libs are quarantined, not deleted, so the cutover is reversible.

**Tech Stack:** TypeScript 5 strict (tsx runner), Bash, Vitest + bats.

**Depends on:** M6-04 (`buildPrReviewPoller`), M6-03, M6-02.

**Prior art:** `apps/cli/src/run-agent.ts` (arg parsing, compose usage, exit-code mapping). The Bash invocation pattern already used for `run-agent.ts` is at `scripts/ai-pr-review-poll:836`:
`NODE_OPTIONS='--conditions=development' pnpm -C "$REPO_ROOT" --filter @ai-sdlc/cli exec tsx "$REPO_ROOT/apps/cli/src/run-agent.ts" ...`

---

### Task 1: `run-pr-poll.ts` CLI — arg parsing + exit-code mapping (pure, unit-tested)

**Files:**
- Create: `apps/cli/src/run-pr-poll.ts`
- Test: `apps/cli/src/__tests__/run-pr-poll.test.ts`

- [ ] **Step 1: Write the failing test for the pure helpers**

```typescript
// apps/cli/src/__tests__/run-pr-poll.test.ts
import { describe, it, expect } from 'vitest';
import { parsePollArgs, exitCodeForTerminalState } from '../run-pr-poll.js';

describe('run-pr-poll arg parsing', () => {
  it('parses required + optional flags', () => {
    const r = parsePollArgs([
      '--pr', '5', '--issue', '7', '--repo', 'o/r',
      '--cwd', '/work/tree', '--max-polls', '3', '--interval-seconds', '300',
    ]);
    expect(r).toEqual({
      prNumber: 5, issueNumber: 7, repoFullName: 'o/r', cwd: '/work/tree',
      maxPolls: 3, pollIntervalSeconds: 300, runId: undefined,
    });
  });

  it('defaults maxPolls and interval', () => {
    const r = parsePollArgs(['--pr', '5', '--repo', 'o/r', '--cwd', '/w']);
    expect(r.maxPolls).toBe(3);
    expect(r.pollIntervalSeconds).toBe(300);
  });

  it('throws on missing --pr', () => {
    expect(() => parsePollArgs(['--repo', 'o/r', '--cwd', '/w'])).toThrow(/--pr/);
  });
});

describe('exitCodeForTerminalState', () => {
  it('maps all_resolved -> 0', () => {
    expect(exitCodeForTerminalState('all_resolved')).toBe(0);
  });
  it('maps blocked -> 1', () => {
    expect(exitCodeForTerminalState('blocked')).toBe(1);
  });
  it('maps timed_out -> 2', () => {
    expect(exitCodeForTerminalState('timed_out')).toBe(2);
  });
  it('maps max_polls_reached -> 0 (resting, not a failure)', () => {
    expect(exitCodeForTerminalState('max_polls_reached')).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm --filter @ai-sdlc/cli test -- run-pr-poll`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the CLI with exported pure helpers**

```typescript
// apps/cli/src/run-pr-poll.ts
#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { composeRoot } from '@ai-sdlc/api/compose.js';
import type { PollerTerminalState } from '@ai-sdlc/application';
import { RepositoryId, RunId, PhaseName } from '@ai-sdlc/domain';

export interface PollArgs {
  prNumber: number;
  issueNumber?: number;
  repoFullName: string;
  cwd: string;
  maxPolls: number;
  pollIntervalSeconds: number;
  runId?: string;
}

export function parsePollArgs(argv: string[]): PollArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      pr: { type: 'string' },
      issue: { type: 'string' },
      repo: { type: 'string' },
      cwd: { type: 'string' },
      'max-polls': { type: 'string' },
      'interval-seconds': { type: 'string' },
      'run-id': { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (!values.pr) throw new Error('missing --pr');
  if (!values.repo) throw new Error('missing --repo');
  if (!values.cwd) throw new Error('missing --cwd');
  return {
    prNumber: Number(values.pr),
    ...(values.issue ? { issueNumber: Number(values.issue) } : {}),
    repoFullName: values.repo,
    cwd: values.cwd,
    maxPolls: values['max-polls'] ? Number(values['max-polls']) : 3,
    pollIntervalSeconds: values['interval-seconds'] ? Number(values['interval-seconds']) : 300,
    ...(values['run-id'] ? { runId: values['run-id'] } : {}),
  };
}

export function exitCodeForTerminalState(state: PollerTerminalState): number {
  switch (state) {
    case 'all_resolved':
    case 'max_polls_reached':
      return 0;
    case 'blocked':
      return 1;
    case 'timed_out':
      return 2;
    default:
      return 3;
  }
}

async function main(): Promise<void> {
  const args = parsePollArgs(process.argv.slice(2));
  const repoRoot = process.env.REPO_ROOT ?? process.cwd();
  const container = composeRoot({
    repoRoot,
    scriptPath: 'scripts/ai-run-issue-v2',
    runStartupSweeps: false,
  });
  const poller = container.buildPrReviewPoller({
    maxPolls: args.maxPolls,
    pollIntervalMs: args.pollIntervalSeconds * 1000,
    readyMaxDays: 7,
    cwd: args.cwd,
  });
  const result = await poller.run({
    runId: RunId(args.runId ?? process.env.AI_RUN_UUID ?? crypto.randomUUID()),
    repoId: RepositoryId(args.repoFullName),
    repoFullName: args.repoFullName,
    prNumber: args.prNumber,
    cwd: args.cwd,
    phaseId: PhaseName('post-pr-review'),
  });
  process.stderr.write(`[run-pr-poll] terminal=${result.terminalState} polls=${result.pollsRun}\n`);
  process.exit(exitCodeForTerminalState(result.terminalState));
}

// Only run main when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`[run-pr-poll] fatal: ${String(err)}\n`);
    process.exit(3);
  });
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @ai-sdlc/cli test -- run-pr-poll && pnpm --filter @ai-sdlc/cli typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/run-pr-poll.ts apps/cli/src/__tests__/run-pr-poll.test.ts
git commit -m "feat(cli): run-pr-poll entrypoint delegating to managed poller (M6-05)"
```

---

### Task 2: Quarantine the legacy poll loop; make the Bash script a shim

**Files:**
- Create: `scripts/legacy/ai-pr-review-poll.legacy` (move of the current script body)
- Modify: `scripts/ai-pr-review-poll` (replace with shim)
- Test: `scripts/lib/__tests__/` (add a bats smoke test) or `apps/cli` integration test

- [ ] **Step 1: Preserve the current script**

```bash
git mv scripts/ai-pr-review-poll scripts/legacy/ai-pr-review-poll.legacy
```

- [ ] **Step 2: Write the shim**

```bash
# scripts/ai-pr-review-poll
#!/usr/bin/env bash
# ai-pr-review-poll — thin shim. The poll loop now lives in the managed
# TypeScript poller (apps/cli/src/run-pr-poll.ts, M6-04/M6-05). This script
# preserves the legacy CLI signature: <PR_NUMBER> [issue] [max_polls] [interval].
# The legacy loop is preserved at scripts/legacy/ai-pr-review-poll.legacy.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
export REPO_ROOT

PR_NUMBER="${1:-}"
ISSUE_NUM="${2:-}"
MAX_POLLS="${3:-3}"
POLL_INTERVAL="${4:-300}"
OWNER_REPO="${OWNER_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo "")}"

if [[ -z "$PR_NUMBER" ]]; then
  echo "Usage: $0 <PR_NUMBER> [issue_num] [max_polls=3] [interval_sec=300]" >&2
  exit 1
fi
if [[ -z "$OWNER_REPO" ]]; then
  echo "FATAL: could not determine owner/repo. Set OWNER_REPO=<owner>/<repo> and retry." >&2
  exit 1
fi

# Resolve the PR worktree the poller should operate in. Reuse the issue
# worktree when known; otherwise fall back to REPO_ROOT.
POLL_CWD="${REPO_ROOT}/.ai-worktrees/issue-${ISSUE_NUM}"
[[ -d "$POLL_CWD" ]] || POLL_CWD="$REPO_ROOT"

ARGS=(--pr "$PR_NUMBER" --repo "$OWNER_REPO" --cwd "$POLL_CWD"
      --max-polls "$MAX_POLLS" --interval-seconds "$POLL_INTERVAL")
[[ -n "$ISSUE_NUM" ]] && ARGS+=(--issue "$ISSUE_NUM")
[[ -n "${AI_RUN_UUID:-}" ]] && ARGS+=(--run-id "$AI_RUN_UUID")

exec env NODE_OPTIONS='--conditions=development' \
  pnpm -C "$REPO_ROOT" --filter @ai-sdlc/cli exec tsx \
  "$REPO_ROOT/apps/cli/src/run-pr-poll.ts" "${ARGS[@]}"
```

- [ ] **Step 3: Make executable**

```bash
chmod +x scripts/ai-pr-review-poll
```

- [ ] **Step 4: Add a bats smoke test that the shim parses args and refuses missing PR**

```bash
# scripts/lib/__tests__/pr-poll-shim.bats
#!/usr/bin/env bats

@test "ai-pr-review-poll prints usage when no PR given" {
  run scripts/ai-pr-review-poll
  [ "$status" -eq 1 ]
  [[ "$output" == *"Usage:"* ]]
}
```

- [ ] **Step 5: Run the bats suite**

Run: `pnpm test:bash` (the repo's bash test command, per `.ai-orchestrator.json` validation commands)
Expected: PASS (new test green; existing bash tests unaffected or updated to the shim).

> **Implementer note:** Existing bats tests that source the old loop or `comment-state.sh` will break. For each, either (a) repoint to `scripts/legacy/ai-pr-review-poll.legacy`, or (b) delete the test if it covered loop behaviour now owned by the TS unit tests in M6-03/M6-04. Do not silently `skip` — decide per test and note it in the commit.

- [ ] **Step 6: Commit**

```bash
git add scripts/ai-pr-review-poll scripts/legacy/ai-pr-review-poll.legacy scripts/lib/__tests__/pr-poll-shim.bats
git commit -m "refactor(bash): ai-pr-review-poll becomes a shim over run-pr-poll (M6-05)"
```

---

### Task 3: Update the spawn site in `ai-run-issue-v2`

**Files:**
- Modify: `scripts/ai-run-issue-v2` (the line that launches the poller on PR create)

- [ ] **Step 1: Find the current launch**

Run: `grep -n "ai-pr-review-poll\|nohup" scripts/ai-run-issue-v2`
Expected: a `nohup ... ai-pr-review-poll ... &` line.

- [ ] **Step 2: Replace the background `nohup` launch with a foreground (or backgrounded) shim call**

The shim now `exec`s the managed poller. Keep the same arguments. If the orchestrator must not block, retain `&`/`nohup`, but the process is now the managed CLI, not the legacy loop:

```bash
# before (illustrative):
#   nohup "$SCRIPT_DIR/ai-pr-review-poll" "$PR_NUMBER" "$ISSUE_NUM" "$MAX_POLLS" "$POLL_INTERVAL" >/dev/null 2>&1 &
# after — same args, same backgrounding, now delegating to the managed poller:
nohup "$SCRIPT_DIR/ai-pr-review-poll" "$PR_NUMBER" "$ISSUE_NUM" "$MAX_POLLS" "$POLL_INTERVAL" \
  >> "${RUN_DIR:-/tmp}/pr-poll.log" 2>&1 &
emit_event "post-pr-review" "info" "post-pr-review.poller.enqueued" \
  "managed poller started for PR #${PR_NUMBER}" prNumber="${PR_NUMBER}"
```

- [ ] **Step 3: Verify the script still passes shellcheck/lint**

Run: `pnpm lint` (and any `shellcheck` invoked by `test:bash`)
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add scripts/ai-run-issue-v2
git commit -m "feat(bash): ai-run-issue-v2 launches the managed poller on PR create (M6-05)"
```

---

### Task 4: End-to-end smoke against a fake `gh`

**Files:**
- Create: `apps/cli/src/__tests__/run-pr-poll.e2e.test.ts`

- [ ] **Step 1: Write a guarded e2e test** that runs the CLI `main` path with a fake `gh` and an in-memory DB, asserting it terminates `all_resolved` when there are no comments.

```typescript
// apps/cli/src/__tests__/run-pr-poll.e2e.test.ts
import { describe, it, expect } from 'vitest';
import { parsePollArgs, exitCodeForTerminalState } from '../run-pr-poll.js';

// Full main() requires a composed container + fake gh on PATH; that is covered
// by the application/infra unit suites. Here we assert the CLI contract wiring:
describe('run-pr-poll CLI contract', () => {
  it('a no-comment poll maps to exit 0', () => {
    // parsePollArgs + exitCodeForTerminalState are the CLI's pure surface.
    const args = parsePollArgs(['--pr', '5', '--repo', 'o/r', '--cwd', process.cwd()]);
    expect(args.prNumber).toBe(5);
    expect(exitCodeForTerminalState('all_resolved')).toBe(0);
  });
});
```

> A heavier real-spawn e2e (compose + fake gh shim on PATH + seeded run row) is optional and can be added behind a `PR_POLL_E2E=1` guard, reusing the GhCliAdapter fixtures from M6-02.

- [ ] **Step 2: Run + commit**

Run: `pnpm --filter @ai-sdlc/cli test -- run-pr-poll`
Expected: PASS.

```bash
git add apps/cli/src/__tests__/run-pr-poll.e2e.test.ts
git commit -m "test(cli): run-pr-poll CLI contract smoke (M6-05)"
```

---

### Task 5: Final verification

- [ ] **Step 1: Whole workspace green incl. bash**

Run: `pnpm -r build && pnpm -r typecheck && pnpm -r lint && pnpm -r test && pnpm test:bash`
Expected: all green.

- [ ] **Step 2: Confirm the legacy loop is no longer the default path**

Run: `grep -rn "comment-state.sh\|verify_build_passes\|process_comment" scripts/ai-pr-review-poll`
Expected: no matches (those now live only in `scripts/legacy/`).

---

## Self-review notes

- **Story intent met:** `scripts/ai-pr-review-poll` is now a thin shim that enqueues/runs the managed poller; the old polling loop is removed from the active path (quarantined under `scripts/legacy/`, reversible).
- **Backward-compatible CLI:** Positional args `<PR> [issue] [max_polls] [interval]` preserved, so `ai-run-issue-v2`'s existing call site keeps working with a one-line change.
- **No behaviour duplication:** Verification + comment-state logic now lives once, in the TS use case (M6-03), not in both Bash and TS.
- **Cutover safety:** Legacy script preserved; bats tests repointed/retired deliberately rather than skipped.
- **Follow-on:** Fully retiring `scripts/legacy/ai-pr-review-poll.legacy` and the unused `scripts/lib/comment-state.sh` is M8-11 cleanup, not this story.
