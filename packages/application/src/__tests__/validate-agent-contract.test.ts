import { describe, it, expect } from 'vitest';
import { AgentInvocationId, AgentProfileName, PhaseName, RunId } from '@ai-sdlc/domain';
import type { AgentInvocation } from '@ai-sdlc/domain';
import { FakeArtifactStore, FakeGitPort, FakeGitHubPort } from '../test-doubles/index.js';
import type { PrReviewComment } from '../ports/github-port.js';
import { validateAgentContract } from '../agent/validate-agent-contract.js';
import { CONTRACT_VIOLATION_CODES } from '../ports/contract-violation-codes.js';

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
    it('returns no violations when expectedBranch is provided and branch name matches, even if HEAD SHA differs (new commits on same branch)', async () => {
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
      expect(result).toEqual([]);
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
    it('returns invalid_result_value when contract specifies allowedResultValues but invocation has no resultJsonPath', async () => {
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
      expect(result).toContain(CONTRACT_VIOLATION_CODES.INVALID_RESULT_VALUE);
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

  describe('mustPostReplies', () => {
    it('returns no violations when bot replies exist after startedAt', async () => {
      const github = new FakeGitHubPort();
      const comment: PrReviewComment = {
        id: 1,
        prNumber: 42,
        path: 'file.ts',
        line: 10,
        reviewer: 'bot',
        body: 'LGTM',
        createdAt: new Date('2026-05-22T10:01:00Z'),
      };
      github.comments.set('owner/repo/42', [comment]);
      const result = await validateAgentContract({
        contract: { mustPostReplies: { prNumber: 42 } },
        invocation: sampleInv({ startedAt: new Date('2026-05-22T10:00:00Z') }),
        ports: { artifacts: new FakeArtifactStore(), git: new FakeGitPort(), github },
        cwd: '/tmp',
        repoFullName: 'owner/repo',
      });
      expect(result).toEqual([]);
    });
    it('returns replies_not_posted when no comments exist since startedAt', async () => {
      const result = await validateAgentContract({
        contract: { mustPostReplies: { prNumber: 42 } },
        invocation: sampleInv({ startedAt: new Date('2026-05-22T10:00:00Z') }),
        ports: {
          artifacts: new FakeArtifactStore(),
          git: new FakeGitPort(),
          github: new FakeGitHubPort(),
        },
        cwd: '/tmp',
        repoFullName: 'owner/repo',
      });
      expect(result).toContain(CONTRACT_VIOLATION_CODES.REPLIES_NOT_POSTED);
    });
    it('returns replies_not_posted when comments exist but all before startedAt', async () => {
      const github = new FakeGitHubPort();
      const oldComment: PrReviewComment = {
        id: 1,
        prNumber: 42,
        path: 'file.ts',
        line: 10,
        reviewer: 'bot',
        body: 'old',
        createdAt: new Date('2026-05-22T09:59:00Z'),
      };
      github.comments.set('owner/repo/42', [oldComment]);
      const result = await validateAgentContract({
        contract: { mustPostReplies: { prNumber: 42 } },
        invocation: sampleInv({ startedAt: new Date('2026-05-22T10:00:00Z') }),
        ports: { artifacts: new FakeArtifactStore(), git: new FakeGitPort(), github },
        cwd: '/tmp',
        repoFullName: 'owner/repo',
      });
      expect(result).toContain(CONTRACT_VIOLATION_CODES.REPLIES_NOT_POSTED);
    });
    it('returns repo_not_provided when repoFullName is missing', async () => {
      const result = await validateAgentContract({
        contract: { mustPostReplies: { prNumber: 42 } },
        invocation: sampleInv({ startedAt: new Date('2026-05-22T10:00:00Z') }),
        ports: {
          artifacts: new FakeArtifactStore(),
          git: new FakeGitPort(),
          github: new FakeGitHubPort(),
        },
        cwd: '/tmp',
      });
      expect(result).toContain(CONTRACT_VIOLATION_CODES.REPO_NOT_PROVIDED);
    });
    it('filters by agentAuthor when provided and returns replies_not_posted when no agent-authored comments exist', async () => {
      const github = new FakeGitHubPort();
      const humanComment: PrReviewComment = {
        id: 1,
        prNumber: 42,
        path: 'file.ts',
        line: 10,
        reviewer: 'human-reviewer',
        body: 'looks good',
        createdAt: new Date('2026-05-22T10:01:00Z'),
      };
      github.comments.set('owner/repo/42', [humanComment]);
      const result = await validateAgentContract({
        contract: { mustPostReplies: { prNumber: 42, agentAuthor: 'bot' } },
        invocation: sampleInv({ startedAt: new Date('2026-05-22T10:00:00Z') }),
        ports: { artifacts: new FakeArtifactStore(), git: new FakeGitPort(), github },
        cwd: '/tmp',
        repoFullName: 'owner/repo',
      });
      expect(result).toContain(CONTRACT_VIOLATION_CODES.REPLIES_NOT_POSTED);
    });
    it('filters by agentAuthor and passes when agent-authored reply exists', async () => {
      const github = new FakeGitHubPort();
      const botComment: PrReviewComment = {
        id: 2,
        prNumber: 42,
        path: 'file.ts',
        line: 10,
        reviewer: 'bot',
        body: 'done',
        createdAt: new Date('2026-05-22T10:01:00Z'),
      };
      const humanComment: PrReviewComment = {
        id: 1,
        prNumber: 42,
        path: 'file.ts',
        line: 5,
        reviewer: 'human-reviewer',
        body: 'question',
        createdAt: new Date('2026-05-22T10:00:30Z'),
      };
      github.comments.set('owner/repo/42', [botComment, humanComment]);
      const result = await validateAgentContract({
        contract: { mustPostReplies: { prNumber: 42, agentAuthor: 'bot' } },
        invocation: sampleInv({ startedAt: new Date('2026-05-22T10:00:00Z') }),
        ports: { artifacts: new FakeArtifactStore(), git: new FakeGitPort(), github },
        cwd: '/tmp',
        repoFullName: 'owner/repo',
      });
      expect(result).toEqual([]);
    });
    it('filters by agentAuthor case-insensitively and passes when agent-authored reply exists with different casing', async () => {
      const github = new FakeGitHubPort();
      const botComment: PrReviewComment = {
        id: 3,
        prNumber: 42,
        path: 'file.ts',
        line: 10,
        reviewer: 'bot',
        body: 'done',
        createdAt: new Date('2026-05-22T10:01:00Z'),
      };
      github.comments.set('owner/repo/42', [botComment]);
      const result = await validateAgentContract({
        contract: { mustPostReplies: { prNumber: 42, agentAuthor: 'Bot' } },
        invocation: sampleInv({ startedAt: new Date('2026-05-22T10:00:00Z') }),
        ports: { artifacts: new FakeArtifactStore(), git: new FakeGitPort(), github },
        cwd: '/tmp',
        repoFullName: 'owner/repo',
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
    it('returns no violations when mustNotChangeBranch + mustCreateCommit are both set and agent commits on the expected branch', async () => {
      const git = new FakeGitPort();
      git.currentBranchByCwd.set('/tmp', 'feature');
      git.headByCwd.set('/tmp', 'b'.repeat(40));
      const result = await validateAgentContract({
        contract: { mustNotChangeBranch: true, mustCreateCommit: true },
        invocation: sampleInv({ startCommitSha: 'a'.repeat(40), endCommitSha: 'b'.repeat(40) }),
        ports: { artifacts: new FakeArtifactStore(), git, github: new FakeGitHubPort() },
        cwd: '/tmp',
        expectedBranch: 'feature',
      });
      expect(result).toEqual([]);
    });
  });

  describe('combined acceptance', () => {
    it('returns empty violations when all six invariants are satisfied', async () => {
      const artifacts = new FakeArtifactStore();
      await artifacts.write({ runId: 'r1', relativePath: 'plan.md', contents: '# Plan' });
      await artifacts.write({
        runId: 'r1',
        relativePath: 'result.json',
        contents: '{"result":"pass"}',
      });
      const git = new FakeGitPort();
      git.currentBranchByCwd.set('/tmp', 'main');
      git.headByCwd.set('/tmp', 'a'.repeat(40));
      git.remoteRefs.set('origin/main', 'b'.repeat(40));
      const github = new FakeGitHubPort();
      const comment: PrReviewComment = {
        id: 1,
        prNumber: 42,
        path: 'file.ts',
        line: 10,
        reviewer: 'bot',
        body: 'done',
        createdAt: new Date('2026-05-22T10:01:00Z'),
      };
      github.comments.set('owner/repo/42', [comment]);
      const result = await validateAgentContract({
        contract: {
          requiredArtifacts: ['plan.md'],
          allowedResultValues: ['pass'],
          mustNotChangeBranch: true,
          mustCreateCommit: true,
          mustPush: { remote: 'origin', ref: 'main' },
          mustPostReplies: { prNumber: 42 },
        },
        invocation: sampleInv({
          runId: RunId('r1'),
          startCommitSha: 'a'.repeat(40),
          endCommitSha: 'b'.repeat(40),
          resultJsonPath: 'result.json',
          startedAt: new Date('2026-05-22T10:00:00Z'),
        }),
        ports: { artifacts, git, github },
        cwd: '/tmp',
        repoFullName: 'owner/repo',
        expectedBranch: 'main',
      });
      expect(result).toEqual([]);
    });
    it('returns all six violation codes when every invariant fails', async () => {
      const git = new FakeGitPort();
      git.currentBranchByCwd.set('/tmp', 'other-branch');
      git.headByCwd.set('/tmp', 'a'.repeat(40));
      const result = await validateAgentContract({
        contract: {
          requiredArtifacts: ['missing.md'],
          allowedResultValues: ['pass'],
          mustNotChangeBranch: true,
          mustCreateCommit: true,
          mustPush: { remote: 'origin', ref: 'main' },
          mustPostReplies: { prNumber: 42 },
        },
        invocation: sampleInv({
          startCommitSha: 'a'.repeat(40),
          endCommitSha: 'a'.repeat(40),
          resultJsonPath: 'result.json',
          startedAt: new Date('2026-05-22T10:00:00Z'),
        }),
        ports: { artifacts: new FakeArtifactStore(), git, github: new FakeGitHubPort() },
        cwd: '/tmp',
        repoFullName: 'owner/repo',
        expectedBranch: 'main',
      });
      expect(result).toContain(CONTRACT_VIOLATION_CODES.MISSING_REQUIRED_ARTIFACT);
      expect(result).toContain(CONTRACT_VIOLATION_CODES.INVALID_RESULT_VALUE);
      expect(result).toContain(CONTRACT_VIOLATION_CODES.BRANCH_CHANGED);
      expect(result).toContain(CONTRACT_VIOLATION_CODES.MISSING_COMMIT);
      expect(result).toContain(CONTRACT_VIOLATION_CODES.NOT_PUSHED);
      expect(result).toContain(CONTRACT_VIOLATION_CODES.REPLIES_NOT_POSTED);
    });
    it('does not throw on any input — returns codes instead of exceptions', async () => {
      const result = await validateAgentContract({
        contract: { requiredArtifacts: ['nonexistent.md'] },
        invocation: sampleInv(),
        ports: {
          artifacts: new FakeArtifactStore(),
          git: new FakeGitPort(),
          github: new FakeGitHubPort(),
        },
        cwd: '/tmp',
      });
      expect(result).toContain(CONTRACT_VIOLATION_CODES.MISSING_REQUIRED_ARTIFACT);
      expect(Array.isArray(result)).toBe(true);
    });
  });
});
