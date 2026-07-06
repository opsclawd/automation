import type {
  PhaseName,
  Failure,
  AgentProfileName,
  AgentRuntimeKind,
} from '@ai-sdlc/domain';
import type { ArtifactStore } from '../ports/artifact-store.js';
import type { GitHubPort } from '../ports/github-port.js';
import type { GitPort } from '../ports/git-port.js';
import type { AgentPort } from '../ports/agent-port.js';
import type { EventBusPort } from '../ports/event-bus-port.js';

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
  promptsRoot?: string;
  startCommitSha?: string;
  expectedBranch?: string;
  baseBranch?: string;
  modelOverride?: string;
  runtimeOverride?: AgentRuntimeKind;
  resolveProfile?: (phase: string) => AgentProfileName;
  idFactory?: () => string;
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
    | 'promptsRoot'
    | 'startCommitSha'
    | 'expectedBranch'
    | 'baseBranch'
    | 'modelOverride'
    | 'runtimeOverride'
    | 'resolveProfile'
    | 'idFactory'
  >,
  opts?: Partial<
    Pick<
      PhaseHandlerContext,
      | 'promptsRoot'
      | 'startCommitSha'
      | 'expectedBranch'
      | 'baseBranch'
      | 'modelOverride'
      | 'runtimeOverride'
      | 'resolveProfile'
      | 'idFactory'
    >
  >,
) => PhaseHandlerContext;

export function buildPhaseHandlerContext(
  base: Omit<
    PhaseHandlerContext,
    | 'promptsRoot'
    | 'startCommitSha'
    | 'expectedBranch'
    | 'baseBranch'
    | 'modelOverride'
    | 'runtimeOverride'
    | 'resolveProfile'
    | 'idFactory'
  >,
  opts?: Partial<
    Pick<
      PhaseHandlerContext,
      | 'promptsRoot'
      | 'startCommitSha'
      | 'expectedBranch'
      | 'baseBranch'
      | 'modelOverride'
      | 'runtimeOverride'
      | 'resolveProfile'
      | 'idFactory'
    >
  >,
): PhaseHandlerContext {
  return { ...base, ...opts };
}
