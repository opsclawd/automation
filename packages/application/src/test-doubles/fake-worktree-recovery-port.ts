import type {
  WorktreeRecoveryPort,
  PrepareWorktreeRecoveryInput,
  WorktreeRecoveryOutcome,
} from '../ports/worktree-recovery-port.js';

export class FakeWorktreeRecoveryPort implements WorktreeRecoveryPort {
  prepareCalls: PrepareWorktreeRecoveryInput[] = [];
  outcomes: WorktreeRecoveryOutcome[] = [];
  prepareShouldThrow = new Set<string>();

  async prepare(input: PrepareWorktreeRecoveryInput): Promise<WorktreeRecoveryOutcome> {
    this.prepareCalls.push(input);
    if (this.prepareShouldThrow.has(input.worktreePath)) {
      throw new Error(`fake prepare failure for ${input.worktreePath}`);
    }
    const outcome = this.outcomes.shift();
    if (!outcome) {
      return { safe: true, action: 'reset', path: input.worktreePath };
    }
    return outcome;
  }
}
