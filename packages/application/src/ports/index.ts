export type { RepositoryPort } from './repository-port.js';
export type { JobQueuePort, EnqueueJobInput, ClaimNextInput } from './job-queue-port.js';
export type { WorkerRegistryPort } from './worker-registry-port.js';
export type {
  WorkerLeasePort,
  AcquireLeaseInput,
  ReclaimExpiredInput,
} from './worker-lease-port.js';
export type {
  GitHubPort,
  GitHubIssue,
  PullRequest,
  PullRequestDetail,
  PullRequestReview,
  GitHubReviewComment,
  CreatePullRequestInput,
} from './github-port.js';
export type { GitPort, CreateWorktreeInput, PushInput, ArtifactGuardPort } from './git-port.js';
export { TrackedSourceDriftError } from './git-port.js';
export type {
  ValidationPort,
  RunValidationInput,
  ValidationCommandResult,
} from './validation-port.js';
export type { ValidationRunRepositoryPort } from './validation-run-repository-port.js';
export type { PrReviewRepositoryPort } from './pr-review-repository-port.js';
export type { ArtifactStore, WriteArtifactInput, Artifact } from './artifact-store.js';
export { ArtifactNotFoundError } from './artifact-store.js';
export type { AgentPort } from './agent-port.js';
export type {
  AgentInvocationOutcome,
  AgentInvocationRequest,
  AgentInvocationResult,
} from './agent-invocation-types.js';
export { AgentProfileName } from './agent-invocation-types.js';
export { CONTRACT_VIOLATION_CODES } from './contract-violation-codes.js';
export type { AgentInvocationPort, AgentInvocationUpdatePatch } from './agent-invocation-port.js';
export type { EventBusPort } from './event-bus-port.js';

export type { AgentRuntimeKind } from '@ai-sdlc/domain';
export type { AgentUsagePort } from './agent-usage-port.js';
export type {
  ImplementArtifactGuardPort,
  ImplementArtifactGuardInput,
  SynthesizedArtifact,
} from './implement-artifact-guard-port.js';
export type {
  FixDiffInspectorPort,
  FixDiffInspectorInput,
  FixDiffInspectionResult,
} from './fix-diff-inspector-port.js';
export type {
  FindingEvidence,
  FindingEvidenceCheckInput,
  FindingEvidenceCheckResult,
  FindingEvidenceInspectorPort,
} from './finding-evidence-inspector-port.js';
export type { LoopRepositoryPort } from './loop-repository-port.js';
export type { StepRepositoryPort } from './step-repository-port.js';
export type { PhaseRepositoryPort } from './phase-repository-port.js';

// Run-repository port contract still lives in the legacy monolithic ports.ts.
// Re-exported here so infrastructure can depend on it via the `ports/` barrel
// — the only application path infra may import (depcruise rule
// `infrastructure-may-only-import-application-ports`).
export type {
  RunRepositoryPort,
  RunRepositoryUpdatePatch,
  RunRecord,
  FileTailerOptions,
  FileTailerPort,
} from '../ports.js';
