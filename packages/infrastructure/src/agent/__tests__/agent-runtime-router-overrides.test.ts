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

  it('respects runtime override in request', async () => {
    let piCalled = false;
    const piAdapter: AgentPort = {
      async invoke(_request: AgentInvocationRequest): Promise<AgentInvocationResult> {
        piCalled = true;
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
      }
    };

    const inv = new FakeAgentInvocationPort();
    const router = new AgentRuntimeRouter({
      agent: cfg(),
      adapters: {
        opencode: {
          async invoke() {
            throw new Error('Should not be called');
          },
        } as AgentPort,
        pi: piAdapter,
      },
      invocationRepository: inv,
    });

    // profile is opencode-frontier, but we override with runtime: pi
    await router.invoke(req({
      runtime: 'pi'
    }));

    expect(piCalled).toBe(true);
    const row = inv.listByRun(RunId('r1'))[0];
    expect(row?.runtime).toBe('pi');
  });

  it('request overrides take precedence over environment variables', async () => {
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
      env: {
        AI_AGENT_MODEL: 'env-model',
        AI_AGENT_PROVIDER: 'env-provider'
      }
    });

    await router.invoke(req({
      model: 'request-model',
      provider: 'request-provider'
    }));

    expect(capturedReq?.model).toBe('request-model');
    expect(capturedReq?.provider).toBe('request-provider');
  });
});
