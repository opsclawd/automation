import type { PhaseName, Failure, AgentProfileName, ExecutionPolicy } from '@ai-sdlc/domain';
import type { ArtifactStore } from '../ports/artifact-store.js';
import type { GitHubPort } from '../ports/github-port.js';
import type { GitPort } from '../ports/git-port.js';
import type { AgentPort } from '../ports/agent-port.js';
import type { EventBusPort } from '../ports/event-bus-port.js';
import type { ReadWorktreeFilePort } from '../ports/read-worktree-file-port.js';
import type { DeleteWorktreeFilePort } from '../ports/delete-worktree-file-port.js';
import type { WorktreeLifecyclePort } from '../ports/worktree-lifecycle-port.js';
import type { EventRepositoryPort } from '../ports/event-repository-port.js';
import type { StructuredResultRepairPort } from '../ports/structured-result-repair-port.js';
import type { CleanReviewFixtureStorePort } from '../ports/clean-review-fixture-store-port.js';

export interface PhaseHandlerContext {
  runId: string;
  runUuid: string;
  repoFullName: string;
  issueNumber: number;
  cwd: string;
  artifacts: ArtifactStore;
  github: GitHubPort;
  git: GitPort;
  agent: AgentPort;
  events: EventBusPort;
  now: () => Date;
  /**
   * Optional context fields for agent phases.
   * Populated via buildPhaseHandlerContext() by the compose root.
   * Handlers that require these should assert at run() entry.
   */
  executionPolicy?: ExecutionPolicy;
  promptsRoot?: string;
  automationRoot?: string;
  targetRoot?: string;
  startCommitSha?: string;
  expectedBranch?: string;
  baseBranch?: string;
  resolveProfile?: (phase: string) => AgentProfileName;
  idFactory?: () => string;
  readWorktreeFile?: ReadWorktreeFilePort | undefined;
  deleteWorktreeFile?: DeleteWorktreeFilePort | undefined;
  cleanReviewFixtureStore?: CleanReviewFixtureStorePort | undefined;
  worktreeLifecycle?: WorktreeLifecyclePort | undefined;
  eventRepository?: EventRepositoryPort | undefined;
  inboundPreserveAllowance?: string[] | undefined;
  approvedInboundPaths?: string[] | undefined;
  repair?: StructuredResultRepairPort | undefined;
  /**
   * Name of the phase that completed immediately before this one. Used by
   * phase boundary checks to attribute dirty-worktree failures to the phase
   * that actually dirtied the tree rather than the phase that discovered it.
   * Optional: handlers that don't need it see `undefined` and skip the check.
   */
  priorPhaseName?: string;
  selfVerifyCommands?: string[] | undefined;
  governanceProtectedPaths?: string[] | undefined;
  allowProtectedPaths?: string[] | undefined;
  /** Issue numbers admitted to the current release batch, when batch-scoped. */
  batchIssueNumbers?: readonly number[] | undefined;
}

export type PhaseOutcome =
  | 'passed'
  | 'failed'
  | 'blocked'
  | 'resting'
  | 'skipped'
  | 'needs_human_review'
  | 'deferred';

export type PhaseResult =
  | { outcome: 'passed' | 'resting' | 'skipped' | 'deferred' }
  | { outcome: 'failed' | 'blocked' | 'needs_human_review'; failure: Failure };

export interface PhaseHandler {
  readonly phase: PhaseName;
  run(ctx: PhaseHandlerContext): Promise<PhaseResult>;
}

export type EventEmitter = (
  type: string,
  level: 'info' | 'warn' | 'error',
  message: string,
  metadata?: Record<string, unknown>,
) => void;

export function createEventEmitter(ctx: PhaseHandlerContext, phase: PhaseName): EventEmitter {
  return (type, level, message, metadata = {}) => {
    ctx.events.publish(ctx.runUuid, {
      runId: ctx.runId,
      phase,
      level,
      type,
      message,
      timestamp: ctx.now().toISOString(),
      metadata,
    });
  };
}

export type PhaseHandlerContextFactory = (
  base: Omit<
    PhaseHandlerContext,
    | 'executionPolicy'
    | 'promptsRoot'
    | 'automationRoot'
    | 'targetRoot'
    | 'startCommitSha'
    | 'expectedBranch'
    | 'baseBranch'
    | 'resolveProfile'
    | 'idFactory'
    | 'readWorktreeFile'
    | 'deleteWorktreeFile'
    | 'cleanReviewFixtureStore'
    | 'worktreeLifecycle'
    | 'eventRepository'
    | 'inboundPreserveAllowance'
    | 'approvedInboundPaths'
    | 'repair'
    | 'priorPhaseName'
    | 'selfVerifyCommands'
    | 'allowProtectedPaths'
    | 'batchIssueNumbers'
  >,
  opts?: Partial<
    Pick<
      PhaseHandlerContext,
      | 'executionPolicy'
      | 'promptsRoot'
      | 'automationRoot'
      | 'targetRoot'
      | 'startCommitSha'
      | 'expectedBranch'
      | 'baseBranch'
      | 'resolveProfile'
      | 'idFactory'
      | 'readWorktreeFile'
      | 'deleteWorktreeFile'
      | 'cleanReviewFixtureStore'
      | 'worktreeLifecycle'
      | 'eventRepository'
      | 'inboundPreserveAllowance'
      | 'approvedInboundPaths'
      | 'repair'
      | 'priorPhaseName'
      | 'selfVerifyCommands'
      | 'allowProtectedPaths'
      | 'batchIssueNumbers'
    >
  >,
) => PhaseHandlerContext;

export function buildPhaseHandlerContext(
  base: Omit<
    PhaseHandlerContext,
    | 'executionPolicy'
    | 'promptsRoot'
    | 'startCommitSha'
    | 'expectedBranch'
    | 'baseBranch'
    | 'resolveProfile'
    | 'idFactory'
    | 'readWorktreeFile'
    | 'deleteWorktreeFile'
    | 'cleanReviewFixtureStore'
    | 'worktreeLifecycle'
    | 'eventRepository'
    | 'inboundPreserveAllowance'
    | 'approvedInboundPaths'
    | 'repair'
    | 'priorPhaseName'
    | 'selfVerifyCommands'
    | 'allowProtectedPaths'
    | 'batchIssueNumbers'
  >,
  opts?: Partial<
    Pick<
      PhaseHandlerContext,
      | 'executionPolicy'
      | 'promptsRoot'
      | 'startCommitSha'
      | 'expectedBranch'
      | 'baseBranch'
      | 'resolveProfile'
      | 'idFactory'
      | 'readWorktreeFile'
      | 'deleteWorktreeFile'
      | 'cleanReviewFixtureStore'
      | 'worktreeLifecycle'
      | 'eventRepository'
      | 'inboundPreserveAllowance'
      | 'approvedInboundPaths'
      | 'repair'
      | 'priorPhaseName'
      | 'selfVerifyCommands'
      | 'allowProtectedPaths'
      | 'batchIssueNumbers'
    >
  >,
): PhaseHandlerContext {
  return { ...base, ...opts };
}
