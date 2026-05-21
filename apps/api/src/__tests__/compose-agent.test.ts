import { describe, expect, it } from 'vitest';
import { AgentProfileName } from '@ai-sdlc/application';
import { FakeAgentPort } from '@ai-sdlc/application/test-doubles';
import { AgentRuntimeRegistry } from '../agent-runtime-registry.js';

describe('AgentRuntimeRegistry', () => {
  it('resolveProfileForPhase returns the configured profile name', () => {
    const reg = new AgentRuntimeRegistry({
      agent: {
        defaultProfile: 'opencode-frontier',
        profiles: {
          'opencode-frontier': {
            runtime: 'opencode',
            provider: 'anthropic',
            model: 'claude-sonnet-4-20250514',
            timeoutMinutes: 60,
          },
        },
        phaseProfiles: { 'plan-design': { profile: 'opencode-frontier' } },
      },
      adapters: { opencode: new FakeAgentPort({}), pi: new FakeAgentPort({}) },
    });
    expect(reg.resolveProfileForPhase('plan-design')).toBe(AgentProfileName('opencode-frontier'));
  });

  it('resolveProfileForPhase throws on unknown phase', () => {
    const reg = new AgentRuntimeRegistry({
      agent: {
        defaultProfile: 'opencode-frontier',
        profiles: {
          'opencode-frontier': {
            runtime: 'opencode',
            provider: 'anthropic',
            model: 'claude-sonnet-4-20250514',
            timeoutMinutes: 60,
          },
        },
        phaseProfiles: {},
      },
      adapters: { opencode: new FakeAgentPort({}), pi: new FakeAgentPort({}) },
    });
    expect(() => reg.resolveProfileForPhase('mystery')).toThrow(/unknown phase/);
  });

  it('agentPort.invoke dispatches to the adapter for the requested profile runtime', async () => {
    const opencode = new FakeAgentPort({
      [AgentProfileName('opencode-frontier')]: [
        {
          runtime: 'opencode',
          provider: 'anthropic',
          model: 'claude-sonnet-4-20250514',
          exitCode: 0,
          durationMs: 1,
          stdoutPath: '/tmp/stdout',
          stderrPath: '/tmp/stderr',
          contractViolations: [],
          outcome: 'success',
        },
      ],
    });
    const pi = new FakeAgentPort({});
    const reg = new AgentRuntimeRegistry({
      agent: {
        defaultProfile: 'opencode-frontier',
        profiles: {
          'opencode-frontier': {
            runtime: 'opencode',
            provider: 'anthropic',
            model: 'claude-sonnet-4-20250514',
            timeoutMinutes: 60,
          },
        },
        phaseProfiles: { 'plan-design': { profile: 'opencode-frontier' } },
      },
      adapters: { opencode, pi },
    });
    const r = await reg.agentPort.invoke({
      profile: AgentProfileName('opencode-frontier'),
      promptPath: '/tmp/prompt',
      expectedArtifacts: [],
      cwd: '/',
      runId: 'test-run',
      repoId: 'test-repo',
      phaseId: 'plan-design',
    });
    expect(r.outcome).toBe('success');
    expect(opencode.invocations).toHaveLength(1);
    expect(pi.invocations).toHaveLength(0);
  });
});
