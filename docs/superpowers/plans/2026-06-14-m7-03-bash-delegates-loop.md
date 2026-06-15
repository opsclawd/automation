# M7-03: Bash Review/Fix Phases Delegate to the Node Loop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `apps/cli/src/run-review-fix.ts` entry point that drives the M7-02 `ReviewFixLoop`, and make `scripts/ai-run-issue-v2` call it for the review/fix iteration instead of its hand-rolled Bash loop — while preserving the script's existing hardening and keeping its outer phase control flow.

**Architecture:** A thin Node CLI (modelled exactly on `apps/cli/src/run-validation.ts`) parses flags, loads config, composes the container, resolves the review/fix profiles from `agent.phaseProfiles`, runs `reviewFixLoop.execute(...)`, and maps the phase outcome to an exit code the Bash script branches on. Bash keeps phase boundaries, labels, stash/revert safety, and reviewer-retry hardening.

**Tech Stack:** TypeScript (strict), Vitest, Bash + bats. Depends on **#336 (M7-02)**. GitHub issue: **#337**.

---

## Background the engineer must know

- **Template CLI:** `apps/cli/src/run-validation.ts` — copy its structure verbatim (flag parsing, `ConfigError`/ENOENT → exit 2, `composeRoot({ runStartupSweeps: false })`, the synthetic-run guard, the `if (!process.env.VITEST) void main();` footer). Also read `apps/cli/src/run-agent.ts` for profile resolution (`resolveProfileName`, `config.agent.phaseProfiles`).
- **`runStartupSweeps: false` is mandatory** (issue #107): composing inside a child process must not sweep tmp dirs out from under running work.
- **Phase-name reality:** the script has **no `review` phase**. The relevant phases are `whole-pr-review`, `review-triage`, and `fix-review` (see `for p in ... whole-pr-review review-triage fix-review ...` in `scripts/ai-run-issue-v2`). **Do not rename anything** — the `review-fix` collapse is M8-06.
- **⚠️ The Bash loop is far more elaborate than the milestone doc implies.** It sources and depends on real hardening you must NOT silently drop:
  - `scripts/lib/review-manifest-helpers.sh`, `scripts/lib/fix-review-stash.sh`, `scripts/lib/fix-review-revert.sh`, `scripts/lib/plan-review.sh`, `scripts/lib/review-contract.sh`
  - `_append_loop_history`, `_detect_loop_stall`, `rerun_reviewer_with_retry`, `validate_review_artifacts`, the architect pass (`FIX_REVIEW_ARCHITECT_ENABLED`).
  - See issue #210 (parity audit) and the repo rule "never cherry-pick parity behaviour from an open branch" (commit #332). **Preserve behaviour in place.** If a hardening behaviour cannot be moved into the Node loop without regression, leave it in Bash and list it as a follow-up checkbox in the PR — do not remove it.
- **Config keys:** `config.phases.reviewFix.maxIterations` (iteration budget), `config.agent.phaseProfiles['whole-pr-review'|'fix-review']` (profiles + optional `fallbackProfile`). Confirm shapes against `packages/shared` (the config schema) and the sample `.ai-orchestrator.json`.
- **`_TSX_LOADER` invocation:** the script already runs Node CLIs (`run-agent.ts`, `run-validation`) via a `node --import "$_TSX_LOADER" ...` pattern. Grep the script for the existing invocation and reuse it verbatim for `run-review-fix.ts`.
- **Run commands from repo root** `/home/gary/.openclaw/workspace/automation`. Bash tests: `pnpm test:bash`.

## File Structure

| File | Responsibility |
|------|----------------|
| `apps/cli/src/run-review-fix.ts` (create) | CLI entry: flags → config → loop → exit code. |
| `apps/cli/src/__tests__/run-review-fix.test.ts` (create) | Unit tests for flag validation + exit-code mapping. |
| `apps/cli/src/__tests__/run-review-fix-integration.test.ts` (create) | End-to-end CLI against fake agent/validation shims. |
| `scripts/ai-run-issue-v2` (modify) | Replace inner review/fix iteration with the CLI call; keep outer flow + hardening. |

---

## Task 1: `run-review-fix` CLI — pure helpers (TDD)

**Files:**
- Create: `apps/cli/src/run-review-fix.ts`
- Test: `apps/cli/src/__tests__/run-review-fix.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/cli/src/__tests__/run-review-fix.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { validateRequiredFlags, exitCodeForPhaseOutcome } from '../run-review-fix.js';

describe('validateRequiredFlags', () => {
  it('lists every missing required flag', () => {
    expect(validateRequiredFlags({})).toEqual(['--cwd', '--run-id', '--repo-id', '--repo-root']);
  });
  it('returns empty when all present', () => {
    expect(
      validateRequiredFlags({
        cwd: '/wt',
        'run-id': 'r1',
        'repo-id': 'o/r',
        'repo-root': '/repo',
      }),
    ).toEqual([]);
  });
});

describe('exitCodeForPhaseOutcome', () => {
  it('passed → 0', () => expect(exitCodeForPhaseOutcome('passed')).toBe(0));
  it('failed → 1', () => expect(exitCodeForPhaseOutcome('failed')).toBe(1));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @ai-sdlc/cli test -- run-review-fix.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the CLI**

Create `apps/cli/src/run-review-fix.ts`:

```ts
#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { composeRoot } from '@ai-sdlc/api/compose.js';
import { RunId, PhaseName, AgentProfileName, createRun } from '@ai-sdlc/domain';
import { ConfigError, loadConfig } from '@ai-sdlc/shared';

interface Flags {
  cwd?: string;
  'run-id'?: string;
  'repo-id'?: string;
  'repo-root'?: string;
  'phase-id'?: string;
}

export function validateRequiredFlags(values: Flags): string[] {
  const missing: string[] = [];
  if (!values.cwd) missing.push('--cwd');
  if (!values['run-id']) missing.push('--run-id');
  if (!values['repo-id']) missing.push('--repo-id');
  if (!values['repo-root']) missing.push('--repo-root');
  return missing;
}

export function exitCodeForPhaseOutcome(outcome: 'passed' | 'failed'): number {
  return outcome === 'passed' ? 0 : 1;
}

/**
 * run-review-fix CLI
 *
 * Exit codes:
 *   0 — review/fix loop converged (phase passed)
 *   1 — loop exhausted or hard-failed (phase failed)
 *   2 — config error (missing flags / no .ai-orchestrator.json / no agent config)
 *   3 — unexpected error
 *
 * Usage (from Bash):
 *   node --import "$_TSX_LOADER" apps/cli/src/run-review-fix.ts \
 *     --cwd <worktree> --run-id <uuid> --repo-id <owner/repo> \
 *     --repo-root <canonical-repo-root> --phase-id whole-pr-review
 *
 * runStartupSweeps:false is mandatory (issue #107).
 */
async function main() {
  const { values } = parseArgs({
    options: {
      cwd: { type: 'string' },
      'run-id': { type: 'string' },
      'repo-id': { type: 'string' },
      'repo-root': { type: 'string' },
      'phase-id': { type: 'string' },
    },
    allowPositionals: false,
  }) as { values: Flags };

  const missing = validateRequiredFlags(values);
  if (missing.length > 0) {
    console.error(`missing required flag(s): ${missing.join(', ')}`);
    process.exit(2);
  }

  const repoRoot = values['repo-root']!;

  let config;
  try {
    config = loadConfig(repoRoot);
  } catch (err) {
    if (err instanceof ConfigError && (err.cause as { code?: string })?.code === 'ENOENT') {
      console.error('no .ai-orchestrator.json found at repo root');
      process.exit(2);
    }
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(2);
    }
    console.error(err);
    process.exit(3);
  }

  if (!config.agent) {
    console.error('no agent config in .ai-orchestrator.json');
    process.exit(2);
  }

  const reviewEntry = config.agent.phaseProfiles['whole-pr-review'];
  const fixEntry = config.agent.phaseProfiles['fix-review'];
  if (!reviewEntry?.profile || !fixEntry?.profile) {
    console.error('agent.phaseProfiles must define whole-pr-review and fix-review');
    process.exit(2);
  }

  let c;
  try {
    c = composeRoot({ repoRoot, scriptPath: '/dev/null', runStartupSweeps: false });
  } catch (err) {
    console.error(err);
    process.exit(3);
  }

  if (!c.reviewFixLoop) {
    console.error('review/fix loop not configured (agent runtime missing)');
    process.exit(2);
  }

  const runId = values['run-id']!;
  if (!c.runRepository.findByUuid(runId)) {
    // Synthetic-run guard (mirror run-validation.ts): satisfy the loops FK.
    c.runRepository.insert(
      createRun({ uuid: runId, displayId: runId, issueNumber: 0, startedAt: new Date() }),
    );
  }

  const phaseId = values['phase-id'] ?? 'whole-pr-review';

  try {
    const { phaseOutcome, loop } = await c.reviewFixLoop.execute({
      runId: RunId(runId),
      phaseId: PhaseName(phaseId),
      repoId: values['repo-id']!,
      cwd: values.cwd!,
      maxIterations: config.phases.reviewFix.maxIterations,
      reviewProfile: AgentProfileName(reviewEntry.profile),
      fixProfile: AgentProfileName(fixEntry.profile),
      ...(fixEntry.fallbackProfile
        ? { fixFallbackProfile: AgentProfileName(fixEntry.fallbackProfile) }
        : {}),
    });
    // eslint-disable-next-line no-console
    console.log(
      `review-fix: ${phaseOutcome.toUpperCase()} (${loop.iterations.length}/${loop.maxIterations} iterations, status=${loop.status})`,
    );
    process.exit(exitCodeForPhaseOutcome(phaseOutcome));
  } catch (e) {
    console.error(e);
    process.exit(3);
  }
}

if (!process.env.VITEST) {
  void main();
}
```

> If `config.phases.reviewFix.maxIterations` is typed differently (e.g. optional) in `packages/shared`, read the schema and use the correct accessor; default to the sample config's value only if the schema guarantees presence.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @ai-sdlc/cli test -- run-review-fix.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/run-review-fix.ts apps/cli/src/__tests__/run-review-fix.test.ts
git commit -m "feat(cli): run-review-fix entry point (M7-03, #337)"
```

---

## Task 2: CLI integration test (fake agent + validation shims)

**Files:**
- Test: `apps/cli/src/__tests__/run-review-fix-integration.test.ts`

This drives the real CLI (via a child process or by importing `main` with a fixture repo) against fake agent shim scripts that write `result.json`, proving the loop persists `loops`/`loop_iterations` and the exit code maps correctly.

- [ ] **Step 1: Study the template**

Read `apps/cli/src/__tests__/run-validation-integration.test.ts` and `apps/cli/src/__tests__/run-agent-integration.test.ts`. Note how they: create a temp repo, write `.ai-orchestrator.json`, point agent profiles at fake shim scripts (the `fake-opencode-success.sh` family in `packages/infrastructure/src/agent/__fixtures__/`), run the CLI through `tsx`, and assert on the SQLite DB.

- [ ] **Step 2: Write the integration test**

Create `apps/cli/src/__tests__/run-review-fix-integration.test.ts`. Structure (fill in exact helpers from the template files):

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '@ai-sdlc/infrastructure';

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// Writes a fake agent shim that drops a result.json with the given verdict and
// the loop's expected artifacts into --cwd, then exits 0. Returns its path.
function writeReviewShim(path: string, verdict: 'pass' | 'fail') {
  /* write a small bash script that: parses --cwd (or $PWD), writes result.json
     = {"result":"<verdict>","findings":[]}, prints to stdout, exit 0. chmod +x. */
}

function writeConfig(repoRoot: string, reviewShim: string, fixShim: string) {
  /* write .ai-orchestrator.json with:
       validation.commands = ["true"], validation.timeout = 60,
       phases.reviewFix.maxIterations = 2,
       agent.profiles = { rev: {runtime:'opencode',...}, fix: {...} },
       agent.phaseProfiles = { 'whole-pr-review':{profile:'rev'}, 'fix-review':{profile:'fix'}, validate:{profile:'fix'} },
     and set the runtime adapter command to the shim via the same env/config the
     OpenCode adapter reads (see compose-agent.test.ts / opencode-adapter test for
     how the adapter binary is overridden in tests). */
}

describe('run-review-fix integration', () => {
  it('exits 0 and persists a converged loop when review passes', () => {
    // setup temp repo (git init), config with review shim returning 'pass'
    // run: tsx apps/cli/src/run-review-fix.ts --cwd <wt> --run-id r1 --repo-id o/r --repo-root <root> --phase-id whole-pr-review
    // expect exit 0; query loops table → 1 row, status 'converged'.
  });

  it('exits 1 and persists an exhausted loop when review never passes', () => {
    // review shim always returns 'fail', maxIterations 2
    // expect exit 1; loops row status 'exhausted', 2 loop_iterations rows.
  });
});
```

> **Important:** the exact mechanism for pointing the runtime adapter at a shim binary is established in the existing agent adapter tests (`packages/infrastructure/src/agent/__tests__/` and `apps/api/src/__tests__/compose-agent.test.ts`). Reuse that mechanism rather than inventing a new one. If wiring a full real-router integration proves heavy, it is acceptable to assert the loop behaviour at the `reviewFixLoop.execute(...)` level using the container built by `composeRoot` with the shim-backed adapter — still a true integration of CLI config → loop → DB.

- [ ] **Step 3: Run the integration test**

Run: `pnpm --filter @ai-sdlc/cli test -- run-review-fix-integration.test.ts`
Expected: PASS (both cases).

- [ ] **Step 4: Commit**

```bash
git add apps/cli/src/__tests__/run-review-fix-integration.test.ts
git commit -m "test(cli): run-review-fix integration (converge + exhaust) (M7-03, #337)"
```

---

## Task 3: Bash delegates the review/fix iteration

**Files:**
- Modify: `scripts/ai-run-issue-v2`

- [ ] **Step 1: Map the current loop before touching it**

Run: `grep -n "whole-pr-review\|fix-review\|MAX_REVIEW_FIX_ITERATIONS\|_append_loop_history\|_detect_loop_stall\|rerun_reviewer_with_retry" scripts/ai-run-issue-v2`
Read the full block that performs the review → fix → re-review iterations. Write down (in the PR description draft) every hardening behaviour in that block so you can confirm each is either (a) moved into the Node loop or (b) deliberately retained in Bash.

- [ ] **Step 2: Replace the inner iteration with the CLI call**

Inside the existing `whole-pr-review` / `fix-review` phase region, replace the hand-rolled iteration loop body with a single call to the CLI, reusing the script's existing `node --import "$_TSX_LOADER"` invocation pattern (grep for how `run-validation` is invoked and copy it). Keep `enter_phase`/`complete_phase`/`emit_event` boundaries and label updates around it. Sketch:

```bash
# was: a while-loop over review/fix/re-review iterations
enter_phase "whole-pr-review"
if node --import "$_TSX_LOADER" "${REPO_ROOT}/apps/cli/src/run-review-fix.ts" \
     --cwd "$WORKTREE_DIR" \
     --run-id "$RUN_UUID" \
     --repo-id "$REPO_ID" \
     --repo-root "$REPO_ROOT" \
     --phase-id "whole-pr-review"; then
  complete_phase "whole-pr-review"
else
  orchestrator_fail "whole-pr-review" "review/fix loop did not converge"
fi
```

(Use the actual variable names the script already uses for worktree dir, run uuid, repo id, repo root — grep for how `run-validation` is invoked to get them exactly. `orchestrator_fail` is the script's existing failure helper.)

- [ ] **Step 3: Preserve hardening**

Keep these sourced and operative unless you can prove the Node loop fully subsumes them: `fix-review-stash.sh`, `fix-review-revert.sh`, `review-manifest-helpers.sh`, `review-contract.sh`, `rerun_reviewer_with_retry`, `_detect_loop_stall`. If any behaviour is now handled by the Node loop and you remove its Bash counterpart, state exactly which in the PR. If unsure, retain it (it is idempotent/no-op when the work is already done).

- [ ] **Step 4: Run the Bash test suite**

Run: `pnpm test:bash`
Expected: PASS. If a bats test asserts on the old inline loop's log lines, update it to assert on the CLI delegation (do not weaken parity coverage).

- [ ] **Step 5: Manual smoke (optional but recommended)**

Run the script against a stub repo/issue per the project's quickstart and confirm it reaches `create-pr`, and that the run's SQLite DB has `loops` + `agent_invocations` rows for the review/fix work:

Run: `sqlite3 .ai-runs/orchestrator.sqlite 'SELECT phase_id,status FROM loops ORDER BY started_at DESC LIMIT 3;'`
Expected: a `whole-pr-review` loop row with a terminal status.

- [ ] **Step 6: Commit**

```bash
git add scripts/ai-run-issue-v2
git commit -m "feat(bash): delegate review/fix iteration to run-review-fix CLI (M7-03, #337)"
```

---

## Task 4: Full verification

- [ ] **Step 1: Build, test, lint, bash**

Run: `pnpm -r build && pnpm -r test && pnpm -r lint && pnpm test:bash`
Expected: all green.

- [ ] **Step 2: Confirm the old inline loop is gone but helpers remain**

Run: `grep -n "_append_loop_history\|while .*iteration\|run-review-fix" scripts/ai-run-issue-v2`
Expected: the `run-review-fix` call is present; the old per-iteration while-loop body is replaced. Retained hardening helpers may still appear (that is fine and intended).

---

## Self-Review checklist (run before handoff)

- [ ] Issue #337 acceptance mapped: CLI with run-validation conventions + unit tests (T1) ✔; integration test converge→exit0 + exhaust→exit1 with persisted rows (T2) ✔; script delegates + reaches create-pr + writes loops/agent_invocations (T3) ✔; no bats regression, non-delegated hardening listed in PR (T3/T4) ✔; grep confirms old loop replaced + helpers retained (T4) ✔.
- [ ] No phase rename performed (that is M8-06).
- [ ] No placeholders in committed code — the integration-test skeleton's comment blocks must be replaced with real setup before committing Task 2.
- [ ] Flag/exit-code names match M7-02 input (`reviewProfile`/`fixProfile`/`fixFallbackProfile`, `maxIterations`, `phaseOutcome`).
```
