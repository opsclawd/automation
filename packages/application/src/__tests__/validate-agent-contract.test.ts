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

  describe('mustNotChangeBranch', () => {
    it('returns no violations when current branch matches expected branch and SHA', async () => {
      const git = new FakeGitPort();
      git.currentBranchByCwd.set('/tmp', 'main');
      git.headByCwd.set('/tmp', 'a'.repeat(40));
      const result = await validateAgentContract({
        contract: { mustNotChangeBranch: true },
        invocation: sampleInv({ startCommitSha: 'a'.repeat(40) }),
        ports: { artifacts: new FakeArtifactStore(), git, github: new FakeGitHubPort() },
        cwd: '/tmp',
        expectedBranch: 'main',
      });
      expect(result).toEqual([]);
    });
    it('returns branch_changed when branch name differs from expected', async () => {
      const git = new FakeGitPort();
      git.currentBranchByCwd.set('/tmp', 'feature-branch');
      git.headByCwd.set('/tmp', 'a'.repeat(40));
      const result = await validateAgentContract({
        contract: { mustNotChangeBranch: true },
        invocation: sampleInv({ startCommitSha: 'a'.repeat(40) }),
        ports: { artifacts: new FakeArtifactStore(), git, github: new FakeGitHubPort() },
        cwd: '/tmp',
        expectedBranch: 'main',
      });
      expect(result).toContain(CONTRACT_VIOLATION_CODES.BRANCH_CHANGED);
    });
    it('returns branch_changed when branch name matches but HEAD SHA differs', async () => {
      const git = new FakeGitPort();
      git.currentBranchByCwd.set('/tmp', 'main');
      git.headByCwd.set('/tmp', 'b'.repeat(40));
      const result = await validateAgentContract({
        contract: { mustNotChangeBranch: true },
        invocation: sampleInv({ startCommitSha: 'a'.repeat(40) }),
        ports: { artifacts: new FakeArtifactStore(), git, github: new FakeGitHubPort() },
        cwd: '/tmp',
        expectedBranch: 'main',
      });
      expect(result).toContain(CONTRACT_VIOLATION_CODES.BRANCH_CHANGED);
    });
    it('returns no violations when expectedBranch is not provided and branch name differs but SHA matches startCommitSha', async () => {
      const git = new FakeGitPort();
      git.currentBranchByCwd.set('/tmp', 'other-branch');
      git.headByCwd.set('/tmp', 'a'.repeat(40));
      const result = await validateAgentContract({
        contract: { mustNotChangeBranch: true },
        invocation: sampleInv({ startCommitSha: 'a'.repeat(40) }),
        ports: { artifacts: new FakeArtifactStore(), git, github: new FakeGitHubPort() },
        cwd: '/tmp',
      });
      expect(result).toEqual([]);
    });
    it('returns branch_changed when expectedBranch is not provided and HEAD SHA differs from startCommitSha', async () => {
      const git = new FakeGitPort();
      git.currentBranchByCwd.set('/tmp', 'other-branch');
      git.headByCwd.set('/tmp', 'b'.repeat(40));
      const result = await validateAgentContract({
        contract: { mustNotChangeBranch: true },
        invocation: sampleInv({ startCommitSha: 'a'.repeat(40) }),
        ports: { artifacts: new FakeArtifactStore(), git, github: new FakeGitHubPort() },
        cwd: '/tmp',
      });
      expect(result).toContain(CONTRACT_VIOLATION_CODES.BRANCH_CHANGED);
    });
  });

  describe('allowedResultValues', () => {
    it('returns no violations when result.json has an allowed value', async () => {
      const artifacts = new FakeArtifactStore();
      await artifacts.write({
        runId: 'r1',
        relativePath: 'result.json',
        contents: '{"result":"pass"}',
      });
      const result = await validateAgentContract({
        contract: { allowedResultValues: ['pass', 'fail'] },
        invocation: sampleInv({ runId: RunId('r1'), resultJsonPath: 'result.json' }),
        ports: { artifacts, git: new FakeGitPort(), github: new FakeGitHubPort() },
        cwd: '/tmp',
      });
      expect(result).toEqual([]);
    });
    it('returns invalid_result_value when result.json has a disallowed value', async () => {
      const artifacts = new FakeArtifactStore();
      await artifacts.write({
        runId: 'r1',
        relativePath: 'result.json',
        contents: '{"result":"maybe"}',
      });
      const result = await validateAgentContract({
        contract: { allowedResultValues: ['pass', 'fail'] },
        invocation: sampleInv({ runId: RunId('r1'), resultJsonPath: 'result.json' }),
        ports: { artifacts, git: new FakeGitPort(), github: new FakeGitHubPort() },
        cwd: '/tmp',
      });
      expect(result).toContain(CONTRACT_VIOLATION_CODES.INVALID_RESULT_VALUE);
    });
    it('returns invalid_result_value when result.json is missing', async () => {
      const result = await validateAgentContract({
        contract: { allowedResultValues: ['pass'] },
        invocation: sampleInv({ runId: RunId('r1'), resultJsonPath: 'result.json' }),
        ports: {
          artifacts: new FakeArtifactStore(),
          git: new FakeGitPort(),
          github: new FakeGitHubPort(),
        },
        cwd: '/tmp',
      });
      expect(result).toContain(CONTRACT_VIOLATION_CODES.INVALID_RESULT_VALUE);
    });
    it('skips result check when invocation has no resultJsonPath', async () => {
      const result = await validateAgentContract({
        contract: { allowedResultValues: ['pass'] },
        invocation: sampleInv(),
        ports: {
          artifacts: new FakeArtifactStore(),
          git: new FakeGitPort(),
          github: new FakeGitHubPort(),
        },
        cwd: '/tmp',
      });
      expect(result).toEqual([]);
    });
  });

  describe('mustPush', () => {
    it('returns no violations when remote ref matches endCommitSha', async () => {
      const git = new FakeGitPort();
      git.headByCwd.set('/tmp', 'b'.repeat(40));
      git.remoteRefs.set('origin/main', 'b'.repeat(40));
      const result = await validateAgentContract({
        contract: { mustPush: { remote: 'origin', ref: 'main' } },
        invocation: sampleInv({ startCommitSha: 'a'.repeat(40), endCommitSha: 'b'.repeat(40) }),
        ports: { artifacts: new FakeArtifactStore(), git, github: new FakeGitHubPort() },
        cwd: '/tmp',
      });
      expect(result).toEqual([]);
    });
    it('returns not_pushed when remote ref differs from endCommitSha', async () => {
      const git = new FakeGitPort();
      git.headByCwd.set('/tmp', 'b'.repeat(40));
      git.remoteRefs.set('origin/main', 'a'.repeat(40));
      const result = await validateAgentContract({
        contract: { mustPush: { remote: 'origin', ref: 'main' } },
        invocation: sampleInv({ startCommitSha: 'a'.repeat(40), endCommitSha: 'b'.repeat(40) }),
        ports: { artifacts: new FakeArtifactStore(), git, github: new FakeGitHubPort() },
        cwd: '/tmp',
      });
      expect(result).toContain(CONTRACT_VIOLATION_CODES.NOT_PUSHED);
    });
    it('returns not_pushed when remote ref does not exist', async () => {
      const git = new FakeGitPort();
      git.headByCwd.set('/tmp', 'b'.repeat(40));
      const result = await validateAgentContract({
        contract: { mustPush: { remote: 'origin', ref: 'main' } },
        invocation: sampleInv({ startCommitSha: 'a'.repeat(40), endCommitSha: 'b'.repeat(40) }),
        ports: { artifacts: new FakeArtifactStore(), git, github: new FakeGitHubPort() },
        cwd: '/tmp',
      });
      expect(result).toContain(CONTRACT_VIOLATION_CODES.NOT_PUSHED);
    });
    it('falls back to HEAD sha when endCommitSha is undefined', async () => {
      const git = new FakeGitPort();
      git.headByCwd.set('/tmp', 'b'.repeat(40));
      git.remoteRefs.set('origin/main', 'b'.repeat(40));
      const result = await validateAgentContract({
        contract: { mustPush: { remote: 'origin', ref: 'main' } },
        invocation: sampleInv({ startCommitSha: 'a'.repeat(40) }),
        ports: { artifacts: new FakeArtifactStore(), git, github: new FakeGitHubPort() },
        cwd: '/tmp',
      });
      expect(result).toEqual([]);
    });
  });

  describe('mustCreateCommit', () => {
    it('returns no violations when endCommitSha differs from startCommitSha', async () => {
      const result = await validateAgentContract({
        contract: { mustCreateCommit: true },
        invocation: sampleInv({
          startCommitSha: 'a'.repeat(40),
          endCommitSha: 'b'.repeat(40),
        }),
        ports: {
          artifacts: new FakeArtifactStore(),
          git: new FakeGitPort(),
          github: new FakeGitHubPort(),
        },
        cwd: '/tmp',
      });
      expect(result).toEqual([]);
    });
    it('returns missing_commit when endCommitSha equals startCommitSha', async () => {
      const sha = 'a'.repeat(40);
      const result = await validateAgentContract({
        contract: { mustCreateCommit: true },
        invocation: sampleInv({ startCommitSha: sha, endCommitSha: sha }),
        ports: {
          artifacts: new FakeArtifactStore(),
          git: new FakeGitPort(),
          github: new FakeGitHubPort(),
        },
        cwd: '/tmp',
      });
      expect(result).toContain(CONTRACT_VIOLATION_CODES.MISSING_COMMIT);
    });
    it('returns missing_commit when endCommitSha is undefined and HEAD equals startCommitSha', async () => {
      const git = new FakeGitPort();
      git.headByCwd.set('/tmp', 'a'.repeat(40));
      const result = await validateAgentContract({
        contract: { mustCreateCommit: true },
        invocation: sampleInv({ startCommitSha: 'a'.repeat(40) }),
        ports: { artifacts: new FakeArtifactStore(), git, github: new FakeGitHubPort() },
        cwd: '/tmp',
      });
      expect(result).toContain(CONTRACT_VIOLATION_CODES.MISSING_COMMIT);
    });
    it('returns no violations when endCommitSha is undefined but HEAD differs from startCommitSha', async () => {
      const git = new FakeGitPort();
      git.headByCwd.set('/tmp', 'b'.repeat(40));
      const result = await validateAgentContract({
        contract: { mustCreateCommit: true },
        invocation: sampleInv({ startCommitSha: 'a'.repeat(40) }),
        ports: { artifacts: new FakeArtifactStore(), git, github: new FakeGitHubPort() },
        cwd: '/tmp',
      });
      expect(result).toEqual([]);
    });
  });
});
