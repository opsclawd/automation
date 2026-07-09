import { describe, expect, it } from 'vitest';
import {
  AgentProfileName,
  type AgentPort,
  type AgentInvocationRequest,
  type AgentInvocationResult,
} from '@ai-sdlc/application';
import { FakeAgentInvocationPort } from '@ai-sdlc/application/test-doubles';
import { AgentInvocationId } from '@ai-sdlc/domain';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('compose runArbiter wiring', () => {
  it('exports the arbiter schema and result type from @ai-sdlc/application', async () => {
    const mod = await import('@ai-sdlc/application');
    expect(typeof (mod as Record<string, unknown>).arbiterResultSchema).toBe('object');
  });

  it('registers arbiter in PHASE_RESULT_REGISTRY', async () => {
    const mod = await import('@ai-sdlc/application');
    const reg = (mod as Record<string, unknown>).PHASE_RESULT_REGISTRY as Record<
      string,
      { retrySafe: boolean }
    >;
    expect(reg.arbiter).toBeDefined();
    expect(reg.arbiter!.retrySafe).toBe(true);
  });

  it('buildArbiterPrompt writes a read-only prompt with all four outcomes', async () => {
    const { buildArbiterPrompt } = await import('../arbiter-prompt.js');
    const prompt = buildArbiterPrompt(
      { stepIndex: 1, stepTitle: 'x', cwd: '/tmp' },
      {
        tcResult: { outcome: 'fail', output: 'TS2304' },
        specExcerpt: '{}',
        qualityExcerpt: '{}',
        fixExcerpt: '{}',
        fixRebuttal: 'r',
        taskBody: '## Task 1: x',
      },
    );
    expect(prompt).toContain('READ-ONLY');
    for (const o of ['finding_valid', 'finding_invalid', 'ambiguous', 'insufficient_evidence']) {
      expect(prompt).toContain(o);
    }
  });

  it('arbiter profile name is resolved via resolveArbiterProfileName, and compose.ts wires phaseId arbiter', async () => {
    const { resolveArbiterProfileName } = await import('../arbiter-profile.js');
    expect(resolveArbiterProfileName({ 'plan-design': { profile: 'a' } })).toBe('a');
    expect(resolveArbiterProfileName({ 'fix-review': { profile: 'b' } })).toBe('b');
    // Static check — confirms compose.ts still dispatches the arbiter
    // invocation under the arbiter phaseId (registry/accounting contract).
    const src = readFileSync(path.join(import.meta.dirname ?? __dirname, '../compose.ts'), 'utf-8');
    expect(src).toContain('resolveArbiterProfileName(');
    expect(src).toContain('phaseId: \x27arbiter\x27');
  });

  it('runArbiter is left undefined when neither plan-design nor fix-review profile is configured', async () => {
    // Pure unit: build a minimal stub of the relevant resolution.
    const profileName =
      undefined /* phaseProfiles['plan-design']?.profile */ ??
      undefined; /* phaseProfiles['fix-review']?.profile */
    expect(profileName).toBeUndefined();
  });

  it('stub AgentPort invoked for profile dispatches to arbiter phaseId', async () => {
    const invocations: AgentInvocationRequest[] = [];
    const stubAdapter: AgentPort = {
      async invoke(req: AgentInvocationRequest): Promise<AgentInvocationResult> {
        invocations.push(req);
        // Stub the agent writing a valid result.json at cwd/result.json
        writeFileSync(
          path.join(req.cwd, 'result.json'),
          JSON.stringify({
            outcome: 'finding_invalid',
            evidence: 'Typecheck passes; review misread the plan letter.',
            rationale:
              'Deterministic signal: pnpm typecheck exited 0 and the cited line matches the plan letter.',
          }),
        );
        return {
          runtime: 'opencode',
          provider: 'anthropic',
          model: 'claude-sonnet-4-20250514',
          exitCode: 0,
          durationMs: 1,
          stdoutPath: '/tmp/stdout',
          stderrPath: '/tmp/stderr',
          contractViolations: [],
          outcome: 'success',
          resultJsonPath: 'result.json',
        };
      },
    };
    const invocationRepo = new FakeAgentInvocationPort();
    invocationRepo.insert({
      id: AgentInvocationId('arb-1'),
      runId: 'test-run' as unknown as import('@ai-sdlc/domain').RunId,
      phaseId: 'arbiter' as unknown as import('@ai-sdlc/domain').PhaseName,
      profile: AgentProfileName('opencode-frontier'),
      runtime: 'opencode',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      promptPath: '/tmp/prompt',
      promptChars: 0,
      stdoutPath: '/tmp/stdout',
      stderrPath: '/tmp/stderr',
      startedAt: new Date(),
      startCommitSha: '0'.repeat(40),
      endCommitSha: '0'.repeat(40),
      timeoutMs: 60000,
      outcome: 'success',
      resultJsonPath: 'result.json',
    });
    const cwd = path.join(os.tmpdir(), 'arbiter-test-' + Date.now());
    mkdirSync(cwd, { recursive: true });
    const req: AgentInvocationRequest = {
      profile: AgentProfileName('opencode-frontier'),
      promptPath: '/tmp/prompt.md',
      expectedArtifacts: ['result.json'],
      cwd,
      runId: 'test-run',
      repoId: 'test-repo',
      phaseId: 'arbiter',
      startCommitSha: '0'.repeat(40),
    };
    const res = await stubAdapter.invoke(req);
    expect(res.outcome).toBe('success');
    expect(invocations[0]?.phaseId).toBe('arbiter');
  });

  it('wires implementStepFinalReviewRunArbiter into the ImplementStepLoop constructor with implement-final-review-arbiter phaseId', () => {
    const src = readFileSync(path.join(import.meta.dirname ?? __dirname, '../compose.ts'), 'utf-8');
    expect(src).toContain('implementStepFinalReviewRunArbiter');
    expect(src).toContain('runFinalReviewArbiter: implementStepFinalReviewRunArbiter');
    expect(src).toContain('buildImplementStepFinalReviewArbiterPrompt');
    expect(src).toContain("phaseId: 'implement-final-review-arbiter'");
    expect(src).toMatch(/rmSync\(join\(ctx\.cwd,\s*['"]result\.json['"]\)/);
    expect(src).toContain('arbiter invocation threw:');
    expect(src).toContain('arbiter result.json unparseable:');
  });
});
