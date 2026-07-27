import { describe, it, expect } from 'vitest';
import { RunId, RepositoryId, PhaseName, createPrReviewComment } from '@ai-sdlc/domain';
import {
  FakeGitHubPort,
  FakeGitPort,
  FakePrReviewRepository,
  FakeAgentPort,
  FakeArtifactStore,
  createFakePrReviewContextSource,
} from '../../test-doubles/index.js';
import type { AgentInvocationResult } from '../../ports/agent-invocation-types.js';
import {
  ProcessPrReviewComments,
  type ProcessPrReviewDeps,
} from '../process-pr-review-comments.js';
import type { PrReviewContextSnapshot } from '../../ports/pr-review-context-source-port.js';

const runId = RunId('44444444-4444-4444-4444-444444444444');
const repoId = RepositoryId('o/r');

function makeSuccessAgentResult(
  overrides: Partial<AgentInvocationResult> = {},
): AgentInvocationResult {
  return {
    runtime: 'opencode',
    provider: 'test',
    model: 'test',
    exitCode: 0,
    durationMs: 100,
    stdoutPath: '/dev/null',
    stderrPath: '/dev/null',
    resultJsonPath: '/tmp/result.json',
    contractViolations: [],
    outcome: 'success',
    ...overrides,
  };
}

class IncrementingShaGitPort extends FakeGitPort {
  private n = 0;
  override async headCommitSha(_cwd: string): Promise<string> {
    return `sha-${++this.n}`;
  }
  override async isAncestor(): Promise<boolean> {
    return true;
  }
  override async logBetween(): Promise<string[]> {
    return ['dummy'];
  }
}

function makeContextSnapshot(
  overrides: Partial<PrReviewContextSnapshot> = {},
): PrReviewContextSnapshot {
  return {
    base: 'origin/main',
    head: 'sha-1',
    fullDiff: `diff --git a/test.ts b/test.ts
--- a/test.ts
+++ b/test.ts
@@ -1,3 +1,4 @@
+new line
`,
    diffStat: '1 file changed, 1 insertion',
    changedFiles: ['test.ts'],
    trackedFiles: ['test.ts', 'other.ts'],
    fileContents: {
      'test.ts': 'line 1\nline 2\nline 3\n',
      'other.ts': 'other content\n',
    },
    ...overrides,
  };
}

function makeBatchingDeps(overrides: Partial<ProcessPrReviewDeps> = {}): {
  deps: ProcessPrReviewDeps;
  github: FakeGitHubPort;
  git: FakeGitPort;
  repo: FakePrReviewRepository;
  agent: FakeAgentPort;
  contextSource: ReturnType<typeof createFakePrReviewContextSource>;
  contextSelectedEvents: Array<{
    level: number;
    commentIds: number[];
    files: string[];
    hunks: string[];
    symbols: string[];
    fullDiffIncluded: boolean;
    fallbackReason?: string;
  }>;
  fullDiffFallbackEvents: Array<{
    commentIds: number[];
    fallbackReason: string;
  }>;
} {
  const github = new FakeGitHubPort();
  const git = new IncrementingShaGitPort();
  const repo = new FakePrReviewRepository();
  const agent = new FakeAgentPort({
    'post-pr-review-profile': Array.from({ length: 20 }, () => makeSuccessAgentResult()),
  });

  github.prs.set('o/r/5', {
    number: 5,
    url: 'https://x/pr/5',
    state: 'open',
    headRefName: 'feat-x',
  });
  github.comments.set('o/r/5', []);
  git.remoteRefs.set('origin/feat-x', 'abc123');

  const contextSelectedEvents: Array<{
    level: number;
    commentIds: number[];
    files: string[];
    hunks: string[];
    symbols: string[];
    fullDiffIncluded: boolean;
    fallbackReason?: string;
  }> = [];

  const fullDiffFallbackEvents: Array<{
    commentIds: number[];
    fallbackReason: string;
  }> = [];

  const contextSource = createFakePrReviewContextSource(makeContextSnapshot());

  let replyCounter = 0;
  let currentBatchResults: Array<{
    commentId: number;
    action: 'fixed' | 'no_fix' | 'blocked';
    replyBody: string;
    blockedReason?: string;
  }> = [];

  const deps: ProcessPrReviewDeps = {
    github,
    git,
    agent,
    prReviewRepo: repo,
    artifactStore: new FakeArtifactStore(),
    contextSource,
    renderTaskPrompt: async ({ comment }) => `/tmp/prompt-${comment.commentId}.md`,
    extractTaskResult: async () => ({
      ok: true,
      result: {
        commentId: currentBatchResults[0]?.commentId ?? 9001,
        action: 'fixed',
        replyBody: 'Done.',
      },
    }),
    renderBatchTaskPrompt: async ({ comments }) => {
      return `/tmp/batch-prompt-${comments.map((c) => c.commentId).join('-')}.md`;
    },
    extractBatchTaskResult: async () => ({
      ok: true,
      result: currentBatchResults,
    }),
    verifyCommitPushed: async () => true,
    verifyBuildPasses: async () => ({ passed: true }),
    resolveProfileForPhase: () => 'post-pr-review-profile' as never,
    idFactory: () => `id-${++replyCounter}`,
    now: () => new Date('2026-06-04T00:10:00Z'),
    onContextSelected: (event) => {
      contextSelectedEvents.push({
        level: event.level,
        commentIds: event.commentIds,
        files: event.includedFiles,
        hunks: event.includedHunks,
        symbols: event.includedSymbols,
        fullDiffIncluded: event.fullDiffIncluded,
        fallbackReason: event.fallbackReason,
      });
      if (event.fullDiffIncluded && event.fallbackReason) {
        fullDiffFallbackEvents.push({
          commentIds: event.commentIds,
          fallbackReason: event.fallbackReason,
        });
      }
    },
    ...overrides,
  };

  return {
    deps,
    github,
    git,
    repo,
    agent,
    contextSource,
    contextSelectedEvents,
    fullDiffFallbackEvents,
  };
}

describe('ProcessPrReviewComments — batching behavioral invariants', () => {
  describe('same-hunk pending comments use one invocation with tier-one context', () => {
    it('batches same-hunk comments into one invocation without full diff in prompt', async () => {
      const { deps, github, contextSelectedEvents } = makeBatchingDeps();

      github.comments.set('o/r/5', [
        {
          id: 9001,
          prNumber: 5,
          path: 'a.ts',
          line: 10,
          reviewer: 'r1',
          body: 'fix this typo',
          createdAt: new Date(),
        },
        {
          id: 9002,
          prNumber: 5,
          path: 'a.ts',
          line: 12,
          reviewer: 'r2',
          body: 'fix another typo',
          createdAt: new Date(),
        },
      ]);

      const batchResults: Array<{
        commentId: number;
        action: 'fixed' | 'no_fix' | 'blocked';
        replyBody: string;
      }> = [
        { commentId: 9001, action: 'fixed', replyBody: 'Fixed first typo.' },
        { commentId: 9002, action: 'fixed', replyBody: 'Fixed second typo.' },
      ];

      deps.extractBatchTaskResult = async () => ({
        ok: true,
        result: batchResults,
      });

      const capturedPrompts: string[] = [];
      deps.renderBatchTaskPrompt = async ({ comments }) => {
        capturedPrompts.push(`batch:${comments.map((c) => c.commentId).join(',')}`);
        return `/tmp/batch-prompt.md`;
      };

      const uc = new ProcessPrReviewComments(deps);
      await uc.execute({
        runId,
        repoId,
        repoFullName: 'o/r',
        prNumber: 5,
        cwd: '/work/tree',
        phaseId: PhaseName('post-pr-review'),
        pollNumber: 1,
      });

      const batchCall = capturedPrompts.find((p) => p.startsWith('batch:'));
      expect(batchCall).toBeDefined();
      expect(batchCall).toContain('9001');
      expect(batchCall).toContain('9002');

      expect(contextSelectedEvents.length).toBeGreaterThan(0);
      const firstEvent = contextSelectedEvents[0]!;
      expect(firstEvent.fullDiffIncluded).toBe(false);
      expect(firstEvent.commentIds).toContain(9001);
      expect(firstEvent.commentIds).toContain(9002);
    });
  });

  describe('comments in separate files use separate invocations and advance each batch start SHA', () => {
    it('creates separate batches for separate files with live HEAD SHA per batch', async () => {
      const { deps, github, git } = makeBatchingDeps();

      github.comments.set('o/r/5', [
        {
          id: 9001,
          prNumber: 5,
          path: 'a.ts',
          line: 10,
          reviewer: 'r1',
          body: 'fix in a.ts',
          createdAt: new Date(),
        },
        {
          id: 9002,
          prNumber: 5,
          path: 'b.ts',
          line: 20,
          reviewer: 'r2',
          body: 'fix in b.ts',
          createdAt: new Date(),
        },
      ]);

      let batchCallCount = 0;
      const batchStartShas: string[] = [];
      deps.renderBatchTaskPrompt = async ({ comments: _comments }) => {
        batchCallCount++;
        batchStartShas.push(git.headByCwd.get('/work/tree') ?? 'unknown');
        return `/tmp/batch-prompt.md`;
      };

      const batchResults: Array<{
        commentId: number;
        action: 'fixed' | 'no_fix' | 'blocked';
        replyBody: string;
      }> = [
        { commentId: 9001, action: 'fixed', replyBody: 'Fixed.' },
        { commentId: 9002, action: 'fixed', replyBody: 'Fixed.' },
      ];
      deps.extractBatchTaskResult = async () => ({
        ok: true,
        result: batchCallCount === 1 ? [batchResults[0]!] : [batchResults[1]!],
      });

      const uc = new ProcessPrReviewComments(deps);
      await uc.execute({
        runId,
        repoId,
        repoFullName: 'o/r',
        prNumber: 5,
        cwd: '/work/tree',
        phaseId: PhaseName('post-pr-review'),
        pollNumber: 1,
      });

      expect(batchCallCount).toBe(2);
      expect(batchStartShas[0]).not.toBe(batchStartShas[1]);
    });
  });

  describe('shared-root-cause comments in one file retain independent processed and thread states', () => {
    it('processes both comments but records remain per-comment', async () => {
      const { deps, github, repo } = makeBatchingDeps();

      github.comments.set('o/r/5', [
        {
          id: 9001,
          prNumber: 5,
          path: 'a.ts',
          line: 10,
          reviewer: 'r1',
          body: 'fix variable name',
          createdAt: new Date(),
        },
        {
          id: 9002,
          prNumber: 5,
          path: 'a.ts',
          line: 15,
          reviewer: 'r2',
          body: 'fix same variable elsewhere',
          createdAt: new Date(),
        },
      ]);

      const batchResults: Array<{
        commentId: number;
        action: 'fixed' | 'no_fix' | 'blocked';
        replyBody: string;
      }> = [
        { commentId: 9001, action: 'fixed', replyBody: 'Fixed.' },
        { commentId: 9002, action: 'fixed', replyBody: 'Fixed.' },
      ];
      deps.extractBatchTaskResult = async () => ({
        ok: true,
        result: batchResults,
      });

      const uc = new ProcessPrReviewComments(deps);
      const out = await uc.execute({
        runId,
        repoId,
        repoFullName: 'o/r',
        prNumber: 5,
        cwd: '/work/tree',
        phaseId: PhaseName('post-pr-review'),
        pollNumber: 1,
      });

      expect(out.processed).toBe(2);
      expect(repo.getComment(runId, 9001)?.state).toBe('processed');
      expect(repo.getComment(runId, 9002)?.state).toBe('processed');
      expect(repo.getComment(runId, 9001)?.replyVerified).toBe(true);
      expect(repo.getComment(runId, 9002)?.replyVerified).toBe(true);
    });
  });

  describe('live-state filtering removes a resolved member before invoking its batch', () => {
    it('does not include already-resolved comment in batch prompt', async () => {
      const { deps, github, repo } = makeBatchingDeps();

      github.comments.set('o/r/5', [
        {
          id: 9001,
          prNumber: 5,
          path: 'a.ts',
          line: 10,
          reviewer: 'r1',
          body: 'fix this',
          createdAt: new Date(),
        },
        {
          id: 9002,
          prNumber: 5,
          path: 'a.ts',
          line: 20,
          reviewer: 'r2',
          body: 'fix this too',
          createdAt: new Date(),
        },
      ]);

      repo.upsertComment({
        ...createPrReviewComment({
          runId,
          prNumber: 5,
          commentId: 9001,
          path: 'a.ts',
          line: 10,
          reviewer: 'r1',
          body: 'fix this',
          now: new Date(),
        }),
        state: 'processed',
        commitVerified: true,
        replyVerified: true,
        buildVerified: true,
      });

      const capturedCommentIds: number[][] = [];
      deps.renderBatchTaskPrompt = async ({ comments }) => {
        capturedCommentIds.push(comments.map((c) => c.commentId));
        return `/tmp/batch-prompt.md`;
      };

      const batchResults: Array<{
        commentId: number;
        action: 'fixed' | 'no_fix' | 'blocked';
        replyBody: string;
      }> = [{ commentId: 9002, action: 'fixed', replyBody: 'Fixed.' }];
      deps.extractBatchTaskResult = async () => ({
        ok: true,
        result: batchResults,
      });

      const uc = new ProcessPrReviewComments(deps);
      await uc.execute({
        runId,
        repoId,
        repoFullName: 'o/r',
        prNumber: 5,
        cwd: '/work/tree',
        phaseId: PhaseName('post-pr-review'),
        pollNumber: 1,
      });

      const lastBatch = capturedCommentIds[capturedCommentIds.length - 1];
      expect(lastBatch).not.toContain(9001);
      expect(lastBatch).toContain(9002);
    });
  });

  describe('tier-one context selection emits metadata with fullDiffIncluded false', () => {
    it('emits context_selected event with fullDiffIncluded=false for tier-one selections', async () => {
      const { deps, github, contextSelectedEvents } = makeBatchingDeps();

      const snapshot = makeContextSnapshot({
        fullDiff: 'full diff content that should not be marked as included',
      });
      deps.contextSource = createFakePrReviewContextSource(snapshot);

      github.comments.set('o/r/5', [
        {
          id: 9001,
          prNumber: 5,
          path: 'a.ts',
          line: 10,
          reviewer: 'r1',
          body: 'fix this',
          createdAt: new Date(),
        },
      ]);

      deps.extractBatchTaskResult = async () => ({
        ok: true,
        result: [{ commentId: 9001, action: 'fixed', replyBody: 'Fixed.' }],
      });

      const uc = new ProcessPrReviewComments(deps);
      await uc.execute({
        runId,
        repoId,
        repoFullName: 'o/r',
        prNumber: 5,
        cwd: '/work/tree',
        phaseId: PhaseName('post-pr-review'),
        pollNumber: 1,
      });

      expect(contextSelectedEvents.length).toBeGreaterThan(0);
      const event = contextSelectedEvents.find((e) => e.commentIds.includes(9001));
      expect(event).toBeDefined();
      expect(event!.fullDiffIncluded).toBe(false);
    });
  });

  describe('full-diff selection emits one explicit fallback event', () => {
    it('emits full_diff_fallback event only when full diff is included', async () => {
      const { deps, github, contextSelectedEvents, fullDiffFallbackEvents } = makeBatchingDeps();

      const snapshot = makeContextSnapshot({
        fullDiff: 'some very long full diff',
      });
      deps.contextSource = async () => snapshot;

      github.comments.set('o/r/5', [
        {
          id: 9001,
          prNumber: 5,
          path: 'nonexistent.ts',
          line: 999,
          reviewer: 'r1',
          body: 'fix something that does not exist in diff',
          createdAt: new Date(),
        },
      ]);

      let extractCount = 0;
      deps.extractBatchTaskResult = async () => {
        extractCount++;
        if (extractCount < 3) {
          return {
            ok: true,
            result: [{ commentId: 9001, action: 'failed', replyBody: 'Try again.' }],
          };
        }
        return {
          ok: true,
          result: [{ commentId: 9001, action: 'no_fix', replyBody: 'Cannot find context.' }],
        };
      };

      const uc = new ProcessPrReviewComments(deps);
      await uc.execute({
        runId,
        repoId,
        repoFullName: 'o/r',
        prNumber: 5,
        cwd: '/work/tree',
        phaseId: PhaseName('post-pr-review'),
        pollNumber: 1,
      });

      expect(contextSelectedEvents.length).toBeGreaterThan(0);
      const fallbackEvent = contextSelectedEvents.find((e) => e.fullDiffIncluded);
      expect(fallbackEvent).toBeDefined();
      expect(fallbackEvent!.fallbackReason).toBeDefined();

      expect(fullDiffFallbackEvents.length).toBeGreaterThan(0);
      expect(fullDiffFallbackEvents[0]!.commentIds).toContain(9001);
    });
  });
});
