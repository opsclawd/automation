import {
  RunId,
  RepositoryId,
  PhaseName,
  createPrReviewComment,
  markReplied,
  markProcessed,
  resetForRetry,
  blockComment,
  isUnresolved,
  type PrReviewComment,
  type PollAttempt,
} from '@ai-sdlc/domain';
import type { GitHubPort } from '../ports/github-port.js';
import type { GitPort } from '../ports/git-port.js';
import type { AgentPort } from '../ports/agent-port.js';
import type { AgentProfileName } from '../ports/agent-invocation-types.js';
import type { EventBusPort } from '../ports/event-bus-port.js';
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
  eventBus: EventBusPort;
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
      this.recordPoll(input, startedAt, reviewerComments.length, 0, 'all_resolved');
      return {
        outcome: 'NO_UNRESOLVED',
        processed: 0,
        blocked: 0,
        allResolved: true,
      };
    }

    const pr = await d.github.getPr(input.repoFullName, input.prNumber);
    const diff = await d.git.diff(input.cwd, 'origin/HEAD');
    const promptPath = await d.renderPrompt({
      cwd: input.cwd,
      comments: unresolved,
      diff,
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

    let processed = 0;
    let blocked = 0;

    for (const item of result.comments) {
      const existing = d.prReviewRepo.getComment(input.runId, item.commentId);
      if (!existing || existing.state === 'processed') continue;

      if (item.action === 'blocked') {
        d.prReviewRepo.upsertComment(blockComment(existing, item.blockedReason ?? 'agent blocked'));
        blocked++;
        continue;
      }

      await d.github.replyToReviewComment(
        input.repoFullName,
        input.prNumber,
        item.commentId,
        item.replyBody,
      );

      const replyId = d.idFactory();
      d.prReviewRepo.insertReply({
        id: replyId,
        runId: input.runId,
        prNumber: input.prNumber,
        commentId: item.commentId,
        body: item.replyBody,
        postedAt: d.now(),
        verified: false,
      });

      let commitSha: string | undefined;
      let commitVerified = true;
      let buildVerified = true;

      if (item.action === 'fixed') {
        commitSha = await d.git.headCommitSha(input.cwd);
        commitVerified = await d.verifyCommitPushed({
          cwd: input.cwd,
          branch: pr.headRefName,
        });
        buildVerified = await d.verifyBuildPasses({ cwd: input.cwd });
      }

      const afterComments = await d.github.listReviewComments(input.repoFullName, input.prNumber);
      const replyVerified = afterComments.some((c) => c.inReplyToId === item.commentId);

      const repliedComment = markReplied(existing, {
        replyId: Number(replyId) || existing.commentId,
        outcome: item.action === 'fixed' ? 'fixed' : 'no_fix',
        ...(commitSha ? { commitSha } : {}),
        poll: input.pollNumber,
      });

      const noFixOk = item.action === 'no_fix' && replyVerified;
      const fixOk = item.action === 'fixed' && commitVerified && replyVerified && buildVerified;

      if (noFixOk || fixOk) {
        d.prReviewRepo.upsertComment(
          markProcessed(repliedComment, {
            commitVerified: item.action === 'fixed' ? commitVerified : true,
            replyVerified,
            buildVerified: item.action === 'fixed' ? buildVerified : true,
          }),
        );
        await d.github.resolveReviewThread(input.repoFullName, input.prNumber, item.commentId);
        processed++;
      } else if (repliedComment.attempts >= BLOCK_THRESHOLD) {
        d.prReviewRepo.upsertComment(blockComment(repliedComment, 'verification failed twice'));
        blocked++;
      } else {
        d.prReviewRepo.upsertComment(resetForRetry(repliedComment, { poll: input.pollNumber }));
      }
    }

    const stillUnresolved = d.prReviewRepo.listComments(input.runId).filter(isUnresolved);
    const terminal = stillUnresolved.length === 0 ? ('all_resolved' as const) : undefined;

    this.recordPoll(input, startedAt, unresolved.length, processed, terminal);

    return {
      outcome: result.outcome,
      processed,
      blocked,
      allResolved: stillUnresolved.length === 0,
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
