import type { RunId, PhaseName, AgentProfileName, Loop } from '@ai-sdlc/domain';
import type { LoopRepositoryPort } from '../ports/loop-repository-port.js';
import type { EventBusPort } from '../ports/event-bus-port.js';
import type { StepAgentOutcome } from '../ports/agent-invocation-types.js';
import type { FixStepOptions, RevalidationResult } from '../review-fix/types.js';
import type { GitPort } from '../ports/git-port.js';
import type { ArtifactStore, ReadWorktreeFilePort } from '../ports.js';
import type { TaskManifest } from '../results/schemas/task-manifest.js';

export interface ValidateFixStepContext {
  loopId: string;
  runId: RunId;
  phaseId: PhaseName;
  repoId: string;
  cwd: string;
  iterationIndex: number;
}

export interface ValidateFixAgentResult {
  invocationId: string;
  agentOutcome: StepAgentOutcome;
  verdict?: 'fixed' | 'cannot_fix' | 'no_fixes_needed';
  headBeforeFix?: string;
}

export interface ValidateFixLoopDeps {
  runFix: (ctx: ValidateFixStepContext, opts: FixStepOptions) => Promise<ValidateFixAgentResult>;
  runRevalidation: (ctx: ValidateFixStepContext) => Promise<RevalidationResult>;
  loops: LoopRepositoryPort;
  events: EventBusPort;
  now: () => Date;
  idFactory: () => string;
  rollbackFix?: (ctx: ValidateFixStepContext, targetSha: string) => Promise<boolean>;
  git?: GitPort;
  artifactStore?: ArtifactStore;
  readWorktreeFile?: ReadWorktreeFilePort;
}

export interface ValidateFixLoopInput {
  runId: RunId;
  phaseId: PhaseName;
  repoId: string;
  cwd: string;
  maxIterations: number;
  fixProfile: AgentProfileName;
  fixFallbackProfile?: AgentProfileName;
  manifest?: TaskManifest;
}

export interface ValidateFixLoopResult {
  loop: Loop;
  phaseOutcome: 'passed' | 'failed';
}
