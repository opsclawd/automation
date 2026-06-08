import { describe, it, expect } from 'vitest';
import { AgentProfileName, RunId } from '@ai-sdlc/domain';
import { FakeAgentInvocationPort } from '@ai-sdlc/application/test-doubles';
import type { AgentPort } from '@ai-sdlc/application/ports';
import type { AgentInvocationRequest, AgentInvocationResult } from '@ai-sdlc/application/ports';
import { type AgentConfig } from '@ai-sdlc/shared';
import { AgentRuntimeRouter, normalizeRoutingPhase } from '../agent-runtime-router.js';

describe('normalizeRoutingPhase', () => {
  it.each([
    ['fix-review-1', 'fix-review'],
    ['fix-review-12', 'fix-review'],
    // Forward-looking: the bash script currently passes --phase-id "fix-review-N"
    // (not "whole-pr-fix-review-N") for the whole-PR fix-review loop. These cases
    // verify normalization would work if --phase-id naming changes in the future.
    // See also: router comment about PHASE_FALLBACKS gap in adapter-level fallback.
    ['whole-pr-fix-review-1', 'whole-pr-fix-review'],
    ['whole-pr-fix-review-12', 'whole-pr-fix-review'],
    ['whole-pr-fix-review-task-5', 'whole-pr-fix-review'],
    ['quality-review-task-1', 'quality-review'],
    ['quality-review-task-12', 'quality-review'],
    ['spec-review-task-7', 'spec-review'],
    ['implement-task-3', 'implement'],
    ['plan-design', 'plan-design'],
    ['plan-write', 'plan-write'],
    ['whole-pr-review', 'whole-pr-review'],
    ['post-pr-review', 'post-pr-review'],
    ['create-pr', 'create-pr'],
    ['compound', 'compound'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeRoutingPhase(input)).toBe(expected);
  });
});

describe('AgentRuntimeRouter — per-task phase ID fallback lookup', () => {
  function makeConfig(): AgentConfig {
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
        'quality-review': { profile: 'opencode-frontier', fallbackProfile: 'pi-local' },
        implement: { profile: 'opencode-frontier', fallbackProfile: 'pi-local' },
      },
    };
  }

  function makeReq(phaseId: string): AgentInvocationRequest {
    return {
      profile: AgentProfileName('opencode-frontier'),
      promptPath: '/tmp/p.md',
      expectedArtifacts: [],
      cwd: '/tmp',
      runId: '00000000-0000-0000-0000-000000000010',
      repoId: 'r1',
      phaseId,
      startCommitSha: 'a'.repeat(40),
    };
  }

  class StubAdapter implements AgentPort {
    constructor(private readonly r: AgentInvocationResult) {}
    async invoke(): Promise<AgentInvocationResult> {
      return this.r;
    }
  }

  const failingResult: AgentInvocationResult = {
    runtime: 'opencode',
    provider: 'anthropic',
    model: 'm',
    exitCode: 0,
    durationMs: 1,
    stdoutPath: '/s',
    stderrPath: '/e',
    contractViolations: [],
    outcome: 'timeout',
  };
  const successResult: AgentInvocationResult = {
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

  it('resolves fallback for quality-review-task-12 via phaseProfiles["quality-review"]', async () => {
    const inv = new FakeAgentInvocationPort();
    const router = new AgentRuntimeRouter({
      agent: makeConfig(),
      adapters: { opencode: new StubAdapter(failingResult), pi: new StubAdapter(successResult) },
      invocationRepository: inv,
      clock: () => new Date('2026-05-27T12:00:00Z'),
      idFactory: () => 'inv-task-1',
      readPromptChars: () => 1,
    });

    await router.invoke(makeReq('quality-review-task-12'));

    const rows = inv.listByRun(RunId('00000000-0000-0000-0000-000000000010'));
    expect(rows.length).toBe(2);
    expect(rows[1].fallbackOfInvocationId).toBeDefined();
  });

  it('resolves fallback for implement-task-3 via phaseProfiles["implement"]', async () => {
    const inv = new FakeAgentInvocationPort();
    const router = new AgentRuntimeRouter({
      agent: makeConfig(),
      adapters: { opencode: new StubAdapter(failingResult), pi: new StubAdapter(successResult) },
      invocationRepository: inv,
      clock: () => new Date('2026-05-27T12:00:00Z'),
      idFactory: () => 'inv-task-2',
      readPromptChars: () => 1,
    });

    await router.invoke(makeReq('implement-task-3'));

    const rows = inv.listByRun(RunId('00000000-0000-0000-0000-000000000010'));
    expect(rows.length).toBe(2);
  });
});
