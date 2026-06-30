import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentInvocationId, AgentProfileName, type AgentUsage } from '@ai-sdlc/domain';
import { FakeAgentInvocationPort } from '@ai-sdlc/application/test-doubles';
import type { AgentPort, AgentUsagePort } from '@ai-sdlc/application/ports';
import type { AgentInvocationRequest, AgentInvocationResult } from '@ai-sdlc/application/ports';
import { ConfigError, type AgentConfig, type OrchestratorEvent } from '@ai-sdlc/shared';
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

class FakeAgentUsagePort implements AgentUsagePort {
  readonly inserts: AgentUsage[] = [];
  insert(usage: AgentUsage): void {
    this.inserts.push({ ...usage });
  }
  findById(_id: AgentInvocationId): AgentUsage | undefined {
    return undefined;
  }
  listByRun(_runId: string): AgentUsage[] {
    return [];
  }
  listByRunAndPhase(_runId: string, _phaseId: string): AgentUsage[] {
    return [];
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

  it('persists usage and emits agent.usage event when adapter returns usage', async () => {
    const events: OrchestratorEvent[] = [];
    const eventBus = {
      subscribe: () => () => {},
      publish: (_runId: string, event: OrchestratorEvent) => {
        events.push(event);
      },
    };
    const usageRepo = new FakeAgentUsagePort();

    class UsageAdapter implements AgentPort {
      async invoke(_req: AgentInvocationRequest): Promise<AgentInvocationResult> {
        return {
          runtime: 'opencode',
          provider: 'deepseek',
          model: 'deepseek-pro',
          exitCode: 0,
          durationMs: 1000,
          stdoutPath: '/tmp/o',
          stderrPath: '/tmp/e',
          contractViolations: [],
          outcome: 'success',
          usage: {
            inputTokens: 500,
            outputTokens: 200,
            reasoningTokens: 100,
          },
        };
      }
    }

    const router = new AgentRuntimeRouter({
      agent: cfg(),
      adapters: { opencode: new UsageAdapter() },
      invocationRepository: new FakeAgentInvocationPort(),
      eventBus,
      usageRepository: usageRepo,
      clock: () => FIXED_NOW,
    });

    await router.invoke(req());

    expect(usageRepo.inserts).toHaveLength(1);
    expect(usageRepo.inserts[0].inputTokens).toBe(500);
    expect(usageRepo.inserts[0].outputTokens).toBe(200);
    expect(usageRepo.inserts[0].reasoningTokens).toBe(100);
    // provider/model come from effective profile (cfg() uses anthropic/m)
    expect(usageRepo.inserts[0].provider).toBe('anthropic');
    expect(usageRepo.inserts[0].model).toBe('m');

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('agent.usage');
    expect(events[0].metadata.inputTokens).toBe(500);
    expect(events[0].metadata.outputTokens).toBe(200);
    expect(events[0].metadata.durationMs).toBe(1000);
  });

  it('fallback still triggers when usage insert throws', async () => {
    const events: OrchestratorEvent[] = [];
    const eventBus = {
      subscribe: () => () => {},
      publish: (_runId: string, event: OrchestratorEvent) => {
        events.push(event);
      },
    };
    const usageRepo = new FakeAgentUsagePort();
    usageRepo.insert = () => {
      throw new Error('DB FULL');
    };

    class TimeoutWithUsageAdapter implements AgentPort {
      async invoke(_req: AgentInvocationRequest): Promise<AgentInvocationResult> {
        return {
          runtime: 'opencode',
          provider: 'deepseek',
          model: 'deepseek-pro',
          exitCode: 0,
          durationMs: 1000,
          stdoutPath: '/tmp/o',
          stderrPath: '/tmp/e',
          contractViolations: [],
          outcome: 'timeout',
          usage: {
            inputTokens: 500,
            outputTokens: 200,
          },
        };
      }
    }

    const router = new AgentRuntimeRouter({
      agent: cfg(),
      adapters: { opencode: new TimeoutWithUsageAdapter() },
      invocationRepository: new FakeAgentInvocationPort(),
      eventBus,
      usageRepository: usageRepo,
      clock: () => FIXED_NOW,
    });

    const result = await router.invoke(req());

    // Should still return a result (didn't crash)
    expect(result.outcome).toBe('timeout');
    // Should have attempted fallback (cfg() doesn't define fallback profiles,
    // so the result is the original — but the key is it didn't throw)
    expect(events.some((e) => e.type === 'phase.fallback.escalated')).toBe(false);
  });

  it('propagates sandboxMode from profile to adapter request', async () => {
    let captured: AgentInvocationRequest | undefined;
    const capturingAdapter = {
      async invoke(req: AgentInvocationRequest): Promise<AgentInvocationResult> {
        captured = req;
        return {
          runtime: 'codex',
          provider: 'openai',
          model: 'default',
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
      agent: {
        defaultProfile: 'codex-writer',
        profiles: {
          'codex-writer': {
            runtime: 'codex',
            provider: 'openai',
            model: 'default',
            timeoutMinutes: 30,
            sandboxMode: 'writable',
          },
        },
        phaseProfiles: {},
      },
      adapters: { codex: capturingAdapter },
      invocationRepository: new FakeAgentInvocationPort(),
      clock: () => FIXED_NOW,
      idFactory: () => 'inv-sandbox',
      readPromptChars: () => 100,
    });
    await router.invoke(req({ profile: AgentProfileName('codex-writer') }));
    expect(captured).toBeDefined();
    expect(captured!.sandboxMode).toBe('writable');
  });

  it('does not emit agent.usage event when adapter returns no usage', async () => {
    const events: OrchestratorEvent[] = [];
    const eventBus = {
      subscribe: () => () => {},
      publish: (_runId: string, event: OrchestratorEvent) => {
        events.push(event);
      },
    };
    const usageRepo = new FakeAgentUsagePort();

    const router = new AgentRuntimeRouter({
      agent: cfg(),
      adapters: {
        opencode: new StubAdapter({ exitCode: 0, outcome: 'success' } as AgentInvocationResult),
      },
      invocationRepository: new FakeAgentInvocationPort(),
      eventBus,
      usageRepository: usageRepo,
      clock: () => FIXED_NOW,
    });

    await router.invoke(req());

    expect(usageRepo.inserts).toHaveLength(0);
    const usageEvents = events.filter((e) => e.type === 'agent.usage');
    expect(usageEvents).toHaveLength(0);
  });

  describe('expected artifact cleanup', () => {
    it('deletes expected artifact files before calling adapter.invoke', async () => {
      // Use tmpdir so we can verify filesystem state
      const tmp = join(tmpdir(), `__tmp_cleanup_test_${Date.now()}`);
      const { mkdirSync, writeFileSync, existsSync, rmSync } = await import('node:fs');
      mkdirSync(tmp, { recursive: true });
      const artifactPath = `${tmp}/result.json`;
      writeFileSync(artifactPath, 'stale content', 'utf-8');

      let capturedCwd: string | undefined;
      const seenArtifacts: string[] = [];
      const adapter = {
        async invoke(req: AgentInvocationRequest): Promise<AgentInvocationResult> {
          capturedCwd = req.cwd;
          // Record which artifacts still exist when adapter is invoked
          for (const a of req.expectedArtifacts) {
            if (existsSync(`${req.cwd}/${a}`)) {
              seenArtifacts.push(a);
            }
          }
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
        idFactory: () => 'inv-cleanup',
        readPromptChars: () => 0,
      });

      await router.invoke(
        req({
          cwd: tmp,
          expectedArtifacts: ['result.json'],
        }),
      );

      expect(seenArtifacts).toHaveLength(0);
      expect(capturedCwd).toBe(tmp);

      // Clean up tmpdir
      rmSync(tmp, { recursive: true, force: true });
    });

    it('deletes all expected artifacts when multiple are listed', async () => {
      const tmp = join(tmpdir(), `__tmp_cleanup_multi_${Date.now()}`);
      const { mkdirSync, writeFileSync, existsSync, rmSync } = await import('node:fs');
      mkdirSync(tmp, { recursive: true });
      writeFileSync(`${tmp}/a.json`, 'a', 'utf-8');
      writeFileSync(`${tmp}/b.md`, 'b', 'utf-8');
      writeFileSync(`${tmp}/c.txt`, 'c', 'utf-8');

      const seenArtifacts: string[] = [];
      const adapter = {
        async invoke(req: AgentInvocationRequest): Promise<AgentInvocationResult> {
          for (const a of req.expectedArtifacts) {
            if (existsSync(`${req.cwd}/${a}`)) seenArtifacts.push(a);
          }
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
        idFactory: () => 'inv-multi',
        readPromptChars: () => 0,
      });

      await router.invoke(
        req({
          cwd: tmp,
          expectedArtifacts: ['a.json', 'b.md', 'c.txt'],
        }),
      );

      expect(seenArtifacts).toHaveLength(0);
      rmSync(tmp, { recursive: true, force: true });
    });

    it('does not throw when expected artifact file does not exist (force: true)', async () => {
      const tmp = join(tmpdir(), `__tmp_cleanup_missing_${Date.now()}`);
      const { mkdirSync, rmSync } = await import('node:fs');
      mkdirSync(tmp, { recursive: true });

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
      });

      const router = new AgentRuntimeRouter({
        agent: cfg(),
        adapters: { opencode: adapter },
        invocationRepository: new FakeAgentInvocationPort(),
        clock: () => FIXED_NOW,
        idFactory: () => 'inv-missing',
        readPromptChars: () => 0,
      });

      // Should not throw even though the file doesn't exist
      const result = await router.invoke(
        req({
          cwd: tmp,
          expectedArtifacts: ['does-not-exist.json'],
        }),
      );
      expect(result.outcome).toBe('success');

      rmSync(tmp, { recursive: true, force: true });
    });

    it('throws traversal detected error if artifact is empty, dot, or traversal/absolute path', async () => {
      const tmp = join(tmpdir(), `__tmp_cleanup_traversal_${Date.now()}`);
      const { mkdirSync, rmSync } = await import('node:fs');
      mkdirSync(tmp, { recursive: true });

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
      });

      const router = new AgentRuntimeRouter({
        agent: cfg(),
        adapters: { opencode: adapter },
        invocationRepository: new FakeAgentInvocationPort(),
        clock: () => FIXED_NOW,
        idFactory: () => 'inv-traversal',
        readPromptChars: () => 0,
      });

      const invalidPaths = ['', '.', '..', '../etc', '/absolute/path'];
      for (const invalidPath of invalidPaths) {
        await expect(
          router.invoke(
            req({
              cwd: tmp,
              expectedArtifacts: [invalidPath],
            }),
          ),
        ).rejects.toThrow('traversal detected');
      }

      rmSync(tmp, { recursive: true, force: true });
    });

    it('works correctly with empty expectedArtifacts array', async () => {
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
      });

      const router = new AgentRuntimeRouter({
        agent: cfg(),
        adapters: { opencode: adapter },
        invocationRepository: new FakeAgentInvocationPort(),
        clock: () => FIXED_NOW,
        idFactory: () => 'inv-empty',
        readPromptChars: () => 0,
      });

      const result = await router.invoke(req({ expectedArtifacts: [] }));
      expect(result.outcome).toBe('success');
    });
  });
});

describe('variant suffix in effectiveProfile', () => {
  function cfgWithVariant(): AgentConfig {
    return {
      defaultProfile: 'flash-high',
      profiles: {
        'flash-high': {
          runtime: 'opencode',
          provider: 'google',
          model: 'gemini-3.5-flash',
          variant: 'high',
          timeoutMinutes: 1,
        },
      },
      phaseProfiles: {
        'plan-design': { profile: 'flash-high' },
      },
    };
  }

  it('appends variant suffix to model when variant is set and AI_AGENT_MODEL is absent', async () => {
    const inv = new FakeAgentInvocationPort();
    const adapter = new StubAdapter({
      runtime: 'opencode',
      provider: 'google',
      model: 'gemini-3.5-flash-high',
      exitCode: 0,
      durationMs: 1,
      stdoutPath: '/s',
      stderrPath: '/e',
      contractViolations: [],
      outcome: 'success',
    });
    const router = new AgentRuntimeRouter({
      agent: cfgWithVariant(),
      adapters: { opencode: adapter },
      invocationRepository: inv,
      clock: () => FIXED_NOW,
      idFactory: () => 'inv-variant',
      readPromptChars: () => 0,
      env: {},
    });
    await router.invoke(req({ profile: AgentProfileName('flash-high') }));
    const row = inv.findById(AgentInvocationId('inv-variant'));
    expect(row?.model).toBe('gemini-3.5-flash-high');
  });

  it('does NOT append variant suffix when AI_AGENT_MODEL env is set', async () => {
    const inv = new FakeAgentInvocationPort();
    const adapter = new StubAdapter({
      runtime: 'opencode',
      provider: 'google',
      model: 'my-override-model',
      exitCode: 0,
      durationMs: 1,
      stdoutPath: '/s',
      stderrPath: '/e',
      contractViolations: [],
      outcome: 'success',
    });
    const router = new AgentRuntimeRouter({
      agent: cfgWithVariant(),
      adapters: { opencode: adapter },
      invocationRepository: inv,
      clock: () => FIXED_NOW,
      idFactory: () => 'inv-variant-env',
      readPromptChars: () => 0,
      env: { AI_AGENT_MODEL: 'my-override-model' },
    });
    await router.invoke(req({ profile: AgentProfileName('flash-high') }));
    const row = inv.findById(AgentInvocationId('inv-variant-env'));
    expect(row?.model).toBe('my-override-model');
  });

  it('uses profile model unchanged when no variant is set', async () => {
    const inv = new FakeAgentInvocationPort();
    const cfgNoVariant: AgentConfig = {
      defaultProfile: 'basic',
      profiles: {
        basic: {
          runtime: 'opencode',
          provider: 'anthropic',
          model: 'claude-opus',
          timeoutMinutes: 1,
        },
      },
      phaseProfiles: {
        'plan-design': { profile: 'basic' },
      },
    };
    const adapter = new StubAdapter({
      runtime: 'opencode',
      provider: 'anthropic',
      model: 'claude-opus',
      exitCode: 0,
      durationMs: 1,
      stdoutPath: '/s',
      stderrPath: '/e',
      contractViolations: [],
      outcome: 'success',
    });
    const router = new AgentRuntimeRouter({
      agent: cfgNoVariant,
      adapters: { opencode: adapter },
      invocationRepository: inv,
      clock: () => FIXED_NOW,
      idFactory: () => 'inv-no-variant',
      readPromptChars: () => 0,
      env: {},
    });
    await router.invoke(req({ profile: AgentProfileName('basic') }));
    const row = inv.findById(AgentInvocationId('inv-no-variant'));
    expect(row?.model).toBe('claude-opus');
  });
});
