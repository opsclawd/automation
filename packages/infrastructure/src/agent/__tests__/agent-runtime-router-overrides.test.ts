import { describe, it, expect } from 'vitest';
import { AgentProfileName, RunId } from '@ai-sdlc/domain';
import { FakeAgentInvocationPort } from '@ai-sdlc/application/test-doubles';
import type { AgentPort, AgentInvocationRequest, AgentInvocationResult } from '@ai-sdlc/application/ports';
import type { AgentConfig } from '@ai-sdlc/shared';
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
    runId: 'r1',
    repoId: 'repo1',
    phaseId: 'plan-design',
    startCommitSha: 'a'.repeat(40),
    ...overrides,
  };
}

describe('AgentRuntimeRouter overrides', () => {
  it('respects model and provider overrides in request', async () => {
    let capturedReq: AgentInvocationRequest | undefined;
    const adapter: AgentPort = {
      async invoke(request: AgentInvocationRequest): Promise<AgentInvocationResult> {
        capturedReq = request;
        return {
          runtime: 'opencode',
          provider: request.provider!,
          model: request.model!,
          exitCode: 0,
          durationMs: 1,
          stdoutPath: '/s',
          stderrPath: '/e',
          contractViolations: [],
          outcome: 'success',
        };
      }
    };

    const inv = new FakeAgentInvocationPort();
    const router = new AgentRuntimeRouter({
      agent: cfg(),
      adapters: { opencode: adapter },
      invocationRepository: inv,
    });

    await router.invoke(req({
      model: 'gpt-4o',
      provider: 'openai'
    }));

    expect(capturedReq?.model).toBe('gpt-4o');
    expect(capturedReq?.provider).toBe('openai');

    const row = inv.listByRun(RunId('r1'))[0];
    expect(row?.model).toBe('gpt-4o');
    expect(row?.provider).toBe('openai');
  });
});
