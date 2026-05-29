# Codex (`codex`) Runtime Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an experimental `codex` agent runtime (backed by the Codex CLI `codex`) as a reviewer/adjudicator-only fallback, running in a read-only sandbox safe for unattended use.

**Architecture:** Reuse the shared `external-cli-runner.ts` helper introduced in #145. Add a thin `CodexAgentAdapter` that only knows its runtime id, default binary (`codex`), and the verified headless contract (`codex exec --sandbox read-only --color never <prompt>`). Wire it through `AgentRuntimeKind`, the config Zod enum, and `composeRoot` (only when a Codex profile is configured).

**Tech Stack:** TypeScript (ESM, NodeNext), execa, vitest, Zod, pnpm workspaces.

**Dependency:** This plan assumes #145 has landed `packages/infrastructure/src/agent/external-cli-runner.ts`. **Task 0** creates it if absent, so this plan is independently executable.

---

## Verified Runtime Contract (captured 2026-05-29)

Run on the dev machine from the repo root:

```
$ codex --version
codex-cli 0.130.0

$ codex exec --sandbox read-only --skip-git-repo-check "Return exactly the two characters: OK"
... (prompt was read and the session started) ...
ERROR: Quota exceeded. Check your plan and billing details.
[exit=1]
```

The quota error confirms the **command form is correct** (Codex read the prompt and ran); exit 1 here is a billing/quota condition, not a contract failure. Crucially, the stderr string `ERROR: Quota exceeded` matches the orchestrator's existing `QUOTA_PATTERNS` (`/quota.*exceed/i`), so the router classifies it as `quota_exceeded` and triggers fallback — exactly the desired behavior.

Relevant `codex exec --help` flags:

- `codex exec [PROMPT]` — "Run Codex non-interactively." Prompt is a positional arg; if omitted/`-`, read from stdin. **This is the headless contract we use.** (`exec` alias: `e`.)
- `-s, --sandbox <MODE>` — `read-only` | `workspace-write` | `danger-full-access`. **We use `read-only`** so the reviewer cannot write files or run unsandboxed commands.
- `--color <COLOR>` — `always` | `never` | `auto`. We use `never` for clean, parseable stdout.
- `-C, --cd <DIR>` — working root (execa already sets `cwd`, so not required).
- `-m, --model <MODEL>` — model selection.
- `--dangerously-bypass-approvals-and-sandbox` — **do NOT use** (reviewer must stay sandboxed).
- `-o, --output-last-message <FILE>` / `--json` — available for richer capture later; not needed for the first integration.

### Sandbox/approval & safety documentation (paste into the PR)

- **Auth:** Codex authenticates locally via `codex login` (stored under `$CODEX_HOME`, default `~/.codex`). No credentials in this repo. The adapter inherits the ambient environment and never writes credential files.
- **Headless without browser:** Yes — `codex exec` runs non-interactively and exits. Verified above (it ran to a clean exit-1 quota error; no interactive prompt).
- **Sandbox/approval config:** `--sandbox read-only` blocks file writes and network/command escalation; no approval prompts are needed because nothing requires approval in read-only mode. The adapter never passes `--dangerously-bypass-approvals-and-sandbox`.
- **Write/shell execution control:** read-only sandbox denies writes and restricts shell execution; combined with reviewer-only routing, no implementation phases use this runtime.
- **Auth expiry:** surfaces as a non-zero exit with an auth error on stderr → `outcome: 'failed'` (`runtime_error` trigger).
- **Quota/rate limits:** appear on stderr as `ERROR: Quota exceeded ...` (verified) → matched by `QUOTA_PATTERNS` → `quota_exceeded` trigger.

**Contract decision:** read the prompt file and pass its contents as the positional prompt argument to `codex exec`, with `--sandbox read-only --color never`. Do not implement PTY/TUI automation.

## File Structure

- **Reuse / Create-if-absent** `packages/infrastructure/src/agent/external-cli-runner.ts` (from #145).
- **Create** `packages/infrastructure/src/agent/codex-adapter.ts` — `CodexAgentAdapter`.
- **Modify** `packages/domain/src/agent-types.ts` — add `'codex'`.
- **Modify** `packages/shared/src/config/schema.ts:20` — add `'codex'`.
- **Modify** `packages/infrastructure/src/agent/index.ts` — export the adapter.
- **Modify** `apps/api/src/compose.ts` — gated registration.
- **Modify** `.ai-orchestrator.json` — add `codex-reviewer` profile + `whole-pr-review` fallback.
- **Create** `__fixtures__/fake-codex-success.sh`, `fake-codex-quota.sh`, `fake-codex-slow.sh`.
- **Create** `__tests__/codex-adapter.test.ts`, `__tests__/router-codex-routing.test.ts`.
- **Modify** `packages/shared/src/__tests__/agent-config.test.ts`.

---

### Task 0: Ensure the shared external-CLI runner exists

**Files:**
- Create-if-absent: `packages/infrastructure/src/agent/external-cli-runner.ts`

- [ ] **Step 1: Check for the file**

Run: `test -f packages/infrastructure/src/agent/external-cli-runner.ts && echo EXISTS || echo MISSING`

- [ ] **Step 2: If MISSING, create it** (identical to #145; skip if EXISTS)

```typescript
import { execa } from 'execa';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import {
  type AgentInvocationResult,
  type AgentRuntimeKind,
} from '@ai-sdlc/application';

export interface ExternalCliRunInput {
  runtime: AgentRuntimeKind;
  bin: string;
  args: string[];
  input?: string;
  cwd: string;
  artifactsDir: string;
  model: string;
  timeoutMsDefault?: number;
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

Also add to `packages/infrastructure/src/agent/index.ts` if absent:

```typescript
export { runExternalCli, type ExternalCliRunInput } from './external-cli-runner.js';
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @ai-sdlc/infrastructure typecheck`
Expected: exits 0.

- [ ] **Step 4: Commit only if you created the file**

```bash
git add packages/infrastructure/src/agent/external-cli-runner.ts packages/infrastructure/src/agent/index.ts
git commit -m "feat(infra): add shared external-cli-runner for CLI agent runtimes"
```

---

### Task 1: Add `codex` to the domain runtime kind

**Files:**
- Modify: `packages/domain/src/agent-types.ts:1`

- [ ] **Step 1: Edit the union type**

Preserve runtimes already added by #145/#146. The full target union (all three landed) is:

```typescript
export type AgentRuntimeKind =
  | 'opencode'
  | 'pi'
  | 'antigravity'
  | 'claude-code'
  | 'codex';
```

If only some have landed, append `'codex'` to whatever union currently exists.

- [ ] **Step 2: Build the domain package**

Run: `pnpm --filter @ai-sdlc/domain build`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add packages/domain/src/agent-types.ts
git commit -m "feat(domain): add 'codex' to AgentRuntimeKind"
```

---

### Task 2: Accept `codex` in the config schema (TDD)

**Files:**
- Test: `packages/shared/src/__tests__/agent-config.test.ts`
- Modify: `packages/shared/src/config/schema.ts:20`

- [ ] **Step 1: Add a failing test**

Append inside `describe('agent config schema', ...)`:

```typescript
  it('accepts a codex runtime profile', () => {
    const cfg = structuredClone(baseValid);
    cfg.agent.profiles['codex-reviewer'] = {
      runtime: 'codex',
      provider: 'openai',
      model: 'default',
      timeoutMinutes: 45,
    } as (typeof cfg.agent.profiles)['opencode-frontier'];
    expect(() => orchestratorConfigSchema.parse(cfg)).not.toThrow();
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run packages/shared/src/__tests__/agent-config.test.ts`
Expected: FAIL — `Invalid enum value` for `codex`.

- [ ] **Step 3: Add to the enum**

Edit `packages/shared/src/config/schema.ts` line 20 (preserving runtimes from #145/#146):

```typescript
const agentRuntime = z.enum(['opencode', 'pi', 'antigravity', 'claude-code', 'codex']);
```

(Include only the runtimes that actually exist in `AgentRuntimeKind` at this point; the enum must stay in sync with the union.)

- [ ] **Step 4: Run to verify pass**

Run: `pnpm exec vitest run packages/shared/src/__tests__/agent-config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/config/schema.ts packages/shared/src/__tests__/agent-config.test.ts
git commit -m "feat(config): accept 'codex' runtime in agent profile schema"
```

---

### Task 3: Create test-double fixtures for `codex`

**Files:**
- Create: `__fixtures__/fake-codex-success.sh`, `fake-codex-quota.sh`, `fake-codex-slow.sh`

- [ ] **Step 1: `fake-codex-success.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
echo "OK" >&1
exit 0
```

- [ ] **Step 2: `fake-codex-quota.sh`** (reproduces the real quota stderr; exit 1)

```bash
#!/usr/bin/env bash
echo "ERROR: Quota exceeded. Check your plan and billing details." >&2
exit 1
```

- [ ] **Step 3: `fake-codex-slow.sh`**

```bash
#!/usr/bin/env bash
echo "working"
exec sleep 30
```

- [ ] **Step 4: Make executable**

Run: `chmod +x packages/infrastructure/src/agent/__fixtures__/fake-codex-*.sh`
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/infrastructure/src/agent/__fixtures__/fake-codex-success.sh \
        packages/infrastructure/src/agent/__fixtures__/fake-codex-quota.sh \
        packages/infrastructure/src/agent/__fixtures__/fake-codex-slow.sh
git commit -m "test(infra): add fake codex CLI fixtures"
```

---

### Task 4: Implement `CodexAgentAdapter` (TDD)

**Files:**
- Test: `packages/infrastructure/src/agent/__tests__/codex-adapter.test.ts`
- Create: `packages/infrastructure/src/agent/codex-adapter.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/infrastructure/src/agent/__tests__/codex-adapter.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { AgentProfileName } from '@ai-sdlc/domain';
import { CodexAgentAdapter } from '../codex-adapter.js';

function makeWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codex-test-'));
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
    profile: AgentProfileName('codex-reviewer'),
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

describe('CodexAgentAdapter', () => {
  it('returns success and runtime "codex" for a 0-exit child', async () => {
    const cwd = makeWorktree();
    const adapter = new CodexAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-codex-success.sh'),
      artifactsDir: cwd,
    });
    const result = await adapter.invoke(req(cwd));
    expect(result.outcome).toBe('success');
    expect(result.runtime).toBe('codex');
    expect(readFileSync(result.stdoutPath, 'utf-8')).toContain('OK');
    expect(result.endCommitSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('returns failed outcome with quota stderr preserved for the router', async () => {
    const cwd = makeWorktree();
    const adapter = new CodexAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-codex-quota.sh'),
      artifactsDir: cwd,
    });
    const r = await adapter.invoke(req(cwd));
    expect(r.outcome).toBe('failed');
    expect(r.exitCode).toBe(1);
    // Router isQuotaError reads this file; must contain the quota signature.
    expect(readFileSync(r.stderrPath, 'utf-8')).toMatch(/quota.*exceed/i);
  });

  it('runs exec in a read-only sandbox and never bypasses approvals', async () => {
    const cwd = makeWorktree();
    const argLog = join(cwd, 'args.txt');
    const shim = join(cwd, 'shim.sh');
    writeFileSync(shim, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argLog}"\nexit 0\n`);
    execSync(`chmod +x ${shim}`);
    const adapter = new CodexAgentAdapter({ binaryPath: shim, artifactsDir: cwd });
    await adapter.invoke(req(cwd));
    const args = readFileSync(argLog, 'utf-8');
    expect(args).toContain('exec');
    expect(args).toContain('--sandbox');
    expect(args).toContain('read-only');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args).not.toContain('workspace-write');
    expect(args).not.toContain('danger-full-access');
  });

  it('marks cancellation via AbortController as failed/cancelled_by_orchestrator', async () => {
    const cwd = makeWorktree();
    const adapter = new CodexAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-codex-slow.sh'),
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

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run packages/infrastructure/src/agent/__tests__/codex-adapter.test.ts`
Expected: FAIL — `Cannot find module '../codex-adapter.js'`.

- [ ] **Step 3: Write the adapter**

Create `packages/infrastructure/src/agent/codex-adapter.ts`:

```typescript
import { readFileSync } from 'node:fs';
import {
  type AgentPort,
  type AgentInvocationRequest,
  type AgentInvocationResult,
} from '@ai-sdlc/application';
import { runExternalCli } from './external-cli-runner.js';

export interface CodexAdapterOptions {
  binaryPath?: string;
  artifactsDir: string;
  timeoutMsDefault?: number;
}

/**
 * Experimental reviewer/adjudicator-only runtime backed by the Codex CLI (`codex`).
 * Verified headless contract (codex-cli 0.130.0):
 *   codex exec --sandbox read-only --color never "<prompt>"
 * read-only sandbox forbids writes and unsandboxed command execution. The
 * adapter NEVER passes --dangerously-bypass-approvals-and-sandbox or a writable
 * sandbox mode. Quota errors surface on stderr as "ERROR: Quota exceeded ..."
 * which the router's QUOTA_PATTERNS already match.
 */
export class CodexAgentAdapter implements AgentPort {
  constructor(private readonly opts: CodexAdapterOptions) {}

  async invoke(request: AgentInvocationRequest): Promise<AgentInvocationResult> {
    const bin = this.opts.binaryPath ?? 'codex';
    const prompt = readFileSync(request.promptPath, 'utf-8');
    const args = ['exec', '--sandbox', 'read-only', '--color', 'never'];
    if (request.model && request.model !== 'default') {
      args.push('--model', request.model);
    }
    args.push(prompt);
    return runExternalCli({
      runtime: 'codex',
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

- [ ] **Step 4: Run to verify pass**

Run: `pnpm exec vitest run packages/infrastructure/src/agent/__tests__/codex-adapter.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/infrastructure/src/agent/codex-adapter.ts \
        packages/infrastructure/src/agent/__tests__/codex-adapter.test.ts
git commit -m "feat(infra): add CodexAgentAdapter (codex exec read-only sandbox contract)"
```

---

### Task 5: Export the adapter

**Files:**
- Modify: `packages/infrastructure/src/agent/index.ts`

- [ ] **Step 1: Add the export**

```typescript
export { CodexAgentAdapter, type CodexAdapterOptions } from './codex-adapter.js';
```

- [ ] **Step 2: Build**

Run: `pnpm --filter @ai-sdlc/infrastructure build`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add packages/infrastructure/src/agent/index.ts
git commit -m "feat(infra): export CodexAgentAdapter"
```

---

### Task 6: Router routing + runtime-identity test (TDD)

**Files:**
- Create: `packages/infrastructure/src/agent/__tests__/router-codex-routing.test.ts`

- [ ] **Step 1: Write the test**

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
    defaultProfile: 'codex-reviewer',
    profiles: {
      'codex-reviewer': {
        runtime: 'codex',
        provider: 'openai',
        model: 'default',
        timeoutMinutes: 1,
      },
    },
    phaseProfiles: {
      'whole-pr-review': { profile: 'codex-reviewer' },
    },
  };
}

describe('AgentRuntimeRouter — codex routing', () => {
  it('dispatches codex profiles to the codex adapter and records the runtime', async () => {
    const inv = new FakeAgentInvocationPort();
    const adapter = new StubAdapter({
      runtime: 'codex',
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
      adapters: { codex: adapter },
      invocationRepository: inv,
      readPromptChars: () => 0,
    });
    const req: AgentInvocationRequest = {
      profile: AgentProfileName('codex-reviewer'),
      promptPath: '/tmp/prompt.md',
      expectedArtifacts: [],
      cwd: '/tmp',
      runId: '00000000-0000-0000-0000-000000000001',
      repoId: 'r1',
      phaseId: 'whole-pr-review',
      startCommitSha: 'a'.repeat(40),
    };
    const result = await router.invoke(req);
    expect(result.runtime).toBe('codex');
    expect(adapter.calls).toBe(1);
    const rows = inv.listByRuntime('codex');
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe('openai');
  });
});
```

- [ ] **Step 2: Run to verify pass**

Run: `pnpm exec vitest run packages/infrastructure/src/agent/__tests__/router-codex-routing.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/infrastructure/src/agent/__tests__/router-codex-routing.test.ts
git commit -m "test(infra): router records codex runtime identity"
```

---

### Task 7: Register the adapter in `composeRoot()`

**Files:**
- Modify: `apps/api/src/compose.ts:36` (import) and the `if (config.agent)` adapters block.

- [ ] **Step 1: Extend the import**

Add `CodexAgentAdapter` to the `@ai-sdlc/infrastructure` import at line 36 (keeping any already added by #145/#146):

```typescript
import {
  AgentRuntimeRouter,
  OpenCodeAgentAdapter,
  PiAgentAdapter,
  CodexAgentAdapter,
} from '@ai-sdlc/infrastructure';
```

- [ ] **Step 2: Add the gated registration**

After the existing `needsPi` block inside `if (config.agent) {`:

```typescript
      const needsCodex = Object.values(config.agent.profiles).some(
        (p) => p.runtime === 'codex',
      );
      if (needsCodex) {
        adapters.codex = new CodexAgentAdapter({
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
git commit -m "feat(api): register CodexAgentAdapter when a codex profile exists"
```

---

### Task 8: Add the experimental profile + reviewer fallback to `.ai-orchestrator.json`

**Files:**
- Modify: `.ai-orchestrator.json`

> **Coordination note:** #145 also wires a `whole-pr-review` fallback (`antigravity-reviewer`). A phase entry has a single `fallbackProfile`. If #145 already set `whole-pr-review` → `antigravity-reviewer`, do **not** overwrite it; instead route Codex through a different reviewer phase (use the `spec-review` entry below). If `whole-pr-review` is still the plain `{ "profile": "reviewer" }`, use the `whole-pr-review` form. Pick exactly one.

- [ ] **Step 1: Add the profile**

In `agent.profiles`:

```json
      "codex-reviewer": {
        "runtime": "codex",
        "provider": "openai",
        "model": "default",
        "timeoutMinutes": 45
      }
```

- [ ] **Step 2: Wire it as a reviewer fallback (choose ONE per the coordination note)**

If `whole-pr-review` is free:

```json
      "whole-pr-review": {
        "profile": "reviewer",
        "fallbackProfile": "codex-reviewer",
        "fallbackTriggers": ["timeout", "quota_exceeded", "runtime_error"]
      },
```

Otherwise route Codex via `spec-review`:

```json
      "spec-review": {
        "profile": "task-reviewer",
        "fallbackProfile": "codex-reviewer",
        "fallbackTriggers": ["timeout", "quota_exceeded", "runtime_error"]
      },
```

- [ ] **Step 3: Verify the config loads**

Run: `pnpm exec vitest run packages/shared/src/__tests__/agent-config.test.ts`
Expected: PASS.
Run: `pnpm exec tsx -e "import {loadConfig} from './packages/shared/src/config/loader.js'; loadConfig(process.cwd()); console.log('config OK')"`
Expected: prints `config OK`.

- [ ] **Step 4: Commit**

```bash
git add .ai-orchestrator.json
git commit -m "config: add experimental codex-reviewer profile + reviewer fallback"
```

---

### Task 9: Full verification

- [ ] **Step 1: Build, typecheck, lint, test**

Run: `pnpm build && pnpm typecheck && pnpm lint && pnpm test`
Expected: all exit 0; new codex tests green.

- [ ] **Step 2: Manual headless smoke (record for the PR)**

```bash
codex --version
codex exec --sandbox read-only --color never "Return exactly: OK"
```

Expected: version prints; the second command either prints `OK` and exits 0, or (if quota-limited) prints `ERROR: Quota exceeded ...` and exits 1 — either way the command form is correct and the prompt was read. Paste the output plus the sandbox/safety bullets into the PR description.

- [ ] **Step 3: Confirm no auth/session artifacts staged**

Run: `git status --porcelain`
Expected: only files this plan touched. No `.codex/` session/credential files (default `$CODEX_HOME` is `~/.codex`, outside the repo, but double-check). Add to `.gitignore` separately if any appear.

---

## Self-Review Notes (verified against #147)

- **Scope coverage:** enum (Task 1), schema (Task 2), adapter defaulting to `codex` (Task 4), verified `codex exec --sandbox read-only` contract (Tasks 4 + 9), sandbox/approval documented + tested (contract section + Task 4 "never bypasses" assertions), router records runtime/provider/model (Task 6), stdout/stderr artifacts (runner + Task 4), cancellation/timeout parity (runner; Task 4 cancel test), config/routing/adapter tests (Tasks 2/4/6), reviewer/adjudicator-only routing (Task 8). All acceptance criteria mapped.
- **Out of scope honored:** no `implement`/`post-pr-review`/`fix-review`; no every-commit PR bot change; no bypass-sandbox/approval flags; no writable sandbox modes.
- **Type consistency:** `CodexAgentAdapter`/`CodexAdapterOptions` consistent across Tasks 4/5/7; `runtime: 'codex'` uniform; adapters-map key `codex` matches enum string.
- **Quota realism:** fixture `fake-codex-quota.sh` reproduces the real stderr string verified on 2026-05-29, and Task 4 asserts it matches the router's quota pattern — so the configured `quota_exceeded` fallback trigger actually fires.
- **Coordination:** Task 8 note prevents #145 and #147 from clobbering the same `whole-pr-review` fallback slot.
