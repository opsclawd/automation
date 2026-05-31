import { describe, it, expect } from 'vitest';
import { AgentProfileName } from '@ai-sdlc/domain';
import { FakeAgentInvocationPort } from '@ai-sdlc/application/test-doubles';
import type {
  AgentPort,
  AgentInvocationRequest,
  AgentInvocationResult,
} from '@ai-sdlc/application/ports';
import { type AgentConfig } from '@ai-sdlc/shared';
import { AgentRuntimeRouter } from '../agent-runtime-router.js';

class StubAdapter implements AgentPort {
  public calls = 0;
  constructor(private readonly result: AgentInvocationResult) {}
  async invoke(_: AgentInvocationRequest): Promise<AgentInvocationResult> {
    this.calls += 1;
    return this.result;
  }
}

function cfg(): AgentConfig {
  return {
    defaultProfile: 'claude-reviewer',
    profiles: {
      'claude-reviewer': {
        runtime: 'claude-code',
        provider: 'anthropic',
        model: 'default',
        timeoutMinutes: 1,
      },
    },
    phaseProfiles: {
      'quality-review': { profile: 'claude-reviewer' },
    },
  };
}

describe('AgentRuntimeRouter — claude-code routing', () => {
  it('dispatches claude-code profiles to the claude-code adapter and records the runtime', async () => {
    const inv = new FakeAgentInvocationPort();
    const adapter = new StubAdapter({
      runtime: 'claude-code',
      provider: '',
      model: 'default',
      exitCode: 0,
      durationMs: 10,
      stdoutPath: '/tmp/stdout.log',
      stderrPath: '/tmp/stderr.log',
      contractViolations: [],
      outcome: 'success',
    });
    const router = new AgentRuntimeRouter({
      agent: cfg(),
      adapters: { 'claude-code': adapter },
      invocationRepository: inv,
      readPromptChars: () => 0,
    });
    const req: AgentInvocationRequest = {
      profile: AgentProfileName('claude-reviewer'),
      promptPath: '/tmp/prompt.md',
      expectedArtifacts: [],
      cwd: '/tmp',
      runId: '00000000-0000-0000-0000-000000000001',
      repoId: 'r1',
      phaseId: 'quality-review',
      startCommitSha: 'a'.repeat(40),
    };
    const result = await router.invoke(req);
    expect(result.runtime).toBe('claude-code');
    expect(adapter.calls).toBe(1);
    const rows = inv.listByRuntime('claude-code');
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe('anthropic');
  });
});
