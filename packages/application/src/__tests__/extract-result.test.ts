import { describe, it, expect } from 'vitest';
import { AgentInvocationId, AgentProfileName, PhaseName, RunId } from '@ai-sdlc/domain';
import type { AgentInvocation } from '@ai-sdlc/domain';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeArtifactStore, FakeAgentPort } from '../test-doubles/index.js';
import { extractResult } from '../results/extract-result.js';
import { PHASE_RESULT_REGISTRY } from '../results/phase-registry.js';

function makeInvocation(overrides: Partial<AgentInvocation> = {}): AgentInvocation {
  return {
    id: AgentInvocationId('inv-1'),
    runId: RunId('r1'),
    phaseId: PhaseName('plan-design'),
    profile: AgentProfileName('p'),
    runtime: 'opencode',
    provider: 'a',
    model: 'm',
    promptPath: '/p',
    promptChars: 1,
    stdoutPath: '/s',
    stderrPath: '/e',
    startedAt: new Date(),
    startCommitSha: 'a'.repeat(40),
    timeoutMs: 1000,
    resultJsonPath: 'result.json',
    ...overrides,
  };
}

const RERUN_CTX = { cwd: '/repo', repoId: 'org/repo' };

const PHASE_TESTS: Array<{
  phase: string;
  validJson: object;
  invalidJson: object;
  retrySafe: boolean;
}> = [
  {
    phase: 'plan-design',
    validJson: { result: 'ready', summary: 'go' },
    invalidJson: { bad: 'shape' },
    retrySafe: true,
  },
  {
    phase: 'plan-write',
    validJson: { result: 'ready', tasks: [{ title: 'Do work' }] },
    invalidJson: { bad: 'shape' },
    retrySafe: true,
  },
  {
    phase: 'implement',
    validJson: { result: 'success', changedFiles: ['src/foo.ts'] },
    invalidJson: { bad: 'shape' },
    retrySafe: false,
  },
  {
    phase: 'review',
    validJson: { result: 'pass', findings: [] },
    invalidJson: { bad: 'shape' },
    retrySafe: true,
  },
  {
    phase: 'fix-review',
    validJson: { result: 'done_with_fixes' },
    invalidJson: { bad: 'shape' },
    retrySafe: true,
  },
  {
    phase: 'create-pr',
    validJson: {
      result: 'created' as const,
      prNumber: 42,
      prUrl: 'https://github.com/org/repo/pull/42',
    },
    invalidJson: { bad: 'shape' },
    retrySafe: false,
  },
  {
    phase: 'pr-review-poll',
    validJson: { result: 'handled', repliesPosted: 0 },
    invalidJson: { bad: 'shape' },
    retrySafe: true,
  },
];

describe('extractResult', () => {
  it('throws on unknown phase', async () => {
    const artifacts = new FakeArtifactStore();
    const agent = new FakeAgentPort();
    await expect(
      extractResult({
        invocation: makeInvocation({ phaseId: PhaseName('nonexistent') }),
        ports: { artifacts, agent },
        rerunContext: RERUN_CTX,
      }),
    ).rejects.toThrow("no result schema registered for phase 'nonexistent'");
  });

  describe.each(PHASE_TESTS)('phase=$phase', ({ phase, validJson, invalidJson, retrySafe }) => {
    it('(a) returns typed result on valid input', async () => {
      const artifacts = new FakeArtifactStore();
      await artifacts.write({
        runId: 'r1',
        relativePath: 'result.json',
        contents: JSON.stringify(validJson),
      });
      const agent = new FakeAgentPort();
      const outcome = await extractResult({
        invocation: makeInvocation({ phaseId: PhaseName(phase) }),
        ports: { artifacts, agent },
        rerunContext: RERUN_CTX,
      });
      expect(outcome).toEqual({ ok: true, result: validJson });
      expect(agent.invocations).toHaveLength(0);
    });

    it('(b) missing result.json + retrySafe → one rerun', async () => {
      const artifacts = new FakeArtifactStore();
      if (retrySafe) {
        const agent = new FakeAgentPort({
          p: [
            (_req) => {
              void artifacts.write({
                runId: 'r1',
                relativePath: 'result.json',
                contents: JSON.stringify(validJson),
              });
              return {
                runtime: 'opencode' as const,
                provider: 'a',
                model: 'm',
                exitCode: 0,
                durationMs: 500,
                stdoutPath: '/s2',
                stderrPath: '/e2',
                resultJsonPath: 'result.json',
                contractViolations: [],
                outcome: 'success' as const,
              };
            },
          ],
        });
        const outcome = await extractResult({
          invocation: makeInvocation({ phaseId: PhaseName(phase) }),
          ports: { artifacts, agent },
          rerunContext: RERUN_CTX,
        });
        expect(outcome.ok).toBe(true);
        if (outcome.ok) {
          expect(outcome.result).toEqual(validJson);
        }
        // extractResult calls agent.invoke ONCE for the rerun.
        // The original invocation happened before extractResult was called
        // and is not tracked by FakeAgentPort.
        // NOTE: The issue AC says "exactly two total" but that counts both the
        // original invocation (pre-extractResult) and the rerun. FakeAgentPort
        // only tracks calls made by extractResult, so the count here is 1.
        // See plan Assumption #7 for the rationale.
        expect(agent.invocations).toHaveLength(1);
        expect(agent.invocations[0].fallbackOfInvocationId).toBe(AgentInvocationId('inv-1'));
      } else {
        const agent = new FakeAgentPort();
        const outcome = await extractResult({
          invocation: makeInvocation({ phaseId: PhaseName(phase) }),
          ports: { artifacts, agent },
          rerunContext: RERUN_CTX,
        });
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) {
          expect(outcome.reason).toBe('missing');
        }
        expect(agent.invocations).toHaveLength(0);
      }
    });

    it('(c) still-invalid after rerun → ok:false, no third LLM call', async () => {
      const artifacts = new FakeArtifactStore();
      await artifacts.write({
        runId: 'r1',
        relativePath: 'result.json',
        contents: JSON.stringify(invalidJson),
      });
      if (retrySafe) {
        const agent = new FakeAgentPort({
          p: [
            (_req) => {
              void artifacts.write({
                runId: 'r1',
                relativePath: 'result.json',
                contents: JSON.stringify(invalidJson),
              });
              return {
                runtime: 'opencode' as const,
                provider: 'a',
                model: 'm',
                exitCode: 0,
                durationMs: 500,
                stdoutPath: '/s2',
                stderrPath: '/e2',
                resultJsonPath: 'result.json',
                contractViolations: [],
                outcome: 'success' as const,
              };
            },
          ],
        });
        const outcome = await extractResult({
          invocation: makeInvocation({ phaseId: PhaseName(phase) }),
          ports: { artifacts, agent },
          rerunContext: RERUN_CTX,
        });
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) {
          expect(outcome.reason).toBe('invalid');
          expect(outcome.violationCode).toBe('invalid_result_json');
        }
        // extractResult calls agent.invoke ONCE for the rerun, then stops.
        // No third call is ever made.
        expect(agent.invocations).toHaveLength(1);
      } else {
        const agent = new FakeAgentPort();
        const outcome = await extractResult({
          invocation: makeInvocation({ phaseId: PhaseName(phase) }),
          ports: { artifacts, agent },
          rerunContext: RERUN_CTX,
        });
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) {
          expect(outcome.reason).toBe('invalid');
          expect(outcome.violationCode).toBe('invalid_result_json');
        }
        // No rerun for retrySafe:false phases.
        expect(agent.invocations).toHaveLength(0);
      }
    });

    it('(d) retrySafe=false → fail immediately, no rerun', async () => {
      if (!retrySafe) {
        const artifacts = new FakeArtifactStore();
        await artifacts.write({
          runId: 'r1',
          relativePath: 'result.json',
          contents: JSON.stringify(invalidJson),
        });
        const agent = new FakeAgentPort();
        const outcome = await extractResult({
          invocation: makeInvocation({ phaseId: PhaseName(phase) }),
          ports: { artifacts, agent },
          rerunContext: RERUN_CTX,
        });
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) {
          expect(outcome.reason).toBe('invalid');
          expect(outcome.violationCode).toBe('invalid_result_json');
        }
        expect(agent.invocations).toHaveLength(0);
      }
      // retrySafe:true phases are tested in branch (c) above; skip here to avoid
      // FakeAgentPort throwing "No scripted response" when invoke is called unscripted.
    });
  });

  it('retrySafe phase without rerunContext returns initial failure, no rerun attempted', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: 'r1',
      relativePath: 'result.json',
      contents: '{"bad": "shape"}',
    });
    const agent = new FakeAgentPort();
    const outcome = await extractResult({
      invocation: makeInvocation(),
      ports: { artifacts, agent },
    });
    expect(outcome).toEqual({
      ok: false,
      reason: 'invalid',
      detail: expect.any(String),
      violationCode: 'invalid_result_json',
    });
    expect(agent.invocations).toHaveLength(0);
  });

  it('returns missing when resultJsonPath is not set', async () => {
    const artifacts = new FakeArtifactStore();
    const agent = new FakeAgentPort();
    const outcome = await extractResult({
      invocation: makeInvocation({ resultJsonPath: undefined }),
      ports: { artifacts, agent },
      rerunContext: RERUN_CTX,
    });
    expect(outcome).toEqual({
      ok: false,
      reason: 'missing',
      detail: 'no resultJsonPath provided',
      violationCode: 'invalid_result_json',
    });
    expect(agent.invocations).toHaveLength(0);
  });

  it('returns missing with detail when artifact not found in store', async () => {
    const artifacts = new FakeArtifactStore();
    const agent = new FakeAgentPort();
    const outcome = await extractResult({
      invocation: makeInvocation({ phaseId: PhaseName('implement') }),
      ports: { artifacts, agent },
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('missing');
      expect(outcome.detail).toBe('artifact not found: result.json in run r1');
      expect(outcome.violationCode).toBe('invalid_result_json');
    }
    expect(agent.invocations).toHaveLength(0);
  });

  describe('caller-side violation recording', () => {
    it('caller can record violation on the invocation after extractResult returns failure', async () => {
      const artifacts = new FakeArtifactStore();
      await artifacts.write({
        runId: 'r1',
        relativePath: 'result.json',
        contents: '{"bad": "shape"}',
      });
      const agent = new FakeAgentPort();
      const invocation = makeInvocation({ phaseId: PhaseName('implement') });
      const outcome = await extractResult({
        invocation,
        ports: { artifacts, agent },
        rerunContext: RERUN_CTX,
      });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        const existing = invocation.contractViolations ?? [];
        invocation.contractViolations = [...existing, outcome.violationCode];
      }
      expect(invocation.contractViolations).toContain('invalid_result_json');
    });
  });
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, '__fixtures__', 'result-json');

describe('fixture files validate against their phase schemas', () => {
  const phases = readdirSync(FIXTURE_DIR);
  for (const phase of phases) {
    it(`${phase}/valid.json passes its schema`, () => {
      const raw = readFileSync(join(FIXTURE_DIR, phase, 'valid.json'), 'utf-8');
      const parsed = JSON.parse(raw);
      const meta = PHASE_RESULT_REGISTRY[phase];
      expect(meta, `phase '${phase}' must exist in PHASE_RESULT_REGISTRY`).toBeDefined();
      const result = meta.schema.safeParse(parsed);
      expect(
        result.success,
        `fixture for '${phase}' must validate: ${result.success ? '' : (result as { error: { message: string } }).error.message}`,
      ).toBe(true);
    });
  }
});
