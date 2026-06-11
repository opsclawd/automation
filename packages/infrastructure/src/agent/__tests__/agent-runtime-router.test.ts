import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { AgentInvocationId, AgentProfileName } from '@ai-sdlc/domain';
import { FakeAgentInvocationPort } from '@ai-sdlc/application/test-doubles';
import type { AgentPort } from '@ai-sdlc/application/ports';
import type { AgentInvocationRequest, AgentInvocationResult } from '@ai-sdlc/application/ports';
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

  it('uses request.timeoutMs when provided, overriding profile timeout', async () => {
    const inv = new FakeAgentInvocationPort();
    const adapter = {
      async invoke(_req: AgentInvocationRequest): Promise<AgentInvocationResult> {
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
      invocationRepository: inv,
      clock: () => FIXED_NOW,
      idFactory: () => 'inv-timeout-override',
      readPromptChars: () => 0,
    });
    await router.invoke(req({ timeoutMs: 900_000 }));
    const row = inv.findById(AgentInvocationId('inv-timeout-override'));
    expect(row?.timeoutMs).toBe(900_000);
  });

  it('falls back to profile timeout when request.timeoutMs is undefined', async () => {
    const inv = new FakeAgentInvocationPort();
    const router = new AgentRuntimeRouter({
      agent: cfg(),
      adapters: {
        opencode: new StubAdapter({
          runtime: 'opencode',
          provider: 'a',
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
      idFactory: () => 'inv-no-override',
      readPromptChars: () => 0,
    });
    await router.invoke(req());
    const row = inv.findById(AgentInvocationId('inv-no-override'));
    // profile timeoutMinutes is 1 → 60_000 ms
    expect(row?.timeoutMs).toBe(60_000);
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

  it('overrides provider and model from env vars on invocation row', async () => {
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
      idFactory: () => 'inv-override',
      readPromptChars: () => 100,
      env: { AI_AGENT_PROVIDER: 'opencode-go', AI_AGENT_MODEL: 'glm-5.1' },
    });
    await router.invoke(req());
    const row = inv.findById(AgentInvocationId('inv-override'));
    expect(row?.provider).toBe('opencode-go');
    expect(row?.model).toBe('glm-5.1');
  });

  it('adapter receives effective provider and model from env vars', async () => {
    let captured: AgentInvocationRequest | undefined;
    const capturingAdapter = {
      async invoke(req: AgentInvocationRequest): Promise<AgentInvocationResult> {
        captured = req;
        return {
          runtime: 'opencode',
          provider: 'opencode-go',
          model: 'glm-5.1',
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
      adapters: { opencode: capturingAdapter },
      invocationRepository: new FakeAgentInvocationPort(),
      clock: () => FIXED_NOW,
      idFactory: () => 'inv-cap',
      readPromptChars: () => 100,
      env: { AI_AGENT_PROVIDER: 'opencode-go', AI_AGENT_MODEL: 'glm-5.1' },
    });
    await router.invoke(req());
    expect(captured).toBeDefined();
    expect(captured!.provider).toBe('opencode-go');
    expect(captured!.model).toBe('glm-5.1');
  });

  it('overrides only model when AI_AGENT_MODEL is set (provider from profile)', async () => {
    const inv = new FakeAgentInvocationPort();
    const adapter = new StubAdapter({
      runtime: 'opencode',
      provider: 'anthropic',
      model: 'glm-5.1',
      exitCode: 0,
      durationMs: 1,
      stdoutPath: '/s',
      stderrPath: '/e',
      contractViolations: [],
      outcome: 'success',
    });
    const router = new AgentRuntimeRouter({
      agent: cfg(),
      adapters: { opencode: adapter },
      invocationRepository: inv,
      clock: () => FIXED_NOW,
      idFactory: () => 'inv-only-model',
      readPromptChars: () => 1,
      env: { AI_AGENT_MODEL: 'glm-5.1' },
    });
    await router.invoke(req());
    const row = inv.findById(AgentInvocationId('inv-only-model'));
    expect(row?.provider).toBe('anthropic');
    expect(row?.model).toBe('glm-5.1');
  });

  it('overrides only provider when AI_AGENT_PROVIDER is set (model from profile)', async () => {
    const inv = new FakeAgentInvocationPort();
    const adapter = new StubAdapter({
      runtime: 'opencode',
      provider: 'opencode-go',
      model: 'm',
      exitCode: 0,
      durationMs: 1,
      stdoutPath: '/s',
      stderrPath: '/e',
      contractViolations: [],
      outcome: 'success',
    });
    const router = new AgentRuntimeRouter({
      agent: cfg(),
      adapters: { opencode: adapter },
      invocationRepository: inv,
      clock: () => FIXED_NOW,
      idFactory: () => 'inv-only-provider',
      readPromptChars: () => 1,
      env: { AI_AGENT_PROVIDER: 'opencode-go' },
    });
    await router.invoke(req());
    const row = inv.findById(AgentInvocationId('inv-only-provider'));
    expect(row?.provider).toBe('opencode-go');
    expect(row?.model).toBe('m');
  });

  it('returns effective values from router result when env vars override', async () => {
    const adapter = new StubAdapter({
      runtime: 'opencode',
      provider: 'opencode-go',
      model: 'glm-5.1',
      exitCode: 0,
      durationMs: 1,
      stdoutPath: '/s',
      stderrPath: '/e',
      contractViolations: [],
      outcome: 'success',
    });
    const router = new AgentRuntimeRouter({
      agent: cfg(),
      adapters: { opencode: adapter },
      invocationRepository: new FakeAgentInvocationPort(),
      clock: () => FIXED_NOW,
      idFactory: () => 'inv-result',
      readPromptChars: () => 1,
      env: { AI_AGENT_PROVIDER: 'opencode-go', AI_AGENT_MODEL: 'glm-5.1' },
    });
    const result = await router.invoke(req());
    expect(result.provider).toBe('opencode-go');
    expect(result.model).toBe('glm-5.1');
  });

  it('treats blank AI_AGENT_MODEL as unset (falls through to profile default)', async () => {
    const inv = new FakeAgentInvocationPort();
    const adapter = new StubAdapter({
      runtime: 'opencode',
      provider: 'anthropic',
      model: 'm',
      exitCode: 0,
      durationMs: 1,
      stdoutPath: '/s',
      stderrPath: '/e',
      contractViolations: [],
      outcome: 'success',
    });
    const router = new AgentRuntimeRouter({
      agent: cfg(),
      adapters: { opencode: adapter },
      invocationRepository: inv,
      clock: () => FIXED_NOW,
      idFactory: () => 'inv-blank',
      readPromptChars: () => 1,
      env: { AI_AGENT_PROVIDER: '', AI_AGENT_MODEL: '   ' },
    });
    await router.invoke(req());
    const row = inv.findById(AgentInvocationId('inv-blank'));
    expect(row?.provider).toBe('anthropic');
    expect(row?.model).toBe('m');
  });

  it('passes promptBudgetTokens and runtimeHints from profile to adapter for pi runtime', async () => {
    let captured: AgentInvocationRequest | undefined;
    const capturingAdapter = {
      async invoke(req: AgentInvocationRequest): Promise<AgentInvocationResult> {
        captured = req;
        return {
          runtime: 'pi',
          provider: 'local',
          model: 'q',
          exitCode: 0,
          durationMs: 1,
          stdoutPath: '/s',
          stderrPath: '/e',
          contractViolations: [],
          outcome: 'success',
        };
      },
    } satisfies AgentPort;
    const inv = new FakeAgentInvocationPort();
    const router = new AgentRuntimeRouter({
      agent: {
        defaultProfile: 'pi-local',
        profiles: {
          'pi-local': {
            runtime: 'pi',
            provider: 'local',
            model: 'q',
            timeoutMinutes: 1,
            contextLimitTokens: 64000,
            promptBudgetTokens: 8000,
            outputBudgetTokens: 4000,
          },
        },
        phaseProfiles: {},
      },
      adapters: { pi: capturingAdapter },
      invocationRepository: inv,
      clock: () => FIXED_NOW,
      idFactory: () => 'inv-hints',
      readPromptChars: () => 100,
    });
    await router.invoke(req({ profile: AgentProfileName('pi-local') }));
    expect(captured).toBeDefined();
    expect(captured!.promptBudgetTokens).toBe(8000);
    expect(captured!.runtimeHints).toEqual({
      contextLimitTokens: 64000,
      outputBudgetTokens: 4000,
    });
  });
});
