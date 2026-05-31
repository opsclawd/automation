import { describe, it, expect } from 'vitest';
import { AgentProfileName, RunId } from '@ai-sdlc/domain';
import { FakeAgentInvocationPort } from '@ai-sdlc/application/test-doubles';
import type { AgentPort } from '@ai-sdlc/application/ports';
import type { AgentInvocationRequest, AgentInvocationResult } from '@ai-sdlc/application/ports';
import { type AgentConfig } from '@ai-sdlc/shared';
import { AgentRuntimeRouter } from '../agent-runtime-router.js';

function cfg(): AgentConfig {
  return {
    defaultProfile: 'opencode-frontier',
    profiles: {
      'opencode-frontier': {
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'm',
        timeoutMinutes: 1,
      },
      'pi-local': {
        runtime: 'pi',
        provider: 'local',
        model: 'q',
        timeoutMinutes: 5,
      },
    },
    phaseProfiles: {
      'plan-design': { profile: 'opencode-frontier', fallbackProfile: 'pi-local' },
    },
  };
}

function req(overrides: Partial<AgentInvocationRequest> = {}): AgentInvocationRequest {
  return {
    profile: AgentProfileName('opencode-frontier'),
    promptPath: '/tmp/prompt.md',
    expectedArtifacts: [],
    cwd: '/tmp',
    runId: '00000000-0000-0000-0000-000000000001',
    repoId: 'r1',
    phaseId: 'plan-design',
    startCommitSha: 'a'.repeat(40),
    ...overrides,
  };
}

const FIXED_NOW = new Date('2026-05-22T12:00:00.000Z');

describe('AgentRuntimeRouter fallback timeout signal', () => {
  it('fallback runs to completion when primary times out and caller signal is already aborted', async () => {
    const inv = new FakeAgentInvocationPort();
    let fallbackSignal: AbortSignal | undefined;

    const primaryAdapter: AgentPort = {
      async invoke(_: AgentInvocationRequest): Promise<AgentInvocationResult> {
        return {
          runtime: 'opencode',
          provider: 'anthropic',
          model: 'm',
          exitCode: 0,
          durationMs: 60000,
          stdoutPath: '/s',
          stderrPath: '/e',
          contractViolations: [],
          outcome: 'timeout',
        };
      },
    };

    const fallbackAdapter: AgentPort = {
      async invoke(r: AgentInvocationRequest): Promise<AgentInvocationResult> {
        fallbackSignal = r.abortSignal;
        return {
          runtime: 'pi',
          provider: 'local',
          model: 'q',
          exitCode: 0,
          durationMs: 120000,
          stdoutPath: '/s',
          stderrPath: '/e',
          contractViolations: [],
          outcome: 'success',
        };
      },
    };

    const alreadyAborted = AbortSignal.timeout(0);

    const router = new AgentRuntimeRouter({
      agent: cfg(),
      adapters: { opencode: primaryAdapter, pi: fallbackAdapter },
      invocationRepository: inv,
      clock: () => FIXED_NOW,
      idFactory: () => 'inv-timeout-signal-1',
      readPromptChars: () => 100,
    });

    const result = await router.invoke(req({ abortSignal: alreadyAborted }));

    expect(result.outcome).toBe('success');
    expect(result.durationMs).toBe(120000);

    expect(fallbackSignal).toBeDefined();
    expect(fallbackSignal!.aborted).toBe(false);

    const rows = inv.listByRun(RunId('00000000-0000-0000-0000-000000000001'));
    expect(rows.length).toBe(2);
    expect(rows[0].outcome).toBe('timeout');
    expect(rows[1].outcome).toBe('success');
    expect(rows[1].fallbackOfInvocationId).toBeDefined();
  });

  it('fallback effective timeout derives from fallback profile, not residual caller budget', async () => {
    const inv = new FakeAgentInvocationPort();

    const primaryAdapter: AgentPort = {
      async invoke(_: AgentInvocationRequest): Promise<AgentInvocationResult> {
        return {
          runtime: 'opencode',
          provider: 'anthropic',
          model: 'm',
          exitCode: 0,
          durationMs: 60000,
          stdoutPath: '/s',
          stderrPath: '/e',
          contractViolations: [],
          outcome: 'timeout',
        };
      },
    };

    const fallbackAdapter: AgentPort = {
      async invoke(_: AgentInvocationRequest): Promise<AgentInvocationResult> {
        return {
          runtime: 'pi',
          provider: 'local',
          model: 'q',
          exitCode: 0,
          durationMs: 180000,
          stdoutPath: '/s',
          stderrPath: '/e',
          contractViolations: [],
          outcome: 'success',
        };
      },
    };

    const alreadyAborted = AbortSignal.timeout(0);

    const router = new AgentRuntimeRouter({
      agent: cfg(),
      adapters: { opencode: primaryAdapter, pi: fallbackAdapter },
      invocationRepository: inv,
      clock: () => FIXED_NOW,
      idFactory: () => 'inv-timeout-signal-2',
      readPromptChars: () => 100,
    });

    await router.invoke(req({ abortSignal: alreadyAborted }));

    const rows = inv.listByRun(RunId('00000000-0000-0000-0000-000000000001'));
    expect(rows.length).toBe(2);

    expect(rows[0].timeoutMs).toBe(1 * 60_000);
    expect(rows[1].timeoutMs).toBe(5 * 60_000);
  });
});
