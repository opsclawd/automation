import { describe, it, expect } from 'vitest';
import { RunId, PhaseName, AgentProfileName } from '@ai-sdlc/domain';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import { FakeLoopRepository } from '../../test-doubles/fake-loop-repository.js';
import { ValidateFixLoop } from '../validate-fix-loop.js';
import type {
  ValidateFixLoopDeps,
  ValidateFixAgentResult,
  ValidateFixStepContext,
} from '../types.js';
import type { RevalidationResult, FixStepOptions } from '../../review-fix/types.js';

function collectEvents() {
  const events: Array<{ type: string; metadata: Record<string, unknown> }> = [];
  const bus = {
    publish: (_runUuid: string, e: OrchestratorEvent) =>
      events.push({ type: e.type, metadata: e.metadata }),
    subscribe: () => () => {},
  };
  return { events, bus };
}

function baseInput() {
  return {
    runId: RunId('run-1'),
    phaseId: PhaseName('fix-validate'),
    repoId: 'owner/repo',
    cwd: '/wt',
    maxIterations: 3,
    fixProfile: AgentProfileName('opencode-frontier'),
    fixFallbackProfile: AgentProfileName('pi-qwen-local'),
  };
}

function makeDeps(over: Partial<ValidateFixLoopDeps>): ValidateFixLoopDeps {
  let n = 0;
  const { bus } = collectEvents();
  return {
    runFix: async (): Promise<ValidateFixAgentResult> => ({
      invocationId: `fix-${++n}`,
      agentOutcome: 'success',
      verdict: 'fixed',
    }),
    runRevalidation: async (): Promise<RevalidationResult> => ({
      validationRunId: `val-${++n}`,
      passed: true,
    }),
    loops: new FakeLoopRepository(),
    events: bus,
    now: () => new Date('2026-06-26T00:00:00.000Z'),
    idFactory: () => 'loop-1',
    ...over,
  };
}

describe('ValidateFixLoop', () => {
  it('converges on iteration 1 when revalidation passes immediately', async () => {
    const deps = makeDeps({});
    const out = await new ValidateFixLoop(deps).execute(baseInput());
    expect(out.phaseOutcome).toBe('passed');
    expect(out.loop.status).toBe('converged');
    expect(out.loop.iterations).toHaveLength(1);
    expect(out.loop.iterations[0]?.outcome).toBe('resolved');
  });

  it('converges on iteration 2 (fix fails -> fix passes + reval passes)', async () => {
    let fixCalls = 0;
    const deps = makeDeps({
      runFix: async () => {
        fixCalls += 1;
        return {
          invocationId: `fix-${fixCalls}`,
          agentOutcome: 'success' as const,
          verdict: fixCalls === 1 ? ('cannot_fix' as const) : ('fixed' as const),
        };
      },
    });
    const out = await new ValidateFixLoop(deps).execute(baseInput());
    expect(out.phaseOutcome).toBe('passed');
    expect(out.loop.iterations).toHaveLength(2);
    expect(out.loop.iterations[0]?.outcome).toBe('fix_failed');
    expect(out.loop.iterations[1]?.outcome).toBe('resolved');
  });

  it('exhausts and fails when fix never succeeds', async () => {
    const { events, bus } = collectEvents();
    const deps = makeDeps({
      events: bus,
      runFix: async () => ({ invocationId: 'f', agentOutcome: 'success', verdict: 'cannot_fix' }),
    });
    const out = await new ValidateFixLoop(deps).execute(baseInput());
    expect(out.phaseOutcome).toBe('failed');
    expect(out.loop.status).toBe('exhausted');
    expect(out.loop.iterations).toHaveLength(3);
    expect(events.filter((e) => e.type === 'loop.exhausted')).toHaveLength(1);
  });

  it('hard-fails when the fix agent itself fails', async () => {
    const deps = makeDeps({
      runFix: async () => ({ invocationId: 'f', agentOutcome: 'failed' as const }),
    });
    const out = await new ValidateFixLoop(deps).execute(baseInput());
    expect(out.phaseOutcome).toBe('failed');
    expect(out.loop.status).toBe('failed');
    expect(out.loop.iterations[0]?.outcome).toBe('failed');
  });

  it('escalates to fallback profile after two consecutive fix failures', async () => {
    const { events, bus } = collectEvents();
    const fixCalls: FixStepOptions[] = [];
    const deps = makeDeps({
      events: bus,
      runFix: async (_ctx: ValidateFixStepContext, opts: FixStepOptions) => {
        fixCalls.push(opts);
        return {
          invocationId: `fix-${fixCalls.length}`,
          agentOutcome: 'success' as const,
          verdict: 'cannot_fix' as const,
        };
      },
    });
    await new ValidateFixLoop(deps).execute({ ...baseInput(), maxIterations: 3 });
    expect(fixCalls[0]?.useFallback).toBe(false);
    expect(fixCalls[1]?.useFallback).toBe(false);
    expect(fixCalls[2]?.useFallback).toBe(true);
    const esc = events.filter((e) => e.type === 'phase.fallback.escalated');
    expect(esc).toHaveLength(1);
    expect(esc[0]?.metadata.triggerReason).toBe('two_consecutive_fix_failures');
  });

  it('calls rollbackFix when revalidation fails after a fix with headBeforeFix', async () => {
    const rollbackCalls: Array<{ targetSha: string }> = [];
    const deps = makeDeps({
      runFix: async () => ({
        invocationId: 'f',
        agentOutcome: 'success',
        verdict: 'fixed',
        headBeforeFix: 'abc123def',
      }),
      runRevalidation: async () => ({
        validationRunId: 'v',
        passed: false,
        category: 'test',
      }),
      rollbackFix: async (_ctx: ValidateFixStepContext, targetSha: string) => {
        rollbackCalls.push({ targetSha });
        return true;
      },
    });
    const out = await new ValidateFixLoop(deps).execute(baseInput());
    expect(rollbackCalls).toHaveLength(3);
    expect(rollbackCalls[0]?.targetSha).toBe('abc123def');
    expect(out.phaseOutcome).toBe('failed');
    expect(out.loop.status).toBe('exhausted');
  });

  it('does not call rollbackFix when revalidation passes', async () => {
    const rollbackCalls: Array<unknown> = [];
    const deps = makeDeps({
      runFix: async () => ({
        invocationId: 'f',
        agentOutcome: 'success',
        verdict: 'fixed',
        headBeforeFix: 'abc123def',
      }),
      rollbackFix: async () => {
        rollbackCalls.push('called');
        return true;
      },
    });
    await new ValidateFixLoop(deps).execute(baseInput());
    expect(rollbackCalls).toHaveLength(0);
  });

  it('continues when no_fixes_needed but revalidation fails, then exhausts', async () => {
    const deps = makeDeps({
      runFix: async () => ({
        invocationId: 'f',
        agentOutcome: 'success',
        verdict: 'no_fixes_needed' as const,
      }),
      runRevalidation: async () => ({
        validationRunId: 'v',
        passed: false,
        category: 'test',
      }),
    });
    const out = await new ValidateFixLoop(deps).execute(baseInput());
    expect(out.phaseOutcome).toBe('failed');
    expect(out.loop.status).toBe('exhausted');
    expect(out.loop.iterations).toHaveLength(3);
    out.loop.iterations.forEach((iter) => {
      expect(iter.outcome).toBe('unresolved');
    });
  });

  it('converges even after no_fixes_needed iterations when revalidation later passes', async () => {
    let callCount = 0;
    const deps = makeDeps({
      runFix: async () => {
        callCount += 1;
        return {
          invocationId: `f-${callCount}`,
          agentOutcome: 'success',
          verdict: 'no_fixes_needed' as const,
        };
      },
      runRevalidation: async () => {
        if (callCount < 3) return { validationRunId: 'v', passed: false, category: 'test' };
        return { validationRunId: 'v', passed: true };
      },
    });
    const out = await new ValidateFixLoop(deps).execute(baseInput());
    expect(out.phaseOutcome).toBe('passed');
    expect(out.loop.status).toBe('converged');
    expect(out.loop.iterations).toHaveLength(3);
  });

  it('hard-fails on undefined verdict and emits warning event', async () => {
    const { events, bus } = collectEvents();
    const deps = makeDeps({
      events: bus,
      runFix: async () => ({ invocationId: 'f', agentOutcome: 'success' as const }),
    });
    const out = await new ValidateFixLoop(deps).execute(baseInput());
    expect(out.phaseOutcome).toBe('failed');
    expect(out.loop.status).toBe('failed');
    expect(out.loop.iterations).toHaveLength(1);
    expect(out.loop.iterations[0]?.outcome).toBe('failed');
    const warnings = events.filter((e) => e.type === 'loop.verdict_missing');
    expect(warnings).toHaveLength(1);
  });

  it('rolls back on agent failure when headBeforeFix is set', async () => {
    const rollbackCalls: Array<{ targetSha: string }> = [];
    const deps = makeDeps({
      runFix: async () => ({
        invocationId: 'f',
        agentOutcome: 'failed' as const,
        headBeforeFix: 'abc123def',
      }),
      rollbackFix: async (_ctx: ValidateFixStepContext, targetSha: string) => {
        rollbackCalls.push({ targetSha });
        return true;
      },
    });
    const out = await new ValidateFixLoop(deps).execute(baseInput());
    expect(rollbackCalls).toHaveLength(1);
    expect(rollbackCalls[0]?.targetSha).toBe('abc123def');
    expect(out.phaseOutcome).toBe('failed');
    expect(out.loop.status).toBe('failed');
  });

  it('emits iteration started/completed events per iteration', async () => {
    const { events, bus } = collectEvents();
    const deps = makeDeps({ events: bus });
    await new ValidateFixLoop(deps).execute(baseInput());
    expect(events.filter((e) => e.type === 'loop.iteration.started')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'loop.iteration.completed')).toHaveLength(1);
  });
});
