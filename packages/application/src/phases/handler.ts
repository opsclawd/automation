import type { PhaseName, Failure, AgentProfileName } from '@ai-sdlc/domain';
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
  promptsRoot?: string;
  startCommitSha?: string;
  expectedBranch?: string;
  resolveProfile?: (phase: string) => AgentProfileName;
  idFactory?: () => string;
}

export type PhaseOutcome = 'passed' | 'failed' | 'blocked' | 'skipped';

export type PhaseResult =
  | { outcome: 'passed' | 'skipped' }
  | { outcome: 'failed' | 'blocked'; failure: Failure };

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
    'promptsRoot' | 'startCommitSha' | 'expectedBranch' | 'resolveProfile' | 'idFactory'
  >,
  opts?: Partial<
    Pick<
      PhaseHandlerContext,
      'promptsRoot' | 'startCommitSha' | 'expectedBranch' | 'resolveProfile' | 'idFactory'
    >
  >,
) => PhaseHandlerContext;

export function buildPhaseHandlerContext(
  base: Omit<
    PhaseHandlerContext,
    'promptsRoot' | 'startCommitSha' | 'expectedBranch' | 'resolveProfile' | 'idFactory'
  >,
  opts?: Partial<
    Pick<
      PhaseHandlerContext,
      'promptsRoot' | 'startCommitSha' | 'expectedBranch' | 'resolveProfile' | 'idFactory'
    >
  >,
): PhaseHandlerContext {
  return { ...base, ...opts };
}
