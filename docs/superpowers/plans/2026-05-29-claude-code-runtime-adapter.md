# Claude Code (`claude`) Runtime Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an experimental `claude-code` agent runtime (backed by the Claude Code CLI `claude`) as a reviewer/adjudicator-only fallback, using a read-only permission mode that is safe for unattended use.

**Architecture:** Reuse the shared `external-cli-runner.ts` helper introduced in #145 (Antigravity). Add a thin `ClaudeCodeAgentAdapter` that only knows its runtime id, default binary (`claude`), and the verified headless contract (`claude -p <prompt> --permission-mode plan --output-format text`). Wire it through `AgentRuntimeKind`, the config Zod enum, and `composeRoot` (only when a Claude Code profile is configured).

**Tech Stack:** TypeScript (ESM, NodeNext), execa, vitest, Zod, pnpm workspaces.

**Dependency:** This plan assumes #145 has landed `packages/infrastructure/src/agent/external-cli-runner.ts`. **Task 0** creates it if absent, so this plan is independently executable.

---

## Verified Runtime Contract (captured 2026-05-29)

Run on the dev machine from the repo root:

```
$ claude --version
2.1.156 (Claude Code)

$ claude -p "Return exactly the two characters: OK" --permission-mode plan --output-format text
OK
[exit=0]
```

Relevant `claude --help` flags:

- `-p, --print` — "Print response and exit (useful for pipes)." Non-interactive; the workspace trust dialog is skipped. **This is the headless contract we use.** The prompt may be passed as a positional argument or piped via stdin.
- `--permission-mode <mode>` — choices include `plan` (**read-only planning mode — no edits/writes**), `default`, `acceptEdits`, `bypassPermissions`, `dontAsk`, `auto`. **We use `plan`** so reviewer prompts cannot perform unsolicited writes.
- `--output-format <format>` — `text` (default), `json`, `stream-json`. We use `text` for deterministic stdout.
- `--model <model>` — alias (`opus`/`sonnet`) or full id.

### Permission/safety documentation (paste into the PR)

- **Auth:** Claude Code is authenticated locally via its own login/session (OAuth/keychain or `ANTHROPIC_API_KEY`). No credentials live in this repo. The adapter inherits the ambient environment; it does not write or read credential files.
- **Headless without browser:** Yes — `claude -p` runs non-interactively and exits. Verified above (exit 0). The trust dialog is auto-skipped in `-p` mode.
- **Write/tool permission control:** `--permission-mode plan` keeps the session in read-only planning mode; the adapter never passes `--dangerously-skip-permissions` / `--allow-dangerously-skip-permissions` / `bypassPermissions`.
- **Command execution limits:** In `plan` mode the agent proposes but does not execute edits/writes; combined with reviewer-only routing, no implementation phases use this runtime.
- **Auth expiry:** surfaces as a non-zero exit with an auth error on stderr → mapped to `outcome: 'failed'` (`runtime_error` trigger).
- **Quota/rate limits:** appear in stderr; the router's `isQuotaError` matches `QUOTA_PATTERNS` (e.g. `429`, `rate_limit_exceeded`, `Usage limit reached`) → `quota_exceeded` trigger.

**Contract decision:** read the prompt file and pass its contents as the positional prompt argument with `-p`, plus `--permission-mode plan --output-format text`. Do not implement PTY/TUI automation.

## File Structure

- **Reuse / Create-if-absent** `packages/infrastructure/src/agent/external-cli-runner.ts` (from #145).
- **Create** `packages/infrastructure/src/agent/claude-code-adapter.ts` — `ClaudeCodeAgentAdapter`.
- **Modify** `packages/domain/src/agent-types.ts` — add `'claude-code'`.
- **Modify** `packages/shared/src/config/schema.ts:20` — add `'claude-code'`.
- **Modify** `packages/infrastructure/src/agent/index.ts` — export the adapter.
- **Modify** `apps/api/src/compose.ts` — gated registration.
- **Modify** `.ai-orchestrator.json` — add `claude-reviewer` profile + `task-reviewer` fallback.
- **Create** `__fixtures__/fake-claude-success.sh`, `fake-claude-fail.sh`, `fake-claude-slow.sh`.
- **Create** `__tests__/claude-code-adapter.test.ts`, `__tests__/router-claude-code-routing.test.ts`.
- **Modify** `packages/shared/src/__tests__/agent-config.test.ts`.

---

### Task 0: Ensure the shared external-CLI runner exists

**Files:**
- Create-if-absent: `packages/infrastructure/src/agent/external-cli-runner.ts`

- [ ] **Step 1: Check for the file**

Run: `test -f packages/infrastructure/src/agent/external-cli-runner.ts && echo EXISTS || echo MISSING`

- [ ] **Step 2: If MISSING, create it** (identical to #145; skip this step if EXISTS)

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

Also add the export to `packages/infrastructure/src/agent/index.ts` if absent:

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

### Task 1: Add `claude-code` to the domain runtime kind

**Files:**
- Modify: `packages/domain/src/agent-types.ts:1`

- [ ] **Step 1: Edit the union type**

If #145 already added `antigravity`:

```typescript
export type AgentRuntimeKind = 'opencode' | 'pi' | 'antigravity' | 'claude-code';
```

If #145 has not landed, instead use:

```typescript
export type AgentRuntimeKind = 'opencode' | 'pi' | 'claude-code';
```

- [ ] **Step 2: Build the domain package**

Run: `pnpm --filter @ai-sdlc/domain build`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add packages/domain/src/agent-types.ts
git commit -m "feat(domain): add 'claude-code' to AgentRuntimeKind"
```

---

### Task 2: Accept `claude-code` in the config schema (TDD)

**Files:**
- Test: `packages/shared/src/__tests__/agent-config.test.ts`
- Modify: `packages/shared/src/config/schema.ts:20`

- [ ] **Step 1: Add a failing test**

Append inside `describe('agent config schema', ...)`:

```typescript
  it('accepts a claude-code runtime profile', () => {
    const cfg = structuredClone(baseValid);
    cfg.agent.profiles['claude-reviewer'] = {
      runtime: 'claude-code',
      provider: 'anthropic',
      model: 'default',
      timeoutMinutes: 45,
    } as (typeof cfg.agent.profiles)['opencode-frontier'];
    expect(() => orchestratorConfigSchema.parse(cfg)).not.toThrow();
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run packages/shared/src/__tests__/agent-config.test.ts`
Expected: FAIL — `Invalid enum value` for `claude-code`.

- [ ] **Step 3: Add to the enum**

Edit `packages/shared/src/config/schema.ts` line 20 (preserving any runtimes already added by #145):

```typescript
const agentRuntime = z.enum(['opencode', 'pi', 'antigravity', 'claude-code']);
```

(If `antigravity` is not present because #145 hasn't merged, use `['opencode', 'pi', 'claude-code']`.)

- [ ] **Step 4: Run to verify pass**

Run: `pnpm exec vitest run packages/shared/src/__tests__/agent-config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/config/schema.ts packages/shared/src/__tests__/agent-config.test.ts
git commit -m "feat(config): accept 'claude-code' runtime in agent profile schema"
```

---

### Task 3: Create test-double fixtures for `claude`

**Files:**
- Create: `__fixtures__/fake-claude-success.sh`, `fake-claude-fail.sh`, `fake-claude-slow.sh`

- [ ] **Step 1: `fake-claude-success.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
echo "OK" >&1
exit 0
```

- [ ] **Step 2: `fake-claude-fail.sh`**

```bash
#!/usr/bin/env bash
echo "Invalid API key · Fix external API key" >&2
exit 1
```

- [ ] **Step 3: `fake-claude-slow.sh`**

```bash
#!/usr/bin/env bash
echo "thinking"
exec sleep 30
```

- [ ] **Step 4: Make executable**

Run: `chmod +x packages/infrastructure/src/agent/__fixtures__/fake-claude-*.sh`
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/infrastructure/src/agent/__fixtures__/fake-claude-success.sh \
        packages/infrastructure/src/agent/__fixtures__/fake-claude-fail.sh \
        packages/infrastructure/src/agent/__fixtures__/fake-claude-slow.sh
git commit -m "test(infra): add fake claude CLI fixtures"
```

---

### Task 4: Implement `ClaudeCodeAgentAdapter` (TDD)

**Files:**
- Test: `packages/infrastructure/src/agent/__tests__/claude-code-adapter.test.ts`
- Create: `packages/infrastructure/src/agent/claude-code-adapter.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/infrastructure/src/agent/__tests__/claude-code-adapter.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { AgentProfileName } from '@ai-sdlc/domain';
import { ClaudeCodeAgentAdapter } from '../claude-code-adapter.js';

function makeWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'claude-test-'));
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
    profile: AgentProfileName('claude-reviewer'),
    promptPath: join(cwd, 'README.md'),
    expectedArtifacts: [],
    cwd,
    runId: '00000000-0000-0000-0000-000000000001',
    repoId: 'r',
    phaseId: 'quality-review',
    startCommitSha: execSync('git rev-parse HEAD', { cwd }).toString().trim(),
    model: 'default',
    ...overrides,
  };
}

describe('ClaudeCodeAgentAdapter', () => {
  it('returns success and runtime "claude-code" for a 0-exit child', async () => {
    const cwd = makeWorktree();
    const adapter = new ClaudeCodeAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-claude-success.sh'),
      artifactsDir: cwd,
    });
    const result = await adapter.invoke(req(cwd));
    expect(result.outcome).toBe('success');
    expect(result.runtime).toBe('claude-code');
    expect(readFileSync(result.stdoutPath, 'utf-8')).toContain('OK');
    expect(result.endCommitSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('returns failed outcome for non-zero exit (e.g. auth failure)', async () => {
    const cwd = makeWorktree();
    const adapter = new ClaudeCodeAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-claude-fail.sh'),
      artifactsDir: cwd,
    });
    const r = await adapter.invoke(req(cwd));
    expect(r.outcome).toBe('failed');
    expect(r.exitCode).toBe(1);
    expect(readFileSync(r.stderrPath, 'utf-8')).toContain('Invalid API key');
  });

  it('uses read-only plan permission mode and never bypasses permissions', async () => {
    const cwd = makeWorktree();
    const argLog = join(cwd, 'args.txt');
    const shim = join(cwd, 'shim.sh');
    writeFileSync(shim, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argLog}"\nexit 0\n`);
    execSync(`chmod +x ${shim}`);
    const adapter = new ClaudeCodeAgentAdapter({ binaryPath: shim, artifactsDir: cwd });
    await adapter.invoke(req(cwd));
    const args = readFileSync(argLog, 'utf-8');
    expect(args).toContain('-p');
    expect(args).toContain('--permission-mode');
    expect(args).toContain('plan');
    expect(args).toContain('--output-format');
    expect(args).toContain('text');
    expect(args).not.toContain('bypassPermissions');
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--allow-dangerously-skip-permissions');
  });

  it('marks cancellation via AbortController as failed/cancelled_by_orchestrator', async () => {
    const cwd = makeWorktree();
    const adapter = new ClaudeCodeAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-claude-slow.sh'),
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

Run: `pnpm exec vitest run packages/infrastructure/src/agent/__tests__/claude-code-adapter.test.ts`
Expected: FAIL — `Cannot find module '../claude-code-adapter.js'`.

- [ ] **Step 3: Write the adapter**

Create `packages/infrastructure/src/agent/claude-code-adapter.ts`:

```typescript
import { readFileSync } from 'node:fs';
import {
  type AgentPort,
  type AgentInvocationRequest,
  type AgentInvocationResult,
} from '@ai-sdlc/application';
import { runExternalCli } from './external-cli-runner.js';

export interface ClaudeCodeAdapterOptions {
  binaryPath?: string;
  artifactsDir: string;
  timeoutMsDefault?: number;
}

/**
 * Experimental reviewer/adjudicator-only runtime backed by Claude Code (`claude`).
 * Verified headless contract (claude 2.1.156):
 *   claude -p "<prompt>" --permission-mode plan --output-format text
 * `--permission-mode plan` is read-only: the session cannot perform unsolicited
 * writes/edits. The adapter NEVER passes bypassPermissions or any
 * --dangerously-skip-permissions flag.
 */
export class ClaudeCodeAgentAdapter implements AgentPort {
  constructor(private readonly opts: ClaudeCodeAdapterOptions) {}

  async invoke(request: AgentInvocationRequest): Promise<AgentInvocationResult> {
    const bin = this.opts.binaryPath ?? 'claude';
    const prompt = readFileSync(request.promptPath, 'utf-8');
    const args = ['-p', prompt, '--permission-mode', 'plan', '--output-format', 'text'];
    if (request.model && request.model !== 'default') {
      args.push('--model', request.model);
    }
    return runExternalCli({
      runtime: 'claude-code',
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

Run: `pnpm exec vitest run packages/infrastructure/src/agent/__tests__/claude-code-adapter.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/infrastructure/src/agent/claude-code-adapter.ts \
        packages/infrastructure/src/agent/__tests__/claude-code-adapter.test.ts
git commit -m "feat(infra): add ClaudeCodeAgentAdapter (claude -p plan-mode contract)"
```

---

### Task 5: Export the adapter

**Files:**
- Modify: `packages/infrastructure/src/agent/index.ts`

- [ ] **Step 1: Add the export**

```typescript
export {
  ClaudeCodeAgentAdapter,
  type ClaudeCodeAdapterOptions,
} from './claude-code-adapter.js';
```

- [ ] **Step 2: Build**

Run: `pnpm --filter @ai-sdlc/infrastructure build`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add packages/infrastructure/src/agent/index.ts
git commit -m "feat(infra): export ClaudeCodeAgentAdapter"
```

---

### Task 6: Router routing + runtime-identity test (TDD)

**Files:**
- Create: `packages/infrastructure/src/agent/__tests__/router-claude-code-routing.test.ts`

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
    defaultProfile: 'claude-reviewer',
    profiles: {
      'claude-reviewer': {
        runtime: 'claude-code',
        provider: 'anthropic',
        model: 'default',
        timeoutMinutes: 1,
      },
    },
    phaseProfiles: {
      'quality-review': { profile: 'claude-reviewer' },
    },
  };
}

describe('AgentRuntimeRouter — claude-code routing', () => {
  it('dispatches claude-code profiles to the claude-code adapter and records the runtime', async () => {
    const inv = new FakeAgentInvocationPort();
    const adapter = new StubAdapter({
      runtime: 'claude-code',
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
      adapters: { 'claude-code': adapter },
      invocationRepository: inv,
      readPromptChars: () => 0,
    });
    const req: AgentInvocationRequest = {
      profile: AgentProfileName('claude-reviewer'),
      promptPath: '/tmp/prompt.md',
      expectedArtifacts: [],
      cwd: '/tmp',
      runId: '00000000-0000-0000-0000-000000000001',
      repoId: 'r1',
      phaseId: 'quality-review',
      startCommitSha: 'a'.repeat(40),
    };
    const result = await router.invoke(req);
    expect(result.runtime).toBe('claude-code');
    expect(adapter.calls).toBe(1);
    const rows = inv.listByRuntime('claude-code');
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe('anthropic');
  });
});
```

- [ ] **Step 2: Run to verify pass**

Run: `pnpm exec vitest run packages/infrastructure/src/agent/__tests__/router-claude-code-routing.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/infrastructure/src/agent/__tests__/router-claude-code-routing.test.ts
git commit -m "test(infra): router records claude-code runtime identity"
```

---

### Task 7: Register the adapter in `composeRoot()`

**Files:**
- Modify: `apps/api/src/compose.ts:36` (import) and the `if (config.agent)` adapters block.

- [ ] **Step 1: Extend the import**

Add `ClaudeCodeAgentAdapter` to the `@ai-sdlc/infrastructure` import list at line 36:

```typescript
import {
  AgentRuntimeRouter,
  OpenCodeAgentAdapter,
  PiAgentAdapter,
  ClaudeCodeAgentAdapter,
} from '@ai-sdlc/infrastructure';
```

(Keep `AntigravityAgentAdapter` in the list too if #145 has landed.)

- [ ] **Step 2: Add the gated registration**

After the existing `needsPi` block inside `if (config.agent) {`, add:

```typescript
      const needsClaudeCode = Object.values(config.agent.profiles).some(
        (p) => p.runtime === 'claude-code',
      );
      if (needsClaudeCode) {
        adapters['claude-code'] = new ClaudeCodeAgentAdapter({
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
git commit -m "feat(api): register ClaudeCodeAgentAdapter when a claude-code profile exists"
```

---

### Task 8: Add the experimental profile + reviewer fallback to `.ai-orchestrator.json`

**Files:**
- Modify: `.ai-orchestrator.json`

- [ ] **Step 1: Add the profile**

In `agent.profiles`:

```json
      "claude-reviewer": {
        "runtime": "claude-code",
        "provider": "anthropic",
        "model": "default",
        "timeoutMinutes": 45
      }
```

- [ ] **Step 2: Wire it as a `quality-review` (task-reviewer) fallback**

Replace the existing `"quality-review"` entry in `agent.phaseProfiles`:

```json
      "quality-review": {
        "profile": "task-reviewer",
        "fallbackProfile": "claude-reviewer",
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
git commit -m "config: add experimental claude-reviewer profile + quality-review fallback"
```

---

### Task 9: Full verification

- [ ] **Step 1: Build, typecheck, lint, test**

Run: `pnpm build && pnpm typecheck && pnpm lint && pnpm test`
Expected: all exit 0; new claude-code tests green.

- [ ] **Step 2: Manual headless smoke (record for the PR)**

```bash
claude --version
claude -p "Return exactly: OK" --permission-mode plan --output-format text
```

Expected: version prints; second prints `OK`, exits 0. Paste both into the PR description plus the permission/safety bullets from the contract section above.

- [ ] **Step 3: Confirm no auth/session artifacts staged**

Run: `git status --porcelain`
Expected: only files this plan touched. No `.claude/` session/credential files. Add to `.gitignore` separately if any appear.

---

## Self-Review Notes (verified against #146)

- **Scope coverage:** enum (Task 1), schema (Task 2), adapter defaulting to `claude` (Task 4), verified `-p`/`--permission-mode plan` contract (Tasks 4 + 9), permission/write behavior documented + tested (contract section + Task 4 "never bypasses" assertions), router records runtime/provider/model (Task 6), stdout/stderr artifacts (runner + Task 4), cancellation/timeout parity (runner; Task 4 cancel test), config/routing/adapter tests (Tasks 2/4/6), reviewer/adjudicator-only routing (Task 8). All acceptance criteria mapped.
- **Out of scope honored:** no `implement`/`post-pr-review`/`fix-review`; no every-commit PR bot change; no bypass-permission flags.
- **Type consistency:** `ClaudeCodeAgentAdapter`/`ClaudeCodeAdapterOptions` consistent across Tasks 4/5/7; `runtime: 'claude-code'` uniform; adapters-map key `'claude-code'` matches enum string.
- **Dependency:** Task 0 makes the plan runnable whether or not #145 has merged.
