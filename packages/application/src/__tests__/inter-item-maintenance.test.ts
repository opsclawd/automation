import { describe, it, expect, vi } from 'vitest';
import { InterItemMaintenanceService } from '../inter-item-maintenance.js';
import { FakeGitPort } from '../test-doubles/fake-git-port.js';
import { FakeEnvironmentHealthPort } from '../test-doubles/fake-environment-health-port.js';

describe('InterItemMaintenanceService', () => {
  it('successfully cleans worktree, reaps processes, cleans temp, and passes health checks', async () => {
    const git = new FakeGitPort();
    const health = new FakeEnvironmentHealthPort();
    const orphanReaper = {
      execute: vi.fn(() => ({ reaped: 2, pids: [1234, 5678] })),
    };
    const cleanupTemp = vi.fn(async (_runUuid: string) => {});

    git.worktrees.push('/repo/.ai-worktrees/issue-101');

    const service = new InterItemMaintenanceService({
      git,
      health,
      orphanReaper,
      cleanupTemp,
    });

    const result = await service.execute({
      repoLocalBasePath: '/repo',
      completedIssueNumber: 101,
      completedRunUuid: 'run-101',
    });

    expect(result.success).toBe(true);
    expect(result.reapedProcesses).toBe(2);
    expect(result.worktreeRemoved).toBe(true);
    expect(orphanReaper.execute).toHaveBeenCalledTimes(1);
    expect(cleanupTemp).toHaveBeenCalledWith('run-101');
    expect(git.worktrees).not.toContain('/repo/.ai-worktrees/issue-101');
  });

  it('fails with environment_unhealthy when disk free space is below safety floor', async () => {
    const git = new FakeGitPort();
    const health = new FakeEnvironmentHealthPort();
    health.diskFreeMb = 1024; // Less than 2048 MB floor

    const service = new InterItemMaintenanceService({
      git,
      health,
      minDiskFreeMb: 2048,
    });

    const result = await service.execute({
      repoLocalBasePath: '/repo',
      completedIssueNumber: 101,
    });

    expect(result.success).toBe(false);
    expect(result.reason).toContain('Disk free space (1024MB) is below required floor (2048MB)');
  });

  it('fails with environment_unhealthy when memory is below threshold', async () => {
    const git = new FakeGitPort();
    const health = new FakeEnvironmentHealthPort();
    health.memoryAvailableMb = 2048; // Less than 4096 MB threshold

    const service = new InterItemMaintenanceService({
      git,
      health,
      minMemoryAvailableMb: 4096,
    });

    const result = await service.execute({
      repoLocalBasePath: '/repo',
      completedIssueNumber: 101,
    });

    expect(result.success).toBe(false);
    expect(result.reason).toContain('Available memory (2048MB) is below required floor (4096MB)');
  });

  it('tolerates non-fatal worktree removal errors and continues maintenance', async () => {
    const git = new FakeGitPort();
    const health = new FakeEnvironmentHealthPort();
    // worktree not present in git.worktrees -> removeWorktree will throw
    const service = new InterItemMaintenanceService({
      git,
      health,
    });

    const result = await service.execute({
      repoLocalBasePath: '/repo',
      completedIssueNumber: 999,
    });

    expect(result.success).toBe(true);
    expect(result.worktreeRemoved).toBe(false);
  });
});
