import { describe, expect, it } from 'vitest';
import {
  type AgentInvocationRequest,
  type AgentInvocationResult,
  type AgentInvocationOutcome,
  AgentProfileName,
} from '../agent/invocation.js';

describe('AgentInvocationRequest', () => {
  it('constructs a request with all required fields', () => {
    const req: AgentInvocationRequest = {
      profile: AgentProfileName('opencode-frontier'),
      promptPath: '/tmp/prompts/design-review.md',
      expectedArtifacts: ['design.md', 'summary.md'],
      cwd: '/tmp/worktree',
      runId: 'run-abc123',
      repoId: 'repo-42',
      phaseId: 'design',
    };
    expect(req.profile).toBe('opencode-frontier');
    expect(req.promptPath).toBe('/tmp/prompts/design-review.md');
    expect(req.expectedArtifacts).toEqual(['design.md', 'summary.md']);
    expect(req.cwd).toBe('/tmp/worktree');
    expect(req.runId).toBe('run-abc123');
    expect(req.repoId).toBe('repo-42');
    expect(req.phaseId).toBe('design');
  });

  it('constructs a request with optional fields', () => {
    const req: AgentInvocationRequest = {
      profile: AgentProfileName('pi-qwen'),
      promptPath: '/tmp/prompts/code-review.md',
      expectedArtifacts: ['review.md'],
      cwd: '/tmp/wt',
      runId: 'run-def456',
      repoId: 'repo-7',
      phaseId: 'review',
      workerId: 'worker-1',
      stepId: 'step-3',
    };
    expect(req.workerId).toBe('worker-1');
    expect(req.stepId).toBe('step-3');
  });
});

describe('AgentInvocationResult', () => {
  const baseResult: AgentInvocationResult = {
    runtime: 'opencode',
    provider: 'anthropic',
    model: 'claude-opus-4.7',
    exitCode: 0,
    durationMs: 45231,
    stdoutPath: '/tmp/logs/stdout.log',
    stderrPath: '/tmp/logs/stderr.log',
    contractViolations: [],
    outcome: 'success',
  };

  it('constructs a success result', () => {
    expect(baseResult.outcome).toBe('success');
    expect(baseResult.exitCode).toBe(0);
    expect(baseResult.contractViolations).toEqual([]);
  });

  it('constructs a result with contract violations', () => {
    const result: AgentInvocationResult = {
      ...baseResult,
      outcome: 'contract_violation',
      contractViolations: ['missing artifact: design.md'],
    };
    expect(result.outcome).toBe('contract_violation');
    expect(result.contractViolations).toHaveLength(1);
  });

  it('constructs a result with optional resultJsonPath', () => {
    const result: AgentInvocationResult = {
      ...baseResult,
      resultJsonPath: '/tmp/results/output.json',
    };
    expect(result.resultJsonPath).toBe('/tmp/results/output.json');
  });
});

describe('AgentInvocationOutcome', () => {
  it('accepts all four outcome values', () => {
    const outcomes: AgentInvocationOutcome[] = [
      'success',
      'failed',
      'timeout',
      'contract_violation',
    ];
    expect(outcomes).toHaveLength(4);
  });

  it('rejects invalid outcome values at compile time', () => {
    const outcome: AgentInvocationOutcome = 'success';
    expect(['success', 'failed', 'timeout', 'contract_violation']).toContain(outcome);
  });
});

describe('AgentProfileName brand', () => {
  it('constructs a branded AgentProfileName', () => {
    const name = AgentProfileName('opencode-frontier');
    expect(name).toBe('opencode-frontier');
  });

  it('rejects empty string', () => {
    expect(() => AgentProfileName('')).toThrow('AgentProfileName must be a non-empty string');
  });

  it('rejects whitespace-only string', () => {
    expect(() => AgentProfileName('   ')).toThrow('AgentProfileName must be a non-empty string');
  });
});
