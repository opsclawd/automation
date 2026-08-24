export type WorktreeLifecycleMode = 'phase_boundary' | 'resume_baseline';

export interface InspectWorktreeLifecycleInput {
  cwd: string;
  mode: WorktreeLifecycleMode;
  targetBaseline?: string;
  /**
   * Glob-style patterns (as produced by orchestratorExcludePatterns()) identifying
   * application-level artifact paths that must be treated as preserved rather than
   * discarded. Keeps orchestrator artifact knowledge in the application layer instead
   * of hardcoded in the infrastructure adapter.
   */
  preservedPatterns?: readonly string[];
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
