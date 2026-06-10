import {
  RunId,
  RepositoryId,
  PhaseName,
  createPrReviewComment,
  markProcessed,
  blockComment,
  isUnresolved,
  resetForRetry,
  type PrReviewComment,
  type PollAttempt,
} from '@ai-sdlc/domain';
import type { GitHubPort } from '../ports/github-port.js';
import type { GitPort } from '../ports/git-port.js';
import type { AgentPort } from '../ports/agent-port.js';
import type { AgentProfileName } from '../ports/agent-invocation-types.js';
import type { PrReviewRepositoryPort } from '../ports/pr-review-repository-port.js';
import type { PollTaskResult } from '../results/schemas/poll-task-result.js';
import { PollTaskRunner } from './poll-task-runner.js';
import type { PollTaskOutput } from './poll-task-runner.js';

export interface ProcessPrReviewDeps {
  github: GitHubPort;
  git: GitPort;
  agent: AgentPort;
  prReviewRepo: PrReviewRepositoryPort;
  renderTaskPrompt: (input: {
    cwd: string;
    comment: PrReviewComment;
    diff: string;
    branch: string;
  }) => Promise<string>;
  extractTaskResult: (input: {
    resultJsonPath?: string;
    cwd: string;
  }) => Promise<
    { ok: true; result: PollTaskResult } | { ok: false; reason: string; detail: string }
  >;
  verifyCommitPushed: (input: {
    cwd: string;
    branch: string;
    startCommitSha: string;
    commitSha?: string;
  }) => Promise<boolean>;
  verifyBuildPasses: (input: { cwd: string; runId: string }) => Promise<boolean>;
  resolveProfileForPhase: (phaseName: string) => AgentProfileName;
  idFactory: () => string;
  now: () => Date;
  baseBranch?: string;
  repoRoot?: string | undefined;
  onWarning?: (message: string, metadata: Record<string, unknown>, runId: string) => void;
}

export interface ProcessPrReviewInput {
  runId: RunId;
  repoId: RepositoryId;
  repoFullName: string;
  prNumber: number;
  cwd: string;
  phaseId: PhaseName;
  pollNumber: number;
}

export interface ProcessPrReviewOutput {
  outcome: 'ALL_DONE' | 'BLOCKED' | 'NO_UNRESOLVED';
  processed: number;
  blocked: number;
  allResolved: boolean;
}

const BLOCK_THRESHOLD = 2;

export class ProcessPrReviewComments {
  constructor(private readonly deps: ProcessPrReviewDeps) {}

  async execute(input: ProcessPrReviewInput): Promise<ProcessPrReviewOutput> {
    const d = this.deps;
    const startedAt = d.now();

    const raw = await d.github.listReviewComments(input.repoFullName, input.prNumber);
    const reviews = await d.github.listReviews(input.repoFullName, input.prNumber);
    const approvedReviewIds = new Set(
      reviews.filter((r) => r.state === 'APPROVED').map((r) => r.id),
    );
    const reviewerComments = raw.filter(
      (c) => c.inReplyToId === undefined && !approvedReviewIds.has(c.reviewId ?? 0),
    );

    for (const rc of reviewerComments) {
      if (!d.prReviewRepo.getComment(input.runId, rc.id)) {
        d.prReviewRepo.upsertComment(
          createPrReviewComment({
            runId: input.runId,
            prNumber: input.prNumber,
            commentId: rc.id,
            path: rc.path,
            line: rc.line ?? 0,
            reviewer: rc.reviewer,
            body: rc.body,
            now: d.now(),
          }),
        );
      }
    }

    const unresolved = d.prReviewRepo.listComments(input.runId).filter((c) => isUnresolved(c));

    if (unresolved.length === 0) {
      await this.verifyOrphaned(input, undefined);

      const allComments = d.prReviewRepo.listComments(input.runId);
      const stillUnresolved = allComments.filter(isUnresolved);
      const hasRepliedUnverified = allComments.some(
        (c) => c.state === 'replied' && !c.replyVerified,
      );
      const hasBlocked = allComments.some((c) => c.state === 'blocked');
      const blockedCount = allComments.filter((c) => c.state === 'blocked').length;

      let terminal: PollAttempt['terminalState'];
      if (stillUnresolved.length > 0 || hasRepliedUnverified) {
        terminal = undefined;
      } else if (hasBlocked) {
        terminal = 'blocked';
      } else {
        terminal = 'all_resolved';
      }

      this.recordPoll(input, startedAt, reviewerComments.length, 0, terminal);
      return {
        outcome: 'NO_UNRESOLVED',
        processed: 0,
        blocked: blockedCount,
        allResolved: stillUnresolved.length === 0 && !hasRepliedUnverified && !hasBlocked,
      };
    }

    const pr = await d.github.getPr(input.repoFullName, input.prNumber);
    if (pr.state !== 'open') {
      this.recordPoll(input, startedAt, unresolved.length, 0, undefined, 'failed');
      return {
        outcome: 'BLOCKED',
        processed: 0,
        blocked: 0,
        allResolved: false,
      };
    }

    const diff = await d.git.diff(input.cwd, 'origin/HEAD');
    const startCommitSha = await d.git.headCommitSha(input.cwd);

    const mainShaBefore = d.baseBranch
      ? await d.git.remoteRef({ cwd: input.cwd, remote: 'origin', ref: d.baseBranch })
      : undefined;
    const localMainShaBefore =
      d.repoRoot && d.baseBranch ? await d.git.headCommitShaOf(d.repoRoot) : undefined;

    const manifest = this.generateManifest(unresolved);
    const taskRunner = new PollTaskRunner(d);
    const taskResults: PollTaskOutput[] = [];
    const MAX_TASK_RETRIES = 3;
    // Each task's agent may commit, advancing HEAD. Later tasks must verify
    // against the HEAD as of when they start, not the stale poll-start SHA. (M1)
    let runningStartSha = startCommitSha;

    for (const task of manifest.tasks) {
      // Re-read live state: a comment may have been resolved or blocked since the
      // manifest was built (e.g. by a prior poll's orphan verification). Only
      // process comments that are still pending. (M2)
      const comment = d.prReviewRepo.getComment(input.runId, task.commentId);
      if (!comment || comment.state !== 'pending') continue;

      let lastOutput: PollTaskOutput | undefined;
      for (let attempt = 1; attempt <= MAX_TASK_RETRIES; attempt++) {
        try {
          lastOutput = await taskRunner.execute({
            ...input,
            comment,
            diff,
            branch: pr.headRefName,
            startCommitSha: runningStartSha,
          });
          if (lastOutput.action !== 'failed') break;
        } catch {
          lastOutput = {
            commentId: task.commentId,
            action: 'failed',
            processed: false,
            blocked: false,
          };
        }
        if (
          attempt === MAX_TASK_RETRIES &&
          lastOutput &&
          !lastOutput.processed &&
          !lastOutput.blocked
        ) {
          d.prReviewRepo.upsertComment(
            blockComment(comment, `task failed after ${MAX_TASK_RETRIES} attempts`),
          );
          lastOutput = {
            commentId: task.commentId,
            action: 'failed',
            processed: false,
            blocked: true,
          };
        }
      }
      if (lastOutput) {
        // The agent committed during a fixed task, so HEAD moved — advance the
        // start SHA so the next task verifies against this task's commit. (M1)
        if (lastOutput.commitSha) runningStartSha = lastOutput.commitSha;
        taskResults.push(lastOutput);
      }
    }

    if (d.baseBranch && mainShaBefore) {
      const mainShaAfter = await d.git.remoteRef({
        cwd: input.cwd,
        remote: 'origin',
        ref: d.baseBranch,
      });
      if (mainShaAfter && mainShaAfter !== mainShaBefore) {
        d.onWarning?.(
          'main branch changed during agent run',
          {
            baseBranch: d.baseBranch,
            shaBefore: mainShaBefore,
            shaAfter: mainShaAfter,
            prNumber: input.prNumber,
          },
          String(input.runId),
        );
      }
    }
    if (d.repoRoot && d.baseBranch && localMainShaBefore) {
      const localMainShaAfter = await d.git.headCommitShaOf(d.repoRoot);
      if (localMainShaAfter && localMainShaAfter !== localMainShaBefore) {
        d.onWarning?.(
          'local main checkout changed during agent run',
          {
            baseBranch: d.baseBranch,
            shaBefore: localMainShaBefore,
            shaAfter: localMainShaAfter,
            prNumber: input.prNumber,
          },
          String(input.runId),
        );
      }
    }

    let processed = 0;
    let blocked = 0;
    for (const tr of taskResults) {
      if (tr.processed) processed++;
      if (tr.blocked) blocked++;
    }

    const orphanResult = await this.verifyOrphaned(input, startCommitSha);
    blocked += orphanResult.blocked;
    processed += orphanResult.newlyProcessed;

    const allComments = d.prReviewRepo.listComments(input.runId);
    const stillUnresolved = allComments.filter(isUnresolved);
    const hasRepliedUnverified = allComments.some((c) => c.state === 'replied' && !c.replyVerified);
    const hasBlocked = allComments.some((c) => c.state === 'blocked');

    let terminal: PollAttempt['terminalState'];
    if (stillUnresolved.length > 0 || hasRepliedUnverified) {
      terminal = undefined;
    } else if (hasBlocked) {
      terminal = 'blocked';
    } else {
      terminal = 'all_resolved';
    }

    let outcome: 'ALL_DONE' | 'BLOCKED';
    if (processed > 0 && stillUnresolved.length === 0 && !hasRepliedUnverified && !hasBlocked) {
      outcome = 'ALL_DONE';
    } else if (processed > 0 || blocked > 0) {
      outcome = 'ALL_DONE';
    } else {
      outcome = 'BLOCKED';
    }

    this.recordPoll(input, startedAt, unresolved.length, processed, terminal);

    return {
      outcome,
      processed,
      blocked,
      allResolved: stillUnresolved.length === 0 && !hasRepliedUnverified && !hasBlocked,
    };
  }

  private async verifyOrphaned(
    input: ProcessPrReviewInput,
    startCommitSha: string | undefined,
    skipCommentIds: Set<number> = new Set(),
  ): Promise<{ blocked: number; newlyProcessed: number }> {
    const d = this.deps;
    const allComments = d.prReviewRepo.listComments(input.runId);
    const orphaned = allComments.filter(
      (c) => c.state === 'replied' && !c.replyVerified && !skipCommentIds.has(c.commentId),
    );

    if (orphaned.length === 0) return { blocked: 0, newlyProcessed: 0 };

    const pr = await d.github.getPr(input.repoFullName, input.prNumber);
    const afterComments = await d.github.listReviewComments(input.repoFullName, input.prNumber);
    const buildVerified = await d.verifyBuildPasses({ cwd: input.cwd, runId: input.runId });

    let blocked = 0;
    let newlyProcessed = 0;
    for (const c of orphaned) {
      const replyVerified = afterComments.some((rc) => rc.inReplyToId === c.commentId);
      const isFix = c.outcome === 'fixed';
      const commitVerified = !startCommitSha
        ? true
        : c.commitSha
          ? await d.verifyCommitPushed({
              cwd: input.cwd,
              branch: pr.headRefName,
              startCommitSha,
              commitSha: c.commitSha,
            })
          : false;
      let fixCommitOnRemote = true;
      if (isFix && c.commitSha) {
        const remoteSha = await d.git.remoteRef({
          cwd: input.cwd,
          remote: 'origin',
          ref: pr.headRefName,
        });
        if (remoteSha) {
          fixCommitOnRemote = await d.git.isAncestor(input.cwd, c.commitSha, remoteSha);
        } else {
          fixCommitOnRemote = false;
        }
      }
      let isNewerThanStart = true;
      if (isFix && startCommitSha && c.commitSha) {
        const commitsSinceStart = await d.git.logBetween(input.cwd, startCommitSha, c.commitSha);
        isNewerThanStart = commitsSinceStart.length > 0;
      }
      // Asymmetric: 'fixed' comments require commit/build verification; 'no_fix' only needs reply visible
      const ok = isFix
        ? fixCommitOnRemote && isNewerThanStart && commitVerified && replyVerified && buildVerified
        : replyVerified;

      if (ok) {
        d.prReviewRepo.upsertComment(
          markProcessed(c, {
            commitVerified: isFix ? commitVerified : true,
            replyVerified,
            buildVerified: isFix ? buildVerified : true,
          }),
        );
        await d.github.resolveReviewThread(input.repoFullName, input.prNumber, c.commentId);
        newlyProcessed++;
      } else if (c.attempts >= BLOCK_THRESHOLD) {
        d.prReviewRepo.upsertComment(blockComment(c, 'verification failed twice'));
        blocked++;
      } else {
        d.prReviewRepo.upsertComment(resetForRetry(c, { poll: input.pollNumber }));
      }
    }
    return { blocked, newlyProcessed };
  }

  private generateManifest(
    comments: PrReviewComment[],
  ): import('../results/schemas/poll-task-manifest.js').PollTaskManifest {
    return {
      version: 1,
      taskCount: comments.length,
      tasks: comments.map((c, i) => ({
        id: `comment-${c.commentId}`,
        commentId: c.commentId,
        path: c.path,
        line: c.line,
        body: c.body,
        reviewer: c.reviewer,
        priority: i + 1,
      })),
    };
  }

  private recordPoll(
    input: ProcessPrReviewInput,
    startedAt: Date,
    fetched: number,
    processed: number,
    terminalState?: PollAttempt['terminalState'],
    status: PollAttempt['status'] = 'completed',
  ): void {
    this.deps.prReviewRepo.insertPollAttempt({
      id: this.deps.idFactory(),
      runId: input.runId,
      prNumber: input.prNumber,
      pollNumber: input.pollNumber,
      status,
      commentsFetched: fetched,
      commentsProcessed: processed,
      startedAt,
      completedAt: this.deps.now(),
      ...(terminalState ? { terminalState } : {}),
    });
  }
}
