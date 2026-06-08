import {
  RunId,
  RepositoryId,
  PhaseName,
  createPrReviewComment,
  markProcessed,
  blockComment,
  isUnresolved,
  type PrReviewComment,
  type PollAttempt,
} from '@ai-sdlc/domain';
import type { GitHubPort } from '../ports/github-port.js';
import type { GitPort } from '../ports/git-port.js';
import type { AgentPort } from '../ports/agent-port.js';
import type { AgentProfileName } from '../ports/agent-invocation-types.js';
import type { PrReviewRepositoryPort } from '../ports/pr-review-repository-port.js';
import type { PostPrReviewResult } from '../results/schemas/post-pr-review.js';

export interface ProcessPrReviewDeps {
  github: GitHubPort;
  git: GitPort;
  agent: AgentPort;
  prReviewRepo: PrReviewRepositoryPort;
  renderPrompt: (input: {
    cwd: string;
    comments: PrReviewComment[];
    diff: string;
    branch: string;
  }) => Promise<string>;
  extractResult: (input: {
    resultJsonPath?: string;
    cwd: string;
  }) => Promise<
    { ok: true; result: PostPrReviewResult } | { ok: false; reason: string; detail: string }
  >;
  verifyCommitPushed: (input: { cwd: string; branch: string }) => Promise<boolean>;
  verifyBuildPasses: (input: { cwd: string }) => Promise<boolean>;
  resolveProfileForPhase: (phaseName: string) => AgentProfileName;
  idFactory: () => string;
  now: () => Date;
  maxIterations: number;
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
  outcome: PostPrReviewResult['outcome'] | 'NO_UNRESOLVED';
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
    const reviewerComments = raw.filter((c) => c.inReplyToId === undefined);

    for (const rc of reviewerComments) {
      if (!d.prReviewRepo.getComment(input.runId, rc.id)) {
        d.prReviewRepo.upsertComment(
          createPrReviewComment({
            runId: input.runId,
            prNumber: input.prNumber,
            commentId: rc.id,
            path: rc.path,
            line: rc.line,
            reviewer: rc.reviewer,
            body: rc.body,
            now: d.now(),
          }),
        );
      }
    }

    const unresolved = d.prReviewRepo.listComments(input.runId).filter((c) => isUnresolved(c));

    if (unresolved.length === 0) {
      await this.verifyOrphaned(input);

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
    const promptPath = await d.renderPrompt({
      cwd: input.cwd,
      comments: unresolved,
      diff,
      branch: pr.headRefName,
    });
    const profile = d.resolveProfileForPhase('post-pr-review');
    const startCommitSha = await d.git.headCommitSha(input.cwd);

    const invocation = await d.agent.invoke({
      profile,
      promptPath,
      expectedArtifacts: ['result.json'],
      cwd: input.cwd,
      runId: input.runId as unknown as string,
      repoId: input.repoId as unknown as string,
      phaseId: input.phaseId as unknown as string,
      startCommitSha,
    });

    if (invocation.outcome !== 'success') {
      this.recordPoll(input, startedAt, unresolved.length, 0, undefined, 'failed');
      return {
        outcome: 'BLOCKED',
        processed: 0,
        blocked: 0,
        allResolved: false,
      };
    }

    const extracted = await d.extractResult(
      invocation.resultJsonPath !== undefined
        ? { resultJsonPath: invocation.resultJsonPath, cwd: input.cwd }
        : { cwd: input.cwd },
    );

    if (!extracted.ok) {
      this.recordPoll(input, startedAt, unresolved.length, 0, undefined, 'failed');
      return {
        outcome: 'BLOCKED',
        processed: 0,
        blocked: 0,
        allResolved: false,
      };
    }

    const result = extracted.result;

    if (result.comments.length === 0 && result.outcome !== 'BLOCKED') {
      await this.verifyOrphaned(input);
      this.recordPoll(input, startedAt, unresolved.length, 0, undefined, 'failed');
      return {
        outcome: 'BLOCKED',
        processed: 0,
        blocked: 0,
        allResolved: false,
      };
    }

    if (result.outcome === 'BLOCKED' && result.comments.length === 0) {
      let blocked = 0;
      for (const c of unresolved) {
        d.prReviewRepo.upsertComment(blockComment(c, 'agent returned global BLOCKED'));
        blocked++;
      }

      await this.verifyOrphaned(input);

      this.recordPoll(input, startedAt, unresolved.length, 0, 'blocked');
      return {
        outcome: 'BLOCKED',
        processed: 0,
        blocked,
        allResolved: false,
      };
    }

    let processed = 0;
    let blocked = 0;
    const repliedInThisPass = new Set<number>();
    const toVerify: Array<{
      commentId: number;
      action: 'fixed' | 'no_fix';
      replyBody: string;
    }> = [];

    const seenCommentIds = new Set<number>();
    const uniqueComments = result.comments.filter((item) => {
      if (seenCommentIds.has(item.commentId)) return false;
      seenCommentIds.add(item.commentId);
      return true;
    });

    const hasFixedComments = uniqueComments.some((c) => c.action === 'fixed');
    const fixCommitSha = hasFixedComments ? await d.git.headCommitSha(input.cwd) : undefined;
    const commitShaChanged = fixCommitSha !== undefined && fixCommitSha !== startCommitSha;

    let commitVerified = true;
    let buildVerified = true;
    if (hasFixedComments) {
      commitVerified = await d.verifyCommitPushed({ cwd: input.cwd, branch: pr.headRefName });
      buildVerified = await d.verifyBuildPasses({ cwd: input.cwd });
    }

    for (const item of uniqueComments) {
      const existing = d.prReviewRepo.getComment(input.runId, item.commentId);
      if (!existing || existing.state !== 'pending') continue;

      await d.github.replyToReviewComment(
        input.repoFullName,
        input.prNumber,
        item.commentId,
        item.replyBody,
      );

      if (item.action === 'blocked') {
        d.prReviewRepo.insertReply({
          id: d.idFactory(),
          runId: input.runId,
          prNumber: input.prNumber,
          commentId: item.commentId,
          body: item.replyBody,
          postedAt: d.now(),
          verified: true,
        });
        d.prReviewRepo.upsertComment(blockComment(existing, item.blockedReason ?? 'agent blocked'));
        blocked++;
        continue;
      }

      d.prReviewRepo.insertReply({
        id: d.idFactory(),
        runId: input.runId,
        prNumber: input.prNumber,
        commentId: item.commentId,
        body: item.replyBody,
        postedAt: d.now(),
        verified: false,
      });

      const replied: PrReviewComment = {
        ...existing,
        state: 'replied',
        outcome: item.action === 'fixed' ? 'fixed' : 'no_fix',
        attempts: existing.attempts + 1,
        lastPoll: input.pollNumber,
        updatedAt: d.now(),
      };
      if (item.action === 'fixed' && fixCommitSha !== undefined) {
        replied.commitSha = fixCommitSha;
      }
      d.prReviewRepo.upsertComment(replied);
      repliedInThisPass.add(item.commentId);

      toVerify.push({ commentId: item.commentId, action: item.action, replyBody: item.replyBody });
    }

    const afterComments = await d.github.listReviewComments(input.repoFullName, input.prNumber);

    for (const item of toVerify) {
      const existing = d.prReviewRepo.getComment(input.runId, item.commentId);
      if (!existing || existing.state !== 'replied') continue;

      const githubReply = afterComments.find((c) => c.inReplyToId === item.commentId);
      const replyVerified = githubReply !== undefined;
      const repliedWithId = githubReply ? { ...existing, replyId: githubReply.id } : existing;
      if (githubReply) {
        d.prReviewRepo.upsertComment(repliedWithId);
      }

      const noFixOk = item.action === 'no_fix' && replyVerified;
      const fixOk =
        item.action === 'fixed' &&
        commitShaChanged &&
        commitVerified &&
        replyVerified &&
        buildVerified;

      if (noFixOk || fixOk) {
        d.prReviewRepo.upsertComment(
          markProcessed(repliedWithId, {
            commitVerified: item.action === 'fixed' ? commitVerified : true,
            replyVerified,
            buildVerified: item.action === 'fixed' ? buildVerified : true,
          }),
        );
        await d.github.resolveReviewThread(input.repoFullName, input.prNumber, item.commentId);
        processed++;
      }
    }

    if (processed === 0 && blocked === 0 && repliedInThisPass.size === 0) {
      await this.verifyOrphaned(input);
      this.recordPoll(input, startedAt, unresolved.length, 0, undefined, 'failed');
      return {
        outcome: 'BLOCKED',
        processed: 0,
        blocked: 0,
        allResolved: false,
      };
    }

    blocked += await this.verifyOrphaned(input);

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

    this.recordPoll(input, startedAt, unresolved.length, processed, terminal);

    return {
      outcome: result.outcome,
      processed,
      blocked,
      allResolved: stillUnresolved.length === 0 && !hasRepliedUnverified && !hasBlocked,
    };
  }

  private async verifyOrphaned(input: ProcessPrReviewInput): Promise<number> {
    const d = this.deps;
    const allComments = d.prReviewRepo.listComments(input.runId);
    const orphaned = allComments.filter((c) => c.state === 'replied' && !c.replyVerified);

    if (orphaned.length === 0) return 0;

    const pr = await d.github.getPr(input.repoFullName, input.prNumber);
    const afterComments = await d.github.listReviewComments(input.repoFullName, input.prNumber);
    const commitVerified = await d.verifyCommitPushed({ cwd: input.cwd, branch: pr.headRefName });
    const buildVerified = await d.verifyBuildPasses({ cwd: input.cwd });

    let blocked = 0;
    for (const c of orphaned) {
      const replyVerified = afterComments.some((rc) => rc.inReplyToId === c.commentId);
      const isFix = c.outcome === 'fixed';
      let fixCommitOnRemote = true;
      if (isFix && c.commitSha) {
        const remoteSha = await d.git.remoteRef({
          cwd: input.cwd,
          remote: 'origin',
          ref: pr.headRefName,
        });
        fixCommitOnRemote = remoteSha === c.commitSha;
      }
      const ok = isFix
        ? fixCommitOnRemote && commitVerified && replyVerified && buildVerified
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
      } else if (c.attempts + 1 >= BLOCK_THRESHOLD) {
        d.prReviewRepo.upsertComment(blockComment(c, 'verification failed twice'));
        blocked++;
      } else {
        d.prReviewRepo.upsertComment({
          ...c,
          attempts: c.attempts + 1,
          lastPoll: input.pollNumber,
          updatedAt: d.now(),
        });
      }
    }
    return blocked;
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
