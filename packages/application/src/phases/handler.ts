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
  startCommitSha?: string;
  expectedBranch?: string;
  baseBranch?: string;
  resolveProfile?: (phase: string) => AgentProfileName;
  idFactory?: () => string;
  readWorktreeFile?: ReadWorktreeFilePort | undefined;
  deleteWorktreeFile?: DeleteWorktreeFilePort | undefined;
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
    | 'startCommitSha'
    | 'expectedBranch'
    | 'baseBranch'
    | 'resolveProfile'
    | 'idFactory'
    | 'readWorktreeFile'
    | 'deleteWorktreeFile'
    | 'worktreeLifecycle'
    | 'eventRepository'
    | 'inboundPreserveAllowance'
    | 'approvedInboundPaths'
    | 'repair'
    | 'priorPhaseName'
    | 'selfVerifyCommands'
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
      | 'worktreeLifecycle'
      | 'eventRepository'
      | 'inboundPreserveAllowance'
      | 'approvedInboundPaths'
      | 'repair'
      | 'priorPhaseName'
      | 'selfVerifyCommands'
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
    | 'worktreeLifecycle'
    | 'eventRepository'
    | 'inboundPreserveAllowance'
    | 'approvedInboundPaths'
    | 'repair'
    | 'priorPhaseName'
    | 'selfVerifyCommands'
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
      | 'worktreeLifecycle'
      | 'eventRepository'
      | 'inboundPreserveAllowance'
      | 'approvedInboundPaths'
      | 'repair'
      | 'priorPhaseName'
      | 'selfVerifyCommands'
    >
  >,
): PhaseHandlerContext {
  return { ...base, ...opts };
}
