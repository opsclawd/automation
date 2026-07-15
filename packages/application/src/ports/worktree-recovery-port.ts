import type { RepositoryId, RunId } from '@ai-sdlc/domain';

export type PrepareWorktreeRecoveryInput = {
  repoId: RepositoryId;
  runId: RunId;
  worktreePath: string;
  baseRef: string;
  quarantineRoot: string;
};

export type WorktreeRecoveryOutcome =
  | { safe: true; action: 'reset'; path: string }
  | { safe: true; action: 'quarantined'; path: string }
  | { safe: false; action: 'blocked'; path: string; error: string };

export interface WorktreeRecoveryPort {
  prepare(input: PrepareWorktreeRecoveryInput): Promise<WorktreeRecoveryOutcome>;
}
