import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { AgentInvocationId, AgentProfileName } from '@ai-sdlc/domain';
import { FakeAgentInvocationPort } from '@ai-sdlc/application/test-doubles';
import {
  type AgentPort,
  type AgentInvocationRequest,
  type AgentInvocationResult,
} from '@ai-sdlc/application';
import { ConfigError, type AgentConfig } from '@ai-sdlc/shared';
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
        timeoutMinutes: 1,
        contextLimitTokens: 64000,
      },
    },
    phaseProfiles: {
      'plan-design': { profile: 'opencode-frontier' },
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

class StubAdapter implements AgentPort {
  constructor(private readonly result: AgentInvocationResult) {}
  async invoke(_: AgentInvocationRequest): Promise<AgentInvocationResult> {
    return this.result;
  }
}

const FIXED_NOW = new Date('2026-05-22T12:00:00.000Z');

describe('AgentRuntimeRouter', () => {
  it('pre-inserts then updates the invocation row on success', async () => {
    const inv = new FakeAgentInvocationPort();
    const adapter = new StubAdapter({
      runtime: 'opencode',
      provider: 'anthropic',
      model: 'm',
      exitCode: 0,
      durationMs: 1234,
      stdoutPath: '/tmp/stdout.log',
      stderrPath: '/tmp/stderr.log',
      contractViolations: [],
      outcome: 'success',
    });
    const router = new AgentRuntimeRouter({
      agent: cfg(),
      adapters: { opencode: adapter },
      invocationRepository: inv,
      clock: () => FIXED_NOW,
      idFactory: () => 'inv-fixed',
      readPromptChars: () => 100,
    });
    const result = await router.invoke(req());
    expect(result.outcome).toBe('success');
    const row = inv.findById(AgentInvocationId('inv-fixed'));
    expect(row).toBeDefined();
    expect(row?.outcome).toBe('success');
    expect(row?.promptChars).toBe(100);
    expect(row?.runtime).toBe('opencode');
  });

  it('throws ConfigError on unknown profile', async () => {
    const router = new AgentRuntimeRouter({
      agent: cfg(),
      adapters: { opencode: new StubAdapter({} as unknown as AgentInvocationResult) },
      invocationRepository: new FakeAgentInvocationPort(),
      clock: () => FIXED_NOW,
      idFactory: () => randomUUID(),
      readPromptChars: () => 0,
    });
    await expect(
      router.invoke(req({ profile: AgentProfileName('does-not-exist') })),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it('throws ConfigError when no adapter registered for runtime', async () => {
    const router = new AgentRuntimeRouter({
      agent: cfg(),
      adapters: {},
      invocationRepository: new FakeAgentInvocationPort(),
      clock: () => FIXED_NOW,
      idFactory: () => randomUUID(),
      readPromptChars: () => 0,
    });
    await expect(router.invoke(req())).rejects.toBeInstanceOf(ConfigError);
  });

  it('records endCommitSha on the invocation row when adapter returns one', async () => {
    const inv = new FakeAgentInvocationPort();
    const adapter = new StubAdapter({
      runtime: 'opencode',
      provider: 'a',
      model: 'm',
      exitCode: 0,
      durationMs: 1,
      stdoutPath: '/s',
      stderrPath: '/e',
      contractViolations: [],
      outcome: 'success',
      endCommitSha: 'c'.repeat(40),
    });
    const router = new AgentRuntimeRouter({
      agent: cfg(),
      adapters: { opencode: adapter },
      invocationRepository: inv,
      clock: () => FIXED_NOW,
      idFactory: () => 'inv-y',
      readPromptChars: () => 1,
    });
    await router.invoke(req({ startCommitSha: 'a'.repeat(40) }));
    expect(inv.findById(AgentInvocationId('inv-y'))?.endCommitSha).toBe('c'.repeat(40));
  });

  it('passes abortSignal through to the adapter (composed with profile timeout)', async () => {
    const controller = new AbortController();
    let capturedSignal: AbortSignal | undefined;
    const adapter = {
      async invoke(req: AgentInvocationRequest): Promise<AgentInvocationResult> {
        capturedSignal = req.abortSignal;
        return {
          runtime: 'opencode',
          provider: 'a',
          model: 'm',
          exitCode: 0,
          durationMs: 1,
          stdoutPath: '/s',
          stderrPath: '/e',
          contractViolations: [],
          outcome: 'success',
        };
      },
    } satisfies AgentPort;
    const router = new AgentRuntimeRouter({
      agent: cfg(),
      adapters: { opencode: adapter },
      invocationRepository: new FakeAgentInvocationPort(),
      clock: () => FIXED_NOW,
      idFactory: () => 'inv-z',
      readPromptChars: () => 0,
    });
    await router.invoke(req({ abortSignal: controller.signal }));
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(false);
    controller.abort();
    expect(capturedSignal!.aborted).toBe(true);
  });

  it('reclassifies cancelled_by_orchestrator to timeout when profile timeout fired', async () => {
    const inv = new FakeAgentInvocationPort();
    const adapter = {
      async invoke(_req: AgentInvocationRequest): Promise<AgentInvocationResult> {
        await new Promise((r) => setTimeout(r, 10));
        return {
          runtime: 'opencode',
          provider: 'a',
          model: 'm',
          exitCode: 0,
          durationMs: 1,
          stdoutPath: '/s',
          stderrPath: '/e',
          contractViolations: ['cancelled_by_orchestrator'],
          outcome: 'failed',
        };
      },
    } satisfies AgentPort;
    const router = new AgentRuntimeRouter({
      agent: {
        defaultProfile: 'opencode-frontier',
        profiles: {
          'opencode-frontier': {
            runtime: 'opencode',
            provider: 'a',
            model: 'm',
            timeoutMinutes: 0.0001,
          },
        },
        phaseProfiles: {},
      },
      adapters: { opencode: adapter },
      invocationRepository: inv,
      clock: () => FIXED_NOW,
      idFactory: () => 'inv-timeout',
      readPromptChars: () => 0,
    });
    const r = await router.invoke(req());
    expect(r.outcome).toBe('timeout');
    expect(r.contractViolations).toEqual([]);
    const row = inv.findById(AgentInvocationId('inv-timeout'));
    expect(row?.outcome).toBe('timeout');
  });

  it('works with only opencode registered (pi is optional)', async () => {
    const inv = new FakeAgentInvocationPort();
    const router = new AgentRuntimeRouter({
      agent: cfg(),
      adapters: {
        opencode: new StubAdapter({
          runtime: 'opencode',
          provider: 'anthropic',
          model: 'm',
          exitCode: 0,
          durationMs: 1,
          stdoutPath: '/s',
          stderrPath: '/e',
          contractViolations: [],
          outcome: 'success',
        }),
      },
      invocationRepository: inv,
      clock: () => FIXED_NOW,
      idFactory: () => 'inv-x',
      readPromptChars: () => 1,
    });
    const r = await router.invoke(req());
    expect(r.outcome).toBe('success');
  });
});
