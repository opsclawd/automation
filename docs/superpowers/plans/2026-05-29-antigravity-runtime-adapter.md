# Antigravity (`agy`) Runtime Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an experimental `antigravity` agent runtime (backed by the Google Antigravity CLI `agy`) as a reviewer-only fallback, without disturbing the existing `opencode`/`pi` adapter boundaries.

**Architecture:** Introduce a shared `external-cli-runner.ts` helper that owns all boring process-management concerns (artifact dir, log writing, abort wiring, timeout/cancellation classification, exit mapping, end-commit capture), then add a thin `AntigravityAgentAdapter` that only knows its runtime id, default binary (`agy`), and the verified headless command contract. Wire it through `AgentRuntimeKind`, the config Zod enum, and `composeRoot` (only when an Antigravity profile is configured). This is the **first** of three external-CLI runtimes (#145/#146/#147); it establishes the shared helper that #146 and #147 reuse.

**Tech Stack:** TypeScript (ESM, NodeNext), execa, vitest, Zod, pnpm workspaces.

---

## Verified Runtime Contract (captured 2026-05-29)

These were run on the dev machine from the repo root and are the basis for this plan — do **not** re-derive a different contract:

```
$ agy --version
1.0.3

$ agy --print "Return exactly the two characters: OK"
OK
[exit=0]
```

Relevant `agy --help` flags:

- `--print` (aliases `-p`, `--prompt`) — "Run a single prompt non-interactively and print the response". **This is the headless contract we use.**
- `--print-timeout` — timeout for print mode wait (default `5m0s`).
- `--sandbox` — run with terminal restrictions enabled.
- `--add-dir` — add a directory to the workspace.
- `--dangerously-skip-permissions` — **do NOT use** (reviewer must not auto-approve writes).

**Contract decision:** read the prompt file and pass its contents as the positional prompt argument after `--print`. This is the exact form verified above. Do not implement PTY/TUI automation.

## File Structure

- **Create** `packages/infrastructure/src/agent/external-cli-runner.ts` — shared process runner (used by #145/#146/#147). One responsibility: run a CLI with argv/stdin and produce an `AgentInvocationResult`.
- **Create** `packages/infrastructure/src/agent/antigravity-adapter.ts` — `AntigravityAgentAdapter`; only defines runtime id, default binary, and arg contract.
- **Modify** `packages/domain/src/agent-types.ts` — add `'antigravity'` to `AgentRuntimeKind`.
- **Modify** `packages/shared/src/config/schema.ts:20` — add `'antigravity'` to the `agentRuntime` enum.
- **Modify** `packages/infrastructure/src/agent/index.ts` — export the adapter + runner.
- **Modify** `apps/api/src/compose.ts` (~line 199-213) — register the adapter only when an `antigravity` profile exists.
- **Modify** `.ai-orchestrator.json` — add `antigravity-reviewer` profile + `whole-pr-review` fallback wiring.
- **Create** `packages/infrastructure/src/agent/__fixtures__/fake-agy-success.sh`, `fake-agy-fail.sh`, `fake-agy-slow.sh` — test doubles.
- **Create** `packages/infrastructure/src/agent/__tests__/antigravity-adapter.test.ts` — adapter behavior tests.
- **Create** `packages/infrastructure/src/agent/__tests__/router-antigravity-routing.test.ts` — routing/runtime-identity test.
- **Modify** `packages/shared/src/__tests__/agent-config.test.ts` — assert the enum accepts `antigravity`.

---

### Task 1: Add `antigravity` to the domain runtime kind

**Files:**
- Modify: `packages/domain/src/agent-types.ts:1`

- [ ] **Step 1: Edit the union type**

```typescript
export type AgentRuntimeKind = 'opencode' | 'pi' | 'antigravity';
```

- [ ] **Step 2: Build the domain package to confirm the type compiles**

Run: `pnpm --filter @ai-sdlc/domain build`
Expected: exits 0, no type errors.

- [ ] **Step 3: Commit**

```bash
git add packages/domain/src/agent-types.ts
git commit -m "feat(domain): add 'antigravity' to AgentRuntimeKind"
```

---

### Task 2: Accept `antigravity` in the config schema (TDD)

**Files:**
- Test: `packages/shared/src/__tests__/agent-config.test.ts`
- Modify: `packages/shared/src/config/schema.ts:20`

- [ ] **Step 1: Add a failing test**

Append this `it` block inside the existing `describe('agent config schema', ...)` in `packages/shared/src/__tests__/agent-config.test.ts`:

```typescript
  it('accepts an antigravity runtime profile', () => {
    const cfg = structuredClone(baseValid);
    cfg.agent.profiles['antigravity-reviewer'] = {
      runtime: 'antigravity',
      provider: 'google',
      model: 'default',
      timeoutMinutes: 45,
    } as (typeof cfg.agent.profiles)['opencode-frontier'];
    expect(() => orchestratorConfigSchema.parse(cfg)).not.toThrow();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run packages/shared/src/__tests__/agent-config.test.ts`
Expected: FAIL — Zod rejects `'antigravity'` (`Invalid enum value`).

- [ ] **Step 3: Add `antigravity` to the enum**

In `packages/shared/src/config/schema.ts`, update line 19-20:

```typescript
// Keep in sync with AgentRuntimeKind in @ai-sdlc/application/agent/types.ts
const agentRuntime = z.enum(['opencode', 'pi', 'antigravity']);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run packages/shared/src/__tests__/agent-config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/config/schema.ts packages/shared/src/__tests__/agent-config.test.ts
git commit -m "feat(config): accept 'antigravity' runtime in agent profile schema"
```

---

### Task 3: Create the shared external-CLI runner

This helper is reused by #146 (Claude Code) and #147 (Codex). It mirrors the timeout/cancellation classification in `opencode-adapter.ts` exactly, because the router relies on the `cancelled_by_orchestrator` violation + timeout-signal reclassification (see `agent-runtime-router.ts` "Reclassify cancellation as timeout").

**Files:**
- Create: `packages/infrastructure/src/agent/external-cli-runner.ts`
- Test: `packages/infrastructure/src/agent/__tests__/antigravity-adapter.test.ts` (covers the runner indirectly via the adapter in Task 5)

- [ ] **Step 1: Write the runner**

Create `packages/infrastructure/src/agent/external-cli-runner.ts`:

```typescript
import { execa } from 'execa';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import {
  type AgentInvocationResult,
  type AgentRuntimeKind,
} from '@ai-sdlc/application';

/**
 * Boring process-management for external CLI coding-agent runtimes
 * (antigravity/agy, claude-code/claude, codex). Each runtime adapter builds
 * the verified argv + optional stdin and delegates the rest here:
 * artifact dir creation, log writing, abort wiring, timeout/cancellation
 * classification, exit-code mapping, and end-commit capture.
 */
export interface ExternalCliRunInput {
  /** Runtime identifier recorded on the result row (bakeoff observability). */
  runtime: AgentRuntimeKind;
  /** Resolved binary path or bare command name. */
  bin: string;
  /** Fully-formed argv implementing the verified headless contract. */
  args: string[];
  /** Optional stdin content. Omit to leave stdin closed. */
  input?: string;
  /** Working directory the CLI runs in (the request worktree). */
  cwd: string;
  /** Root dir under which a per-invocation artifact dir is created. */
  artifactsDir: string;
  /** Model string echoed back on the result for observability only. */
  model: string;
  /** Optional hard timeout in ms (adapter-level; router also applies its own). */
  timeoutMsDefault?: number;
  /** Orchestrator abort signal. */
  abortSignal?: AbortSignal;
}

export async function runExternalCli(input: ExternalCliRunInput): Promise<AgentInvocationResult> {
  const invocationDir = join(
    input.artifactsDir,
    `inv-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(invocationDir, { recursive: true });
  const stdoutPath = join(invocationDir, 'stdout.log');
  const stderrPath = join(invocationDir, 'stderr.log');

  const start = Date.now();
  let outcome: AgentInvocationResult['outcome'] = 'success';
  let exitCode = 0;
  let stdout = '';
  let stderr = '';
  let contractViolations: string[] = [];

  try {
    const timeoutSignal =
      input.timeoutMsDefault !== undefined
        ? AbortSignal.timeout(input.timeoutMsDefault)
        : undefined;
    const signals: AbortSignal[] = [];
    if (timeoutSignal) signals.push(timeoutSignal);
    if (input.abortSignal) signals.push(input.abortSignal);
    const cancelSignal =
      signals.length === 1
        ? signals[0]
        : signals.length > 1
          ? AbortSignal.any(signals)
          : undefined;

    const child = execa(input.bin, input.args, {
      cwd: input.cwd,
      reject: false,
      all: false,
      ...(input.input !== undefined ? { input: input.input } : {}),
      ...(cancelSignal ? { cancelSignal } : {}),
    });
    const r = await child;
    stdout = r.stdout ?? '';
    stderr = r.stderr ?? '';
    exitCode = r.exitCode ?? 0;
    if (r.isCanceled) {
      if (timeoutSignal?.aborted && !input.abortSignal?.aborted) {
        outcome = 'timeout';
      } else {
        outcome = 'failed';
        contractViolations = ['cancelled_by_orchestrator'];
      }
    } else if (exitCode !== 0) {
      outcome = 'failed';
    }
  } catch (e) {
    outcome = 'failed';
    exitCode = 1;
    stderr = String((e as Error).message);
  }
  writeFileSync(stdoutPath, stdout);
  writeFileSync(stderrPath, stderr);

  const durationMs = Date.now() - start;
  let endCommitSha: string | undefined;
  try {
    endCommitSha = execSync('git rev-parse HEAD', { cwd: input.cwd }).toString().trim();
  } catch {
    contractViolations = [...contractViolations, 'missing_commit'];
  }

  const ret: AgentInvocationResult = {
    runtime: input.runtime,
    provider: '',
    model: input.model,
    exitCode,
    durationMs,
    stdoutPath,
    stderrPath,
    contractViolations,
    outcome,
  };
  if (endCommitSha) ret.endCommitSha = endCommitSha;
  return ret;
}
```

- [ ] **Step 2: Typecheck the infrastructure package**

Run: `pnpm --filter @ai-sdlc/infrastructure typecheck`
Expected: exits 0. (No standalone test yet — Task 5 exercises this via the adapter.)

- [ ] **Step 3: Commit**

```bash
git add packages/infrastructure/src/agent/external-cli-runner.ts
git commit -m "feat(infra): add shared external-cli-runner for CLI agent runtimes"
```

---

### Task 4: Create test-double fixtures for `agy`

**Files:**
- Create: `packages/infrastructure/src/agent/__fixtures__/fake-agy-success.sh`
- Create: `packages/infrastructure/src/agent/__fixtures__/fake-agy-fail.sh`
- Create: `packages/infrastructure/src/agent/__fixtures__/fake-agy-slow.sh`

- [ ] **Step 1: Write `fake-agy-success.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
echo "fake agy success: OK" >&1
echo "no errors" >&2
exit 0
```

- [ ] **Step 2: Write `fake-agy-fail.sh`**

```bash
#!/usr/bin/env bash
echo "fake agy fail" >&2
exit 5
```

- [ ] **Step 3: Write `fake-agy-slow.sh`**

```bash
#!/usr/bin/env bash
echo "starting"
exec sleep 30
```

- [ ] **Step 4: Make them executable**

Run: `chmod +x packages/infrastructure/src/agent/__fixtures__/fake-agy-*.sh`
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/infrastructure/src/agent/__fixtures__/fake-agy-success.sh \
        packages/infrastructure/src/agent/__fixtures__/fake-agy-fail.sh \
        packages/infrastructure/src/agent/__fixtures__/fake-agy-slow.sh
git commit -m "test(infra): add fake agy CLI fixtures"
```

---

### Task 5: Implement `AntigravityAgentAdapter` (TDD)

**Files:**
- Test: `packages/infrastructure/src/agent/__tests__/antigravity-adapter.test.ts`
- Create: `packages/infrastructure/src/agent/antigravity-adapter.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/infrastructure/src/agent/__tests__/antigravity-adapter.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { AgentProfileName } from '@ai-sdlc/domain';
import { AntigravityAgentAdapter } from '../antigravity-adapter.js';

function makeWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agy-test-'));
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email t@test', { cwd: dir });
  execSync('git config user.name t', { cwd: dir });
  writeFileSync(join(dir, 'README.md'), 'x');
  execSync('git add . && git commit -q -m init', { cwd: dir });
  return dir;
}

const FIXTURES = join(__dirname, '..', '__fixtures__');

function req(cwd: string, overrides = {}) {
  return {
    profile: AgentProfileName('antigravity-reviewer'),
    promptPath: join(cwd, 'README.md'),
    expectedArtifacts: [],
    cwd,
    runId: '00000000-0000-0000-0000-000000000001',
    repoId: 'r',
    phaseId: 'whole-pr-review',
    startCommitSha: execSync('git rev-parse HEAD', { cwd }).toString().trim(),
    model: 'default',
    ...overrides,
  };
}

describe('AntigravityAgentAdapter', () => {
  it('returns success and runtime "antigravity" for a 0-exit child', async () => {
    const cwd = makeWorktree();
    const adapter = new AntigravityAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-agy-success.sh'),
      artifactsDir: cwd,
    });
    const result = await adapter.invoke(req(cwd));
    expect(result.outcome).toBe('success');
    expect(result.runtime).toBe('antigravity');
    expect(result.exitCode).toBe(0);
    expect(readFileSync(result.stdoutPath, 'utf-8')).toContain('fake agy success');
    expect(result.endCommitSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('returns failed outcome for non-zero exit', async () => {
    const cwd = makeWorktree();
    const adapter = new AntigravityAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-agy-fail.sh'),
      artifactsDir: cwd,
    });
    const r = await adapter.invoke(req(cwd));
    expect(r.outcome).toBe('failed');
    expect(r.exitCode).toBe(5);
  });

  it('passes the prompt file contents as the --print argument', async () => {
    const cwd = makeWorktree();
    const promptPath = join(cwd, 'prompt.md');
    writeFileSync(promptPath, 'REVIEW THIS PR');
    const argLog = join(cwd, 'args.txt');
    const shim = join(cwd, 'shim.sh');
    writeFileSync(shim, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argLog}"\nexit 0\n`);
    execSync(`chmod +x ${shim}`);
    const adapter = new AntigravityAgentAdapter({ binaryPath: shim, artifactsDir: cwd });
    await adapter.invoke(req(cwd, { promptPath }));
    const args = readFileSync(argLog, 'utf-8');
    expect(args).toContain('--print');
    expect(args).toContain('REVIEW THIS PR');
  });

  it('marks cancellation via AbortController as failed/cancelled_by_orchestrator', async () => {
    const cwd = makeWorktree();
    const adapter = new AntigravityAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-agy-slow.sh'),
      artifactsDir: cwd,
    });
    const controller = new AbortController();
    const p = adapter.invoke(req(cwd, { abortSignal: controller.signal }));
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    const r = await p;
    expect(r.outcome).toBe('failed');
    expect(r.contractViolations).toContain('cancelled_by_orchestrator');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run packages/infrastructure/src/agent/__tests__/antigravity-adapter.test.ts`
Expected: FAIL — `Cannot find module '../antigravity-adapter.js'`.

- [ ] **Step 3: Write the adapter**

Create `packages/infrastructure/src/agent/antigravity-adapter.ts`:

```typescript
import { readFileSync } from 'node:fs';
import {
  type AgentPort,
  type AgentInvocationRequest,
  type AgentInvocationResult,
} from '@ai-sdlc/application';
import { runExternalCli } from './external-cli-runner.js';

export interface AntigravityAdapterOptions {
  binaryPath?: string;
  artifactsDir: string;
  timeoutMsDefault?: number;
}

/**
 * Experimental reviewer-only runtime backed by Google Antigravity CLI (`agy`).
 * Verified headless contract (agy 1.0.3): `agy --print "<prompt>"` returns the
 * response on stdout and exits 0. Reviewer-only: never pass
 * --dangerously-skip-permissions.
 */
export class AntigravityAgentAdapter implements AgentPort {
  constructor(private readonly opts: AntigravityAdapterOptions) {}

  async invoke(request: AgentInvocationRequest): Promise<AgentInvocationResult> {
    const bin = this.opts.binaryPath ?? 'agy';
    const prompt = readFileSync(request.promptPath, 'utf-8');
    const args = ['--print', prompt];
    return runExternalCli({
      runtime: 'antigravity',
      bin,
      args,
      cwd: request.cwd,
      artifactsDir: this.opts.artifactsDir,
      model: request.model ?? '',
      ...(this.opts.timeoutMsDefault !== undefined
        ? { timeoutMsDefault: this.opts.timeoutMsDefault }
        : {}),
      ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}),
    });
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run packages/infrastructure/src/agent/__tests__/antigravity-adapter.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/infrastructure/src/agent/antigravity-adapter.ts \
        packages/infrastructure/src/agent/__tests__/antigravity-adapter.test.ts
git commit -m "feat(infra): add AntigravityAgentAdapter (agy --print contract)"
```

---

### Task 6: Export the adapter and runner

**Files:**
- Modify: `packages/infrastructure/src/agent/index.ts`

- [ ] **Step 1: Add exports**

Append to `packages/infrastructure/src/agent/index.ts`:

```typescript
export { runExternalCli, type ExternalCliRunInput } from './external-cli-runner.js';
export {
  AntigravityAgentAdapter,
  type AntigravityAdapterOptions,
} from './antigravity-adapter.js';
```

- [ ] **Step 2: Build the package**

Run: `pnpm --filter @ai-sdlc/infrastructure build`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add packages/infrastructure/src/agent/index.ts
git commit -m "feat(infra): export AntigravityAgentAdapter and runExternalCli"
```

---

### Task 7: Router routing + runtime-identity test (TDD)

Confirms the router dispatches an `antigravity` profile to the registered adapter and records `runtime: 'antigravity'` on the invocation row.

**Files:**
- Create: `packages/infrastructure/src/agent/__tests__/router-antigravity-routing.test.ts`

- [ ] **Step 1: Write the test**

Create `packages/infrastructure/src/agent/__tests__/router-antigravity-routing.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { AgentProfileName } from '@ai-sdlc/domain';
import { FakeAgentInvocationPort } from '@ai-sdlc/application/test-doubles';
import {
  type AgentPort,
  type AgentInvocationRequest,
  type AgentInvocationResult,
} from '@ai-sdlc/application';
import { type AgentConfig } from '@ai-sdlc/shared';
import { AgentRuntimeRouter } from '../agent-runtime-router.js';

class StubAdapter implements AgentPort {
  public calls = 0;
  constructor(private readonly result: AgentInvocationResult) {}
  async invoke(_: AgentInvocationRequest): Promise<AgentInvocationResult> {
    this.calls += 1;
    return this.result;
  }
}

function cfg(): AgentConfig {
  return {
    defaultProfile: 'antigravity-reviewer',
    profiles: {
      'antigravity-reviewer': {
        runtime: 'antigravity',
        provider: 'google',
        model: 'default',
        timeoutMinutes: 1,
      },
    },
    phaseProfiles: {
      'whole-pr-review': { profile: 'antigravity-reviewer' },
    },
  };
}

describe('AgentRuntimeRouter — antigravity routing', () => {
  it('dispatches antigravity profiles to the antigravity adapter and records the runtime', async () => {
    const inv = new FakeAgentInvocationPort();
    const adapter = new StubAdapter({
      runtime: 'antigravity',
      provider: '',
      model: 'default',
      exitCode: 0,
      durationMs: 10,
      stdoutPath: '/tmp/stdout.log',
      stderrPath: '/tmp/stderr.log',
      contractViolations: [],
      outcome: 'success',
    });
    const router = new AgentRuntimeRouter({
      agent: cfg(),
      adapters: { antigravity: adapter },
      invocationRepository: inv,
      readPromptChars: () => 0,
    });
    const req: AgentInvocationRequest = {
      profile: AgentProfileName('antigravity-reviewer'),
      promptPath: '/tmp/prompt.md',
      expectedArtifacts: [],
      cwd: '/tmp',
      runId: '00000000-0000-0000-0000-000000000001',
      repoId: 'r1',
      phaseId: 'whole-pr-review',
      startCommitSha: 'a'.repeat(40),
    };
    const result = await router.invoke(req);
    expect(result.runtime).toBe('antigravity');
    expect(adapter.calls).toBe(1);
    const rows = inv.listByRuntime('antigravity');
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe('google');
  });
});
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `pnpm exec vitest run packages/infrastructure/src/agent/__tests__/router-antigravity-routing.test.ts`
Expected: PASS. (The router is runtime-agnostic — this guards against accidental enum/dispatch regressions.)

- [ ] **Step 3: Commit**

```bash
git add packages/infrastructure/src/agent/__tests__/router-antigravity-routing.test.ts
git commit -m "test(infra): router records antigravity runtime identity"
```

---

### Task 8: Register the adapter in `composeRoot()`

Only construct the adapter when an `antigravity` profile is configured (mirrors the existing `needsPi` gate).

**Files:**
- Modify: `apps/api/src/compose.ts:36` (import) and `apps/api/src/compose.ts:199-210` (adapters map)

- [ ] **Step 1: Extend the import**

Change line 36:

```typescript
import {
  AgentRuntimeRouter,
  OpenCodeAgentAdapter,
  PiAgentAdapter,
  AntigravityAgentAdapter,
} from '@ai-sdlc/infrastructure';
```

- [ ] **Step 2: Add the gated registration**

In the `if (config.agent) {` block, immediately after the existing `if (needsPi) { ... }` block (which ends with the closing brace after `adapters.pi = ...`), add:

```typescript
      const needsAntigravity = Object.values(config.agent.profiles).some(
        (p) => p.runtime === 'antigravity',
      );
      if (needsAntigravity) {
        adapters.antigravity = new AntigravityAgentAdapter({
          artifactsDir: join(runsDir, 'agent-artifacts'),
        });
      }
```

- [ ] **Step 3: Build the api app**

Run: `pnpm --filter @ai-sdlc/api build`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/compose.ts
git commit -m "feat(api): register AntigravityAgentAdapter when an antigravity profile exists"
```

---

### Task 9: Add the experimental profile + reviewer fallback to `.ai-orchestrator.json`

**Files:**
- Modify: `.ai-orchestrator.json`

- [ ] **Step 1: Add the profile**

In `agent.profiles`, add after the `pi-qwen-local` entry:

```json
      "antigravity-reviewer": {
        "runtime": "antigravity",
        "provider": "google",
        "model": "default",
        "timeoutMinutes": 45
      }
```

- [ ] **Step 2: Wire it as a `whole-pr-review` fallback**

Replace the existing `"whole-pr-review"` line in `agent.phaseProfiles`:

```json
      "whole-pr-review": {
        "profile": "reviewer",
        "fallbackProfile": "antigravity-reviewer",
        "fallbackTriggers": ["timeout", "quota_exceeded", "runtime_error"]
      },
```

- [ ] **Step 3: Verify the config still loads**

Run: `pnpm exec vitest run packages/shared/src/__tests__/agent-config.test.ts`
Expected: PASS. Then confirm the live file parses:
Run: `pnpm exec tsx -e "import {loadConfig} from './packages/shared/src/config/loader.js'; loadConfig(process.cwd()); console.log('config OK')"`
Expected: prints `config OK`. (If `loader.js` path differs, use the project's existing config-load entrypoint.)

- [ ] **Step 4: Commit**

```bash
git add .ai-orchestrator.json
git commit -m "config: add experimental antigravity-reviewer profile + whole-pr-review fallback"
```

---

### Task 10: Full verification

- [ ] **Step 1: Build, typecheck, lint, test**

Run: `pnpm build && pnpm typecheck && pnpm lint && pnpm test`
Expected: all exit 0; new antigravity tests green.

- [ ] **Step 2: Manual headless smoke (record output for the PR)**

Run from repo root:

```bash
agy --version
agy --print "Return exactly: OK"
```

Expected: version prints; second command prints `OK` and exits 0. Paste both into the PR description (acceptance criterion: "uses a verified headless command contract").

- [ ] **Step 3: Confirm no auth/session artifacts staged**

Run: `git status --porcelain`
Expected: only the files this plan touched. No `.agy/`, no session/credential files. If any appear, add them to `.gitignore` in a separate commit.

---

## Self-Review Notes (verified against #145)

- **Scope coverage:** enum (Task 1), schema (Task 2), adapter defaulting to `agy` (Task 5), verified `--print` contract (Tasks 5 + 10 smoke), router records runtime/provider/model (Task 7), stdout/stderr artifacts (runner Task 3 + Task 5 assertions), cancellation/timeout parity with existing adapters (runner reuses opencode's classification; Task 5 cancel test), tests for config/routing/adapter (Tasks 2/5/7), reviewer-fallback-only routing (Task 9). All acceptance criteria mapped.
- **Out of scope honored:** no `implement`/`post-pr-review`/`fix-review` wiring; no every-commit PR bot change; no `--dangerously-skip-permissions`.
- **Type consistency:** `runExternalCli`/`ExternalCliRunInput` names match across Tasks 3/5/6; `AntigravityAgentAdapter`/`AntigravityAdapterOptions` consistent; `runtime: 'antigravity'` used uniformly.
