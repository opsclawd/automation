import { describe, it, expect } from 'vitest';
import { AgentInvocationId, AgentProfileName, PhaseName, RunId } from '@ai-sdlc/domain';
import type { AgentInvocation } from '@ai-sdlc/domain';
import { FakeArtifactStore, FakeGitPort, FakeGitHubPort } from '../test-doubles/index.js';
import { validateAgentContract } from '../agent/validate-agent-contract.js';
import { CONTRACT_VIOLATION_CODES } from '../agent/contract-violation-codes.js';

function sampleInv(overrides: Partial<AgentInvocation> = {}): AgentInvocation {
  return {
    id: AgentInvocationId('inv-1'),
    runId: RunId('r1'),
    phaseId: PhaseName('plan-design'),
    profile: AgentProfileName('p'),
    runtime: 'opencode',
    provider: 'a',
    model: 'm',
    promptPath: '/p',
    promptChars: 1,
    stdoutPath: '/s',
    stderrPath: '/e',
    startedAt: new Date('2026-05-22T10:00:00Z'),
    startCommitSha: 'a'.repeat(40),
    timeoutMs: 1000,
    ...overrides,
  };
}

describe('validateAgentContract', () => {
  describe('requiredArtifacts', () => {
    it('returns no violations when all required artifacts exist and are non-empty', async () => {
      const artifacts = new FakeArtifactStore();
      await artifacts.write({ runId: 'r1', relativePath: 'plan.md', contents: '# Plan' });
      const result = await validateAgentContract({
        contract: { requiredArtifacts: ['plan.md'] },
        invocation: sampleInv(),
        ports: { artifacts, git: new FakeGitPort(), github: new FakeGitHubPort() },
        cwd: '/tmp',
      });
      expect(result).toEqual([]);
    });

    it('returns missing_required_artifact when a required artifact is absent', async () => {
      const result = await validateAgentContract({
        contract: { requiredArtifacts: ['plan.md'] },
        invocation: sampleInv(),
        ports: {
          artifacts: new FakeArtifactStore(),
          git: new FakeGitPort(),
          github: new FakeGitHubPort(),
        },
        cwd: '/tmp',
      });
      expect(result).toContain(CONTRACT_VIOLATION_CODES.MISSING_REQUIRED_ARTIFACT);
    });

    it('returns missing_required_artifact when a required artifact is empty (whitespace only)', async () => {
      const artifacts = new FakeArtifactStore();
      await artifacts.write({ runId: 'r1', relativePath: 'plan.md', contents: '   ' });
      const result = await validateAgentContract({
        contract: { requiredArtifacts: ['plan.md'] },
        invocation: sampleInv({ runId: RunId('r1') }),
        ports: { artifacts, git: new FakeGitPort(), github: new FakeGitHubPort() },
        cwd: '/tmp',
      });
      expect(result).toContain(CONTRACT_VIOLATION_CODES.MISSING_REQUIRED_ARTIFACT);
    });

    it('returns single missing_required_artifact even when multiple artifacts are missing', async () => {
      const result = await validateAgentContract({
        contract: { requiredArtifacts: ['plan.md', 'design.md', 'review.md'] },
        invocation: sampleInv(),
        ports: {
          artifacts: new FakeArtifactStore(),
          git: new FakeGitPort(),
          github: new FakeGitHubPort(),
        },
        cwd: '/tmp',
      });
      const artifactViolations = result.filter(
        (v) => v === CONTRACT_VIOLATION_CODES.MISSING_REQUIRED_ARTIFACT,
      );
      expect(artifactViolations).toHaveLength(1);
    });
  });
});
