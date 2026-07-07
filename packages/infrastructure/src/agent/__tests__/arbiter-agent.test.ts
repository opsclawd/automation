import { describe, it, expect, vi } from 'vitest';
import { ArbiterAgent, buildArbiterPrompt, type ArbiterAgentDeps } from '../arbiter-agent.js';
import { StepLoopContext, TypecheckResult, FixResult } from '@ai-sdlc/application';
import { AgentProfileName, AgentInvocationId, RunId, PhaseName } from '@ai-sdlc/domain';

describe('ArbiterAgent', () => {
  const ctx: StepLoopContext = {
    loopId: 'loop-1',
    runId: RunId('run-1'),
    phaseId: PhaseName('implement'),
    repoId: 'repo-1',
    cwd: '/tmp/repo-1',
    stepIndex: 1,
    stepTitle: 'Task 1',
    iterationIndex: 1,
  };

  const tcResult: TypecheckResult = {
    outcome: 'pass',
    output: '',
  };

  const fixResult: FixResult = {
    invocationId: 'fix-1',
    agentOutcome: 'success',
    verdict: 'done_no_fixes_needed',
    rebuttal: 'The reviewer is wrong because X.',
  };

  describe('buildArbiterPrompt', () => {
    it('includes all necessary sections in the prompt', () => {
      const prompt = buildArbiterPrompt(
        ctx,
        tcResult,
        'Spec Review Findings',
        'Quality Review Findings',
        fixResult,
        'Issue Excerpt',
        'History Context'
      );

      expect(prompt).toContain('# ARBITER TASK');
      expect(prompt).toContain('Arbitrate a review/fix contradiction for step 1: Task 1');
      expect(prompt).toContain('Issue Excerpt');
      expect(prompt).toContain('Review/Fix History');
      expect(prompt).toContain('Typecheck Result');
      expect(prompt).toContain('Spec Review Findings');
      expect(prompt).toContain('Quality Review Findings');
      expect(prompt).toContain('Fixer Rebuttal');
      expect(prompt).toContain('finding_valid');
      expect(prompt).toContain('finding_invalid');
    });

    it('handles missing history context', () => {
      const prompt = buildArbiterPrompt(
        ctx,
        tcResult,
        'Spec Review Findings',
        'Quality Review Findings',
        fixResult,
        'Issue Excerpt'
      );

      expect(prompt).not.toContain('Review/Fix History');
    });

    it('displays failed typecheck output', () => {
      const failedTc: TypecheckResult = {
        outcome: 'fail',
        output: 'Error on line 10',
      };
      const prompt = buildArbiterPrompt(
        ctx,
        failedTc,
        'Spec Review Findings',
        'Quality Review Findings',
        fixResult,
        'Issue Excerpt'
      );

      expect(prompt).toContain('FAIL');
      expect(prompt).toContain('Error on line 10');
    });
  });

  describe('runArbiter', () => {
    it('successfully invokes agent and extracts result', async () => {
      const mockAgent = {
        invoke: vi.fn().mockResolvedValue({ outcome: 'success', resultJsonPath: 'result.json' }),
      };
      const mockArtifacts = {
        read: vi.fn().mockImplementation((_runId, path) => {
          if (path === 'code-review.md') return Promise.resolve('Review Findings');
          if (path === 'issue.md') return Promise.resolve('Issue Content');
          if (path === 'result.json') return Promise.resolve(JSON.stringify({
            outcome: 'finding_invalid',
            evidence: 'Code shows X',
            rationale: 'Reviewer missed Y'
          }));
          return Promise.reject(new Error('File not found'));
        }),
        write: vi.fn().mockResolvedValue(undefined),
      };
      const mockInvocations = {
        findById: vi.fn().mockReturnValue({ id: 'arbiter-1', phaseId: 'arbitrate', resultJsonPath: 'result.json' }),
      };

      const deps: ArbiterAgentDeps = {
        agent: mockAgent as any,
        artifacts: () => mockArtifacts as any,
        invocations: mockInvocations as any,
        baseTmpDir: '/tmp',
        resolveStartCommitSha: () => 'sha-1',
        newestInvocationId: () => 'arbiter-1',
      };

      const arbiterAgent = new ArbiterAgent(deps);
      const result = await arbiterAgent.runArbiter(ctx, tcResult, fixResult, {
        profile: AgentProfileName('test-profile'),
      });

      expect(result.outcome).toBe('finding_invalid');
      expect(result.evidence).toBe('Code shows X');
      expect(result.rationale).toBe('Reviewer missed Y');

      expect(mockAgent.invoke).toHaveBeenCalled();
      expect(mockArtifacts.write).toHaveBeenCalledWith(expect.objectContaining({
        relativePath: 'arbiter-rationale-1.md',
        contents: 'Reviewer missed Y',
      }));
    });

    it('throws error if extraction fails', async () => {
      const mockAgent = {
        invoke: vi.fn().mockResolvedValue({ outcome: 'success', resultJsonPath: 'result.json' }),
      };
      const mockArtifacts = {
        read: vi.fn().mockImplementation((_runId, path) => {
          if (path === 'result.json') return Promise.resolve('invalid json');
          return Promise.resolve('');
        }),
        write: vi.fn(),
      };
      const mockInvocations = {
        findById: vi.fn().mockReturnValue({ id: 'arbiter-1', phaseId: 'arbitrate', resultJsonPath: 'result.json' }),
      };

      const deps: ArbiterAgentDeps = {
        agent: mockAgent as any,
        artifacts: () => mockArtifacts as any,
        invocations: mockInvocations as any,
        baseTmpDir: '/tmp',
        resolveStartCommitSha: () => 'sha-1',
        newestInvocationId: () => 'arbiter-1',
      };

      const arbiterAgent = new ArbiterAgent(deps);
      await expect(arbiterAgent.runArbiter(ctx, tcResult, fixResult, {
        profile: AgentProfileName('test-profile'),
      })).rejects.toThrow('Failed to extract arbiter result');
    });
  });
});
