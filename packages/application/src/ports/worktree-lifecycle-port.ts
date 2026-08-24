export type WorktreeLifecycleMode = 'phase_boundary' | 'resume_baseline';

export interface InspectWorktreeLifecycleInput {
  cwd: string;
  mode: WorktreeLifecycleMode;
  targetBaseline?: string;
}

export interface WorktreeLifecyclePlan {
  mode: WorktreeLifecycleMode;
  cwd: string;
  targetBaseline?: string;
  fingerprint: string;
  discardedPaths: string[];
  preservedPaths: string[];
  trackedChanges: string[];
  untrackedPaths: string[];
}

export interface ExecuteWorktreeLifecyclePlanInput {
  plan: WorktreeLifecyclePlan;
}

export interface WorktreeLifecycleExecutionResult {
  success: boolean;
  discardedPaths: string[];
  preservedPaths: string[];
  headSha?: string;
}

export interface WorktreeLifecyclePort {
  inspect(input: InspectWorktreeLifecycleInput): Promise<WorktreeLifecyclePlan>;
  execute(input: ExecuteWorktreeLifecyclePlanInput): Promise<WorktreeLifecycleExecutionResult>;
}
