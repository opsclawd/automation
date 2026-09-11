import type { ValidationCommandOutcome } from '@ai-sdlc/domain';

export interface RevalidationResult {
  validationRunId: string;
  passed: boolean;
  category?: string; // 'build' | 'lint' | 'typecheck' | 'test' | 'other'
  failureDetail?: string | undefined;
  outcome?: ValidationCommandOutcome;
  failedCommands?: string[];
}

export interface ArchitectPlanTask {
  task_id: string;
  approach: string;
  conflicts_resolved: string[];
  constraints: string[];
  depends_on: string[];
}

export interface ArchitectPlan {
  version: number;
  tasks: ArchitectPlanTask[];
}

export interface FixStepOptions {
  useFallback: boolean;
  previousInvocationId?: string;
  architectPlan?: ArchitectPlan;
  reconciliationContext?: string;
  historyContext?: string;
  deterministicDiagnostic?: string;
  attemptKind?: 'standard' | 'deterministic';
  allowedFiles?: string[];
}
