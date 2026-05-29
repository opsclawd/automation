# M5-05: Bash Script Calls Node Validator — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the brittle log-grep `validate` block in `scripts/ai-run-issue-v2` with a call to a new `apps/cli/src/run-validation.ts` CLI that runs the configured validation suite through the M5-02/M5-03 TypeScript pipeline (structured results + `validation-result.json` + a typed `Failure`), while preserving the legacy `validation.result` / `validate.log` files that downstream Bash phases still read.

**Architecture:** A thin CLI (mirrors `apps/cli/src/run-agent.ts`) composes the container, loads `validation.commands`, resolves the run's directory, calls `c.runValidation.execute(...)`, prints a per-command summary, and exits `0` (pass) / `1` (fail), reserving `2` (config) / `3` (unexpected). The Bash phase pipes the CLI through `tee` to keep `validate.log`, derives `validation.result` from the exit code (via a small sourceable helper for testability), and leaves the phase-transition flow untouched.

**Tech Stack:** TypeScript CLI via `tsx` (no build step), Bash, Vitest, bats.

---

## Background the engineer needs

- **Depends on M5-01/M5-02/M5-03** (merged): `c.runValidation` is on the `Container` and, on execution, runs commands, persists a `ValidationRun`, writes `validation-result.json`, and inserts a `validation_failed`/`timeout` `Failure` when it fails.
- **CLI pattern to copy:** `apps/cli/src/run-agent.ts` — `parseArgs`, exported pure helpers (`validateRequiredFlags`, `exitCodeForOutcome`), `findRepoRoot`, `composeRoot({ ..., runStartupSweeps: false })`, and the `if (!process.env.VITEST) void main();` guard so tests can import helpers without auto-running. **`runStartupSweeps: false` is mandatory** — composing inside a child process otherwise deletes tmp dirs out from under running work (issue #107).
- **Run-directory facts:** the run's artifacts live at `<runsDir>/<displayId>/`. `c.runsDir` defaults to `<repoRoot>/.ai-runs`. The artifact browser/UI serve files from there, so validation logs must be written under `<runsDir>/<displayId>/validate/`. The CLI resolves `displayId` from the DB via `c.runRepository.findByUuid(runId)`.
- **Bash variables** (already defined in `scripts/ai-run-issue-v2`): `REPO_ROOT` (line 34), `RUN_ID` (55), `REPO_ID` (56), `WORKTREE_DIR` (69), `ISSUES_DIR` = `WORKTREE_DIR` (70), `_TSX_LOADER`. The current validate block is **lines ~1826–1893**; it ends by writing `validation.result` and setting `PHASE="whole-pr-review"`.
- **Downstream readers of `validation.result`** (must keep working): resume detection (~2500), create-pr (~2605), archiving (~2636), and the revalidate step inside the fix loop (~2171). **Do not change the phase flow or these readers** — only swap how the validate suite executes.
- **Existing call shape** (copy from the `whole-pr-review` phase, ~line 1936): `node --import "$_TSX_LOADER" "$REPO_ROOT/apps/cli/src/run-agent.ts" --cwd "$WORKTREE_DIR" --run-id "$RUN_ID" --repo-id "$REPO_ID" --repo-root "$REPO_ROOT" ...` with `NODE_OPTIONS='--conditions=development'` and `PIPESTATUS` capture after `tee`.
- **Bash helpers + bats:** sourceable helpers live in `scripts/lib/*.sh` and are sourced from the main script (e.g. `source "${REPO_ROOT}/scripts/lib/emit_event.sh"` at line 80). bats tests live in `scripts/lib/__tests__/*.bats` and run via `pnpm test:bash` (`bats scripts/lib/__tests__`).
- **Run commands:** CLI tests `pnpm vitest run apps/cli/...`; bash `pnpm test:bash`; syntax `bash -n scripts/ai-run-issue-v2`; full `pnpm -r build && pnpm -r typecheck && pnpm test && pnpm lint`.

## File Structure

- **Create** `apps/cli/src/run-validation.ts` — the CLI (pure helpers + `main`).
- **Create** `apps/cli/src/__tests__/run-validation.test.ts` — unit tests for the pure helpers.
- **Create** `apps/cli/src/__tests__/run-validation-integration.test.ts` — end-to-end via `composeRoot` against a temp repo.
- **Create** `scripts/lib/validation_result.sh` — `validation_result_from_exit` helper.
- **Create** `scripts/lib/__tests__/validation_result.bats` — bats test for the helper.
- **Modify** `scripts/ai-run-issue-v2` — source the helper; replace the validate block.

---

## Task 1: CLI pure helpers

**Files:**

- Create: `apps/cli/src/run-validation.ts`
- Test: `apps/cli/src/__tests__/run-validation.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/cli/src/__tests__/run-validation.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { validateRequiredFlags, exitCodeForValidation } from '../run-validation.js';

describe('run-validation CLI helpers', () => {
  describe('validateRequiredFlags', () => {
    it('lists all required flags when none provided', () => {
      expect(validateRequiredFlags({})).toEqual(['--cwd', '--run-id', '--repo-root']);
    });
    it('returns empty when all present', () => {
      expect(validateRequiredFlags({ cwd: '/w', 'run-id': 'u', 'repo-root': '/r' })).toEqual([]);
    });
    it('returns only the missing ones', () => {
      expect(validateRequiredFlags({ cwd: '/w' })).toEqual(['--run-id', '--repo-root']);
    });
  });

  describe('exitCodeForValidation', () => {
    it('returns 0 when passed', () => {
      expect(exitCodeForValidation(true)).toBe(0);
    });
    it('returns 1 when failed', () => {
      expect(exitCodeForValidation(false)).toBe(1);
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run apps/cli/src/__tests__/run-validation.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the CLI**

Create `apps/cli/src/run-validation.ts`:

```ts
#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { composeRoot } from '@ai-sdlc/api/compose.js';
import { RunId, PhaseName } from '@ai-sdlc/domain';
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
  if (!values['repo-root']) missing.push('--repo-root');
  return missing;
}

/** Validation pass/fail maps to a binary exit code the Bash caller branches on. */
export function exitCodeForValidation(passed: boolean): number {
  return passed ? 0 : 1;
}

function findRepoRoot(dir: string): string {
  let current = resolve(dir);
  for (let i = 0; i < 20; i++) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  console.error('could not find repo root (no pnpm-workspace.yaml found)');
  process.exit(2);
}

/**
 * run-validation CLI
 *
 * Exit codes:
 *   0 — validation passed
 *   1 — validation failed (>=1 command failed/timed out)
 *   2 — config error (missing flags / no .ai-orchestrator.json)
 *   3 — unexpected error
 *
 * Usage (from Bash):
 *   NODE_OPTIONS='--conditions=development' node --import "$_TSX_LOADER" \
 *     apps/cli/src/run-validation.ts \
 *     --cwd <worktree> --run-id <uuid> --repo-id <owner/repo> \
 *     --repo-root <canonical-repo-root> --phase-id validate
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

  const repoRoot = values['repo-root'] ?? findRepoRoot(values.cwd!);

  let config;
  try {
    config = loadConfig(repoRoot);
  } catch (err) {
    if (err instanceof ConfigError && (err.cause as { code?: string })?.code === 'ENOENT') {
      console.error('no .ai-orchestrator.json found at repo root');
      process.exit(2);
    }
    throw err;
  }

  const c = composeRoot({ repoRoot, scriptPath: '/dev/null', runStartupSweeps: false });

  const runId = values['run-id']!;
  const phaseId = values['phase-id'] ?? 'validate';
  const displayId = c.runRepository.findByUuid(runId)?.displayId ?? runId;
  const logDir = join(c.runsDir, displayId, 'validate');

  try {
    const { validationRun, passed } = await c.runValidation.execute({
      runId: RunId(runId),
      phaseId: PhaseName(phaseId),
      cwd: values.cwd!,
      logDir,
      commands: config.validation.commands,
      timeoutSeconds: config.validation.timeout,
    });

    for (const cmd of validationRun.commands) {
      console.log(`[${cmd.outcome}] ${cmd.command} (${cmd.durationMs}ms, exit ${cmd.exitCode})`);
    }
    console.log(passed ? 'validation: PASSED' : 'validation: FAILED');
    process.exit(exitCodeForValidation(passed));
  } catch (e) {
    if (e instanceof Error && /no validation commands/i.test(e.message)) {
      console.error(e.message);
      process.exit(2);
    }
    console.error(e);
    process.exit(3);
  }
}

if (!process.env.VITEST) {
  void main();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run apps/cli/src/__tests__/run-validation.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/run-validation.ts apps/cli/src/__tests__/run-validation.test.ts
git commit -m "feat(cli): run-validation CLI helpers (M5-05)"
```

---

## Task 2: CLI integration test (end-to-end via composeRoot)

**Files:**

- Test: `apps/cli/src/__tests__/run-validation-integration.test.ts`

This exercises the full pipeline (adapter → use case → repo → failure) without spawning a subprocess, mirroring `run-agent-integration.test.ts` (which imports `composeRoot` directly).

- [ ] **Step 1: Write the test**

Create `apps/cli/src/__tests__/run-validation-integration.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RunId, PhaseName } from '@ai-sdlc/domain';

describe('run-validation integration', () => {
  let repoRoot: string;
  let runsDir: string;

  const baseConfig = {
    phases: { skip: [], reviewFix: { maxIterations: 10 }, implement: { maxIterations: 5 } },
    timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
  };

  beforeAll(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'run-val-int-'));
    writeFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'packages: []\n');
    runsDir = join(repoRoot, '.ai-runs');
  });

  afterAll(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  async function compose(commands: string[]) {
    writeFileSync(
      join(repoRoot, '.ai-orchestrator.json'),
      JSON.stringify({ ...baseConfig, validation: { commands, timeout: 30 } }, null, 2),
    );
    const { composeRoot } = await import('@ai-sdlc/api/compose.js');
    return composeRoot({
      repoRoot,
      scriptPath: '/dev/null',
      runsDir,
      dbPath: ':memory:',
      runStartupSweeps: false,
    });
  }

  it('passes and persists a ValidationRun when all commands succeed', async () => {
    const c = await compose(['exit 0', 'echo hi']);
    const runUuid = '00000000-0000-0000-0000-0000000000c1';
    c.runRepository.insertIfNoActive({
      uuid: runUuid,
      displayId: 'run-c1',
      issueNumber: 1,
      type: 'issue',
      status: 'running',
      completedPhases: [],
      startedAt: new Date(),
    } as never);

    const out = await c.runValidation.execute({
      runId: RunId(runUuid),
      phaseId: PhaseName('validate'),
      cwd: repoRoot,
      logDir: join(runsDir, 'run-c1', 'validate'),
      commands: ['exit 0', 'echo hi'],
      timeoutSeconds: 30,
    });

    expect(out.passed).toBe(true);
    expect(c.validationRunRepository.listByRun(RunId(runUuid))).toHaveLength(1);
    expect(existsSync(join(runsDir, 'run-c1', 'validate', 'validation-result.json'))).toBe(true);
  });

  it('fails and records a Failure when a command fails', async () => {
    const c = await compose(['exit 0', 'exit 7']);
    const runUuid = '00000000-0000-0000-0000-0000000000c2';
    c.runRepository.insertIfNoActive({
      uuid: runUuid,
      displayId: 'run-c2',
      issueNumber: 2,
      type: 'issue',
      status: 'running',
      completedPhases: [],
      startedAt: new Date(),
    } as never);

    const out = await c.runValidation.execute({
      runId: RunId(runUuid),
      phaseId: PhaseName('validate'),
      cwd: repoRoot,
      logDir: join(runsDir, 'run-c2', 'validate'),
      commands: ['exit 0', 'exit 7'],
      timeoutSeconds: 30,
    });

    expect(out.passed).toBe(false);
    const failure = c.failureRepository.findLatestByRun(runUuid);
    expect(failure?.kind).toBe('validation_failed');
  });
});
```

- [ ] **Step 2: Run it**

Run: `pnpm vitest run apps/cli/src/__tests__/run-validation-integration.test.ts`
Expected: PASS (2 tests).

> If `insertIfNoActive`'s exact field shape differs, copy the seeding pattern verbatim from `apps/api/src/__tests__/invocations-api.test.ts` (it seeds a run the same way).

- [ ] **Step 3: Commit**

```bash
git add apps/cli/src/__tests__/run-validation-integration.test.ts
git commit -m "test(cli): run-validation end-to-end integration (M5-05)"
```

---

## Task 3: Bash exit→result helper + bats test

**Files:**

- Create: `scripts/lib/validation_result.sh`
- Test: `scripts/lib/__tests__/validation_result.bats`

- [ ] **Step 1: Write the failing bats test**

Create `scripts/lib/__tests__/validation_result.bats`:

```bash
#!/usr/bin/env bats

setup() {
  source "${BATS_TEST_DIRNAME}/../validation_result.sh"
}

@test "validation_result_from_exit: 0 -> passed" {
  run validation_result_from_exit 0
  [ "$status" -eq 0 ]
  [ "$output" = "passed" ]
}

@test "validation_result_from_exit: 1 -> failed" {
  run validation_result_from_exit 1
  [ "$output" = "failed" ]
}

@test "validation_result_from_exit: 2 (config error) -> failed" {
  run validation_result_from_exit 2
  [ "$output" = "failed" ]
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test:bash`
Expected: FAIL — `validation_result.sh` not found.

- [ ] **Step 3: Implement the helper**

Create `scripts/lib/validation_result.sh`:

```bash
#!/usr/bin/env bash
# Maps a validation CLI exit code to the legacy validation.result token.
# 0 => "passed"; any non-zero (failure, config error, unexpected) => "failed".

validation_result_from_exit() {
  if [[ "${1:-1}" -eq 0 ]]; then
    echo "passed"
  else
    echo "failed"
  fi
}
```

- [ ] **Step 4: Run the bats test to verify it passes**

Run: `pnpm test:bash`
Expected: PASS (including the 3 new tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/validation_result.sh scripts/lib/__tests__/validation_result.bats
git commit -m "feat(bash): validation_result_from_exit helper (M5-05)"
```

---

## Task 4: Replace the Bash validate block

**Files:**

- Modify: `scripts/ai-run-issue-v2`

- [ ] **Step 1: Source the new helper**

In `scripts/ai-run-issue-v2`, directly below the existing `source "${REPO_ROOT}/scripts/lib/emit_event.sh"` (line ~80), add:

```bash
# shellcheck source=lib/validation_result.sh
source "${REPO_ROOT}/scripts/lib/validation_result.sh"
```

- [ ] **Step 2: Replace the command-execution portion of the validate block**

Find the validate phase block (`if [[ "$PHASE" == "validate" ]]; then`, ~line 1828). Replace **everything from** the `log "Running pnpm build && ..."` line **through** the `grep -qE "\[build failed\]..." ... && VALIDATE_EXIT=1` line with the following. Keep the surrounding `_emit_phase_started`, `emit_event "...command.started"`, `ensure_worktree`, and the trailing `validation.result` / `_emit_phase_done` / `PHASE="whole-pr-review"` logic intact (see Step 3 for the result write).

Replace with:

```bash
  log "Running validation suite via run-validation.ts ..."
  cd "${WORKTREE_DIR}"
  ensure_branch
  mkdir -p "${ISSUES_DIR}"

  # Dependencies must be installed before the configured validation commands run.
  timeout 120 pnpm install --frozen-lockfile 2>&1 | tail -5 || echo "[install completed with warnings]"

  NODE_OPTIONS='--conditions=development' node --import "$_TSX_LOADER" \
    "$REPO_ROOT/apps/cli/src/run-validation.ts" \
    --cwd "$WORKTREE_DIR" \
    --run-id "$RUN_ID" \
    --repo-id "$REPO_ID" \
    --repo-root "$REPO_ROOT" \
    --phase-id validate \
    2>&1 | tee "${ISSUES_DIR}/validate.log"
  VALIDATE_EXIT=${PIPESTATUS[0]}
```

> The old sentinel-grep (`grep -qE "\[build failed\]..."`) is deleted entirely. Pass/fail now comes solely from the CLI exit code. Exit codes 2 (config) and 3 (unexpected) are non-zero and therefore treated as failure by the existing `[[ $VALIDATE_EXIT -ne 0 ]]` checks.

- [ ] **Step 3: Use the helper to write `validation.result`**

In the same block, the existing code writes `validation.result` inside an `if [[ $VALIDATE_EXIT -ne 0 ]]; ... else ... fi`. Replace the two `echo "failed"/"passed" > "${ISSUES_DIR}/validation.result"` lines so the token comes from the helper, while keeping the warn/info + event emission. The block should read:

```bash
  cp "${ISSUES_DIR}/validate.log" "${ISSUES_DIR}/validation.md"
  _emit_artifact "validate" "${ISSUES_DIR}/validation.md" "validation"

  _validate_now=$(_now_ms)
  _VALIDATE_DUR=$(( _validate_now - _VALIDATE_START_MS ))

  validation_result_from_exit "$VALIDATE_EXIT" > "${ISSUES_DIR}/validation.result"

  if [[ $VALIDATE_EXIT -eq 0 ]]; then
    emit_event "validate" "info" "command.completed" "validate suite passed" \
      command="pnpm-validate-suite" exitCode=0 durationMs="$_VALIDATE_DUR"
    info "Validation passed"
  else
    emit_event "validate" "error" "command.failed" "validate suite failed" \
      command="pnpm-validate-suite" exitCode="$VALIDATE_EXIT" durationMs="$_VALIDATE_DUR"
    warn "Validation had failures (check validation.md / .ai-runs/<run>/validate/ for details)"
  fi

  _emit_phase_done "validate"
  PHASE="whole-pr-review"
```

> Confirm `_VALIDATE_START_MS` is still set earlier in the block (it is, just after `_emit_phase_started`). Do not remove it.

- [ ] **Step 4: Syntax-check the script**

Run: `bash -n scripts/ai-run-issue-v2`
Expected: no output (valid syntax).

- [ ] **Step 5: Lint the shell (if shellcheck is available)**

Run: `shellcheck -x scripts/ai-run-issue-v2 || echo "shellcheck not installed — skipping"`
Expected: no new errors introduced by this block (pre-existing warnings elsewhere are out of scope).

- [ ] **Step 6: Run the bash suite**

Run: `pnpm test:bash`
Expected: PASS (existing tests unaffected; the script still sources cleanly).

- [ ] **Step 7: Commit**

```bash
git add scripts/ai-run-issue-v2
git commit -m "feat(bash): validate phase delegates to run-validation.ts (M5-05)"
```

---

## Task 5: Full verification

- [ ] **Step 1: Run everything**

Run: `pnpm -r build && pnpm -r typecheck && pnpm test && pnpm test:bash && pnpm lint && pnpm depcruise`
Expected: all green.

- [ ] **Step 2: Confirm no sentinel grep remains**

Run: `grep -n 'build failed\]' scripts/ai-run-issue-v2 || echo "no sentinel grep remaining (good)"`
Expected: prints the "no sentinel grep remaining" message.

- [ ] **Step 3 (optional): real run smoke**

If you can run a real issue end-to-end, confirm: the `validate` phase produces `<repoRoot>/.ai-runs/<displayId>/validate/validation-result.json` + per-command logs, a `validation_runs` row exists in SQLite, `${WORKTREE_DIR}/validation.result` still contains `passed`/`failed`, and the run proceeds into `whole-pr-review` exactly as before.

---

## Self-review checklist (run before handoff)

- [ ] Spec coverage: CLI exists w/ `runStartupSweeps:false` + 0/1/2/3 exit codes ✔ (Task 1); structured `ValidationRun` + `validation-result.json` + per-command logs produced ✔ (Task 2); sentinel grep deleted, pass/fail from exit code ✔ (Task 4 + Task 5 Step 2); `validation.result` + `validate.log` preserved for downstream readers ✔ (Task 4 Step 3); phase flow unchanged (`PHASE="whole-pr-review"`) so the review/fix loop still triggers ✔ (Task 4); bash test for the exit→result mapping ✔ (Task 3).
- [ ] Type/name consistency: `run-validation.ts` flag names (`--cwd`/`--run-id`/`--repo-root`/`--repo-id`/`--phase-id`) match the Bash invocation and `validateRequiredFlags`; `c.runValidation.execute(...)` argument shape matches the M5-02 `RunValidationInputUC`.
- [ ] No placeholders.
- [ ] Did not touch `validation.result` readers (~2500/2605/2636/2171) or the phase sequence.

## Out of scope (do NOT implement here)

- Full TS rewrite of the validate phase control flow / worker-driven execution (M8).
- Removing the legacy infra `validation_failed` regex (kept as fallback in M5-03).
- Routing validation-fix through `AgentPort` (M7).
- Removing `pnpm install` from the worktree prep (still required so commands have deps).
