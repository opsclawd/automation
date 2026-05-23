import { describe, expect, it } from 'vitest';
import {
  AgentProfileName,
  type AgentPort,
  type AgentInvocationRequest,
  type AgentInvocationResult,
} from '@ai-sdlc/application';
import { FakeAgentInvocationPort } from '@ai-sdlc/application/test-doubles';
import { AgentRuntimeRouter } from '@ai-sdlc/infrastructure';
import { AgentInvocationId } from '@ai-sdlc/domain';
import { resolveProfileForPhase } from '../compose.js';
import { ConfigError } from '@ai-sdlc/shared';

const baseConfig = {
  defaultProfile: 'opencode-frontier' as const,
  profiles: {
    'opencode-frontier': {
      runtime: 'opencode' as const,
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      timeoutMinutes: 60,
    },
  },
  phaseProfiles: { 'plan-design': { profile: 'opencode-frontier' } },
};

const stubAdapter: AgentPort = {
  async invoke(_req: AgentInvocationRequest): Promise<AgentInvocationResult> {
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
    };
  },
};

function makeRouter(overrides: Partial<ConstructorParameters<typeof AgentRuntimeRouter>[0]> = {}) {
  return new AgentRuntimeRouter({
    agent: baseConfig,
    adapters: { opencode: stubAdapter },
    invocationRepository: new FakeAgentInvocationPort(),
    clock: () => new Date('2026-01-01'),
    idFactory: () => 'test-id',
    readPromptChars: () => 0,
    ...overrides,
  });
}

describe('resolveProfileForPhase', () => {
  it('returns the configured profile for a known phase', () => {
    const profile = resolveProfileForPhase(baseConfig, 'plan-design');
    expect(profile).toBe(AgentProfileName('opencode-frontier'));
  });

  it('throws ConfigError for an unknown phase', () => {
    expect(() => resolveProfileForPhase(baseConfig, 'mystery')).toThrow(ConfigError);
  });
});

describe('compose agent wiring', () => {
  it('phaseProfiles resolves a known phase to a profile name', () => {
    const profile = baseConfig.phaseProfiles['plan-design']?.profile;
    expect(profile).toBe('opencode-frontier');
  });

  it('agentPort.invoke dispatches to the adapter for the requested profile runtime', async () => {
    const inv = new FakeAgentInvocationPort();
    const router = makeRouter({ invocationRepository: inv });
    const r = await router.invoke({
      profile: AgentProfileName('opencode-frontier'),
      promptPath: '/tmp/prompt',
      expectedArtifacts: [],
      cwd: '/',
      runId: 'test-run',
      repoId: 'test-repo',
      phaseId: 'plan-design',
      startCommitSha: '0'.repeat(40),
    });
    expect(r.outcome).toBe('success');
    const row = inv.findById(AgentInvocationId('test-id'));
    expect(row).toBeDefined();
  });

  it('invoke throws ConfigError when no adapter is registered for a profile runtime', async () => {
    const router = new AgentRuntimeRouter({
      agent: {
        ...baseConfig,
        profiles: {
          'pi-profile': {
            runtime: 'pi' as const,
            provider: 'openai',
            model: 'o1',
            timeoutMinutes: 30,
            contextLimitTokens: 100000,
          },
        },
        phaseProfiles: { 'plan-design': { profile: 'pi-profile' } },
      },
      adapters: { opencode: stubAdapter },
      invocationRepository: new FakeAgentInvocationPort(),
      clock: () => new Date('2026-01-01'),
      idFactory: () => 'test-id',
      readPromptChars: () => 0,
    });
    await expect(
      router.invoke({
        profile: AgentProfileName('pi-profile'),
        promptPath: '/tmp/prompt',
        expectedArtifacts: [],
        cwd: '/',
        runId: 'test-run',
        repoId: 'test-repo',
        phaseId: 'plan-design',
        startCommitSha: '0'.repeat(40),
      }),
    ).rejects.toThrow(/no adapter registered/);
  });
});
