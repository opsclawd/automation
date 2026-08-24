import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { WorktreeLifecycleAdapter } from '../worktree-lifecycle-adapter.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function trackDir(dir: string): string {
  tempDirs.push(dir);
  return dir;
}

function initRepo(): { repoDir: string; execGit: (args: string[]) => string } {
  const repoDir = trackDir(mkdtempSync(join(tmpdir(), 'worktree-lifecycle-adapter-')));
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', repoDir], { stdio: 'pipe' });
  execFileSync('git', ['-C', repoDir, 'config', 'user.email', 'test@example.com'], {
    stdio: 'pipe',
  });
  execFileSync('git', ['-C', repoDir, 'config', 'user.name', 'Test User'], { stdio: 'pipe' });

  const execGit = (args: string[]) =>
    execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8' }).trim();

  return { repoDir, execGit };
}

describe('WorktreeLifecycleAdapter', () => {
  it('correctly inventories staged, unstaged, renamed, nested, and untracked changes', async () => {
    const { repoDir, execGit } = initRepo();
    const adapter = new WorktreeLifecycleAdapter();

    // Baseline commit
    mkdirSync(join(repoDir, 'src'), { recursive: true });
    writeFileSync(join(repoDir, 'src', 'tracked1.ts'), 'export const a = 1;\n');
    writeFileSync(join(repoDir, 'src', 'tracked2.ts'), 'export const b = 2;\n');
    writeFileSync(join(repoDir, 'src', 'to-rename.ts'), 'export const renameMe = true;\n');
    execGit(['add', '.']);
    execGit(['commit', '-m', 'chore: baseline']);

    // Staged change
    writeFileSync(join(repoDir, 'src', 'tracked1.ts'), 'export const a = 100;\n');
    execGit(['add', 'src/tracked1.ts']);

    // Unstaged change
    writeFileSync(join(repoDir, 'src', 'tracked2.ts'), 'export const b = 200;\n');

    // Rename (staged)
    execGit(['mv', 'src/to-rename.ts', 'src/renamed.ts']);

    // Nested untracked file
    mkdirSync(join(repoDir, 'packages', 'app', 'src'), { recursive: true });
    writeFileSync(
      join(repoDir, 'packages', 'app', 'src', 'nested-probe.ts'),
      'export const probe = true;\n',
    );

    // Root untracked file
    writeFileSync(join(repoDir, 'root-probe.ts'), 'export const rootProbe = true;\n');

    const plan = await adapter.inspect({
      cwd: repoDir,
      mode: 'phase_boundary',
    });

    expect(plan.mode).toBe('phase_boundary');
    expect(plan.cwd).toBe(repoDir);
    expect(plan.fingerprint).toBeDefined();

    expect(plan.trackedChanges).toEqual([
      'src/renamed.ts',
      'src/to-rename.ts',
      'src/tracked1.ts',
      'src/tracked2.ts',
    ]);
    expect(plan.untrackedPaths).toEqual(['packages/app/src/nested-probe.ts', 'root-probe.ts']);
    expect(plan.discardedPaths).toEqual([
      'packages/app/src/nested-probe.ts',
      'root-probe.ts',
      'src/renamed.ts',
      'src/to-rename.ts',
      'src/tracked1.ts',
      'src/tracked2.ts',
    ]);
    expect(plan.preservedPaths).toEqual([]);
  });

  it('preserves canonical orchestrator artifacts and .gitignore during inspection and execution', async () => {
    const { repoDir, execGit } = initRepo();
    const adapter = new WorktreeLifecycleAdapter();

    // Baseline commit
    writeFileSync(join(repoDir, '.gitignore'), 'node_modules\n');
    writeFileSync(join(repoDir, 'src-file.ts'), 'export const v = 1;\n');
    execGit(['add', '.']);
    execGit(['commit', '-m', 'chore: baseline']);
    const baselineSha = execGit(['rev-parse', 'HEAD']);

    // Create untracked artifacts and .gitignore change and disposable probe
    writeFileSync(join(repoDir, 'task-manifest.json'), '{"version": 2}\n');
    writeFileSync(join(repoDir, 'plan.md'), '# Plan\n');
    writeFileSync(join(repoDir, 'review-triage.md'), '# Triage\n');
    writeFileSync(join(repoDir, 'scratch-probe.ts'), 'export const probe = true;\n');
    mkdirSync(join(repoDir, 'apps', 'web'), { recursive: true });
    writeFileSync(join(repoDir, 'apps', 'web', 'test-probe.ts'), 'export const webProbe = true;\n');

    // Modifying tracked file
    writeFileSync(join(repoDir, 'src-file.ts'), 'export const v = 2;\n');

    const plan = await adapter.inspect({
      cwd: repoDir,
      mode: 'phase_boundary',
    });

    expect(plan.preservedPaths).toEqual(['plan.md', 'review-triage.md', 'task-manifest.json']);
    expect(plan.discardedPaths).toEqual([
      'apps/web/test-probe.ts',
      'scratch-probe.ts',
      'src-file.ts',
    ]);

    const result = await adapter.execute({ plan });

    expect(result.success).toBe(true);
    expect(result.discardedPaths).toEqual([
      'apps/web/test-probe.ts',
      'scratch-probe.ts',
      'src-file.ts',
    ]);
    expect(result.preservedPaths).toEqual(['plan.md', 'review-triage.md', 'task-manifest.json']);

    // Preserved files must still exist on disk
    expect(existsSync(join(repoDir, '.gitignore'))).toBe(true);
    expect(existsSync(join(repoDir, 'task-manifest.json'))).toBe(true);
    expect(existsSync(join(repoDir, 'plan.md'))).toBe(true);
    expect(existsSync(join(repoDir, 'review-triage.md'))).toBe(true);

    // Discarded untracked files must be removed from disk
    expect(existsSync(join(repoDir, 'scratch-probe.ts'))).toBe(false);
    expect(existsSync(join(repoDir, 'apps', 'web', 'test-probe.ts'))).toBe(false);

    // Tracked file must be restored to baseline
    expect(readFileSync(join(repoDir, 'src-file.ts'), 'utf8')).toBe('export const v = 1;\n');

    // Branch HEAD is unchanged
    expect(execGit(['rev-parse', 'HEAD'])).toBe(baselineSha);
  });

  it('restores tracked files to current HEAD without moving branch in phase_boundary mode', async () => {
    const { repoDir, execGit } = initRepo();
    const adapter = new WorktreeLifecycleAdapter();

    writeFileSync(join(repoDir, 'file1.ts'), 'v1\n');
    writeFileSync(join(repoDir, 'file2.ts'), 'v1\n');
    execGit(['add', '.']);
    execGit(['commit', '-m', 'commit 1']);
    const headSha = execGit(['rev-parse', 'HEAD']);
    const currentBranch = execGit(['rev-parse', '--abbrev-ref', 'HEAD']);

    // Staged and unstaged edits
    writeFileSync(join(repoDir, 'file1.ts'), 'v2 staged\n');
    execGit(['add', 'file1.ts']);
    writeFileSync(join(repoDir, 'file2.ts'), 'v2 unstaged\n');
    writeFileSync(join(repoDir, 'untracked.ts'), 'untracked\n');

    const plan = await adapter.inspect({
      cwd: repoDir,
      mode: 'phase_boundary',
    });

    const result = await adapter.execute({ plan });

    expect(result.success).toBe(true);
    expect(execGit(['rev-parse', 'HEAD'])).toBe(headSha);
    expect(execGit(['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(currentBranch);
    expect(readFileSync(join(repoDir, 'file1.ts'), 'utf8')).toBe('v1\n');
    expect(readFileSync(join(repoDir, 'file2.ts'), 'utf8')).toBe('v1\n');
    expect(existsSync(join(repoDir, 'untracked.ts'))).toBe(false);
  });

  it('hard resets to an explicit resolvable ref in resume_baseline mode', async () => {
    const { repoDir, execGit } = initRepo();
    const adapter = new WorktreeLifecycleAdapter();

    writeFileSync(join(repoDir, 'file.ts'), 'baseline content\n');
    execGit(['add', '.']);
    execGit(['commit', '-m', 'initial baseline']);
    const baselineSha = execGit(['rev-parse', 'HEAD']);

    // Advance HEAD with a step commit
    writeFileSync(join(repoDir, 'file.ts'), 'step commit content\n');
    writeFileSync(join(repoDir, 'new-step-file.ts'), 'step file\n');
    execGit(['add', '.']);
    execGit(['commit', '-m', 'feat: step changes']);
    const stepSha = execGit(['rev-parse', 'HEAD']);
    expect(stepSha).not.toBe(baselineSha);

    // Also dirty the worktree
    writeFileSync(join(repoDir, 'uncommitted-probe.ts'), 'probe\n');

    const plan = await adapter.inspect({
      cwd: repoDir,
      mode: 'resume_baseline',
      targetBaseline: baselineSha,
    });

    expect(plan.targetBaseline).toBe(baselineSha);

    const result = await adapter.execute({ plan });

    expect(result.success).toBe(true);
    expect(execGit(['rev-parse', 'HEAD'])).toBe(baselineSha);
    expect(readFileSync(join(repoDir, 'file.ts'), 'utf8')).toBe('baseline content\n');
    expect(existsSync(join(repoDir, 'new-step-file.ts'))).toBe(false);
    expect(existsSync(join(repoDir, 'uncommitted-probe.ts'))).toBe(false);
  });

  it('rejects unresolvable targetBaseline ref in resume_baseline mode', async () => {
    const { repoDir, execGit } = initRepo();
    const adapter = new WorktreeLifecycleAdapter();

    writeFileSync(join(repoDir, 'file.ts'), 'initial\n');
    execGit(['add', '.']);
    execGit(['commit', '-m', 'initial']);

    await expect(
      adapter.inspect({
        cwd: repoDir,
        mode: 'resume_baseline',
        targetBaseline: 'nonexistent-ref-0000000000000000000000000000000000000000',
      }),
    ).rejects.toThrow(/unresolvable/i);
  });

  it('rejects path traversal attempts', async () => {
    const { repoDir, execGit } = initRepo();
    const adapter = new WorktreeLifecycleAdapter();

    writeFileSync(join(repoDir, 'file.ts'), 'initial\n');
    execGit(['add', '.']);
    execGit(['commit', '-m', 'initial']);

    const maliciousPlan = {
      mode: 'phase_boundary' as const,
      cwd: repoDir,
      fingerprint: 'some-fingerprint',
      discardedPaths: ['../../outside-file.txt'],
      preservedPaths: [],
      trackedChanges: [],
      untrackedPaths: ['../../outside-file.txt'],
    };

    await expect(adapter.execute({ plan: maliciousPlan })).rejects.toThrow(/travers/i);
  });

  it('rejects execution when snapshot drifts between inspection and mutation', async () => {
    const { repoDir, execGit } = initRepo();
    const adapter = new WorktreeLifecycleAdapter();

    writeFileSync(join(repoDir, 'file.ts'), 'initial\n');
    execGit(['add', '.']);
    execGit(['commit', '-m', 'initial']);

    // Create untracked file
    writeFileSync(join(repoDir, 'probe1.ts'), 'probe1\n');

    const plan = await adapter.inspect({
      cwd: repoDir,
      mode: 'phase_boundary',
    });

    // Drift occurs: new file created before execute
    writeFileSync(join(repoDir, 'probe2.ts'), 'probe2\n');

    await expect(adapter.execute({ plan })).rejects.toThrow(/drift/i);

    // No mutation should have occurred on probe1.ts
    expect(existsSync(join(repoDir, 'probe1.ts'))).toBe(true);
    expect(existsSync(join(repoDir, 'probe2.ts'))).toBe(true);
  });

  it('preserves modifications to tracked files like .gitignore while reverting discarded tracked changes', async () => {
    const { repoDir, execGit } = initRepo();
    const adapter = new WorktreeLifecycleAdapter();

    writeFileSync(join(repoDir, '.gitignore'), 'node_modules\n');
    writeFileSync(join(repoDir, 'src-file.ts'), 'export const v = 1;\n');
    execGit(['add', '.']);
    execGit(['commit', '-m', 'chore: baseline']);
    const baselineSha = execGit(['rev-parse', 'HEAD']);

    // Modify tracked .gitignore (preserved) and tracked src-file.ts (discarded)
    writeFileSync(join(repoDir, '.gitignore'), 'node_modules\n.ai-tmp/\n');
    writeFileSync(join(repoDir, 'src-file.ts'), 'export const v = 99;\n');

    const plan = await adapter.inspect({
      cwd: repoDir,
      mode: 'phase_boundary',
    });

    expect(plan.preservedPaths).toEqual(['.gitignore']);
    expect(plan.discardedPaths).toEqual(['src-file.ts']);

    const result = await adapter.execute({ plan });

    expect(result.success).toBe(true);
    expect(execGit(['rev-parse', 'HEAD'])).toBe(baselineSha);
    // .gitignore modifications must be preserved
    expect(readFileSync(join(repoDir, '.gitignore'), 'utf8')).toBe('node_modules\n.ai-tmp/\n');
    // src-file.ts must be reverted to baseline
    expect(readFileSync(join(repoDir, 'src-file.ts'), 'utf8')).toBe('export const v = 1;\n');
  });

  it('cleans up staged new files and renames in phase_boundary mode without postcondition failure', async () => {
    const { repoDir, execGit } = initRepo();
    const adapter = new WorktreeLifecycleAdapter();

    mkdirSync(join(repoDir, 'src'), { recursive: true });
    writeFileSync(join(repoDir, 'src', 'to-rename.ts'), 'export const original = true;\n');
    execGit(['add', '.']);
    execGit(['commit', '-m', 'chore: baseline']);
    const baselineSha = execGit(['rev-parse', 'HEAD']);

    // Staged new file
    writeFileSync(join(repoDir, 'src', 'staged-new.ts'), 'export const stagedNew = true;\n');
    execGit(['add', 'src/staged-new.ts']);

    // Staged rename
    execGit(['mv', 'src/to-rename.ts', 'src/renamed.ts']);

    const plan = await adapter.inspect({
      cwd: repoDir,
      mode: 'phase_boundary',
    });

    expect(plan.discardedPaths).toEqual([
      'src/renamed.ts',
      'src/staged-new.ts',
      'src/to-rename.ts',
    ]);

    const result = await adapter.execute({ plan });

    expect(result.success).toBe(true);
    expect(execGit(['rev-parse', 'HEAD'])).toBe(baselineSha);
    expect(existsSync(join(repoDir, 'src', 'staged-new.ts'))).toBe(false);
    expect(existsSync(join(repoDir, 'src', 'renamed.ts'))).toBe(false);
    expect(existsSync(join(repoDir, 'src', 'to-rename.ts'))).toBe(true);
    expect(readFileSync(join(repoDir, 'src', 'to-rename.ts'), 'utf8')).toBe(
      'export const original = true;\n',
    );
  });

  it('restores tracked preserved file if it was renamed to an unpreserved name', async () => {
    const { repoDir, execGit } = initRepo();
    const adapter = new WorktreeLifecycleAdapter();

    writeFileSync(join(repoDir, '.gitignore'), 'node_modules\n');
    execGit(['add', '.']);
    execGit(['commit', '-m', 'chore: baseline']);
    const baselineSha = execGit(['rev-parse', 'HEAD']);

    // Staged rename of preserved file
    execGit(['mv', '.gitignore', 'unpreserved-gitignore.txt']);

    const plan = await adapter.inspect({
      cwd: repoDir,
      mode: 'phase_boundary',
    });

    expect(plan.preservedPaths).toEqual(['.gitignore']);
    expect(plan.discardedPaths).toEqual(['unpreserved-gitignore.txt']);

    const result = await adapter.execute({ plan });

    expect(result.success).toBe(true);
    expect(execGit(['rev-parse', 'HEAD'])).toBe(baselineSha);
    expect(existsSync(join(repoDir, 'unpreserved-gitignore.txt'))).toBe(false);
    expect(existsSync(join(repoDir, '.gitignore'))).toBe(true);
    expect(readFileSync(join(repoDir, '.gitignore'), 'utf8')).toBe('node_modules\n');
  });

  it('handles chunked checkout when reverting over 500 modified tracked files', async () => {
    const { repoDir, execGit } = initRepo();
    const adapter = new WorktreeLifecycleAdapter();

    const fileCount = 520;
    mkdirSync(join(repoDir, 'bulk'), { recursive: true });
    for (let i = 0; i < fileCount; i++) {
      writeFileSync(join(repoDir, 'bulk', `file-${i}.txt`), `v1-${i}\n`);
    }
    execGit(['add', '.']);
    execGit(['commit', '-m', 'chore: add bulk files']);
    const baselineSha = execGit(['rev-parse', 'HEAD']);

    // Modify all 520 files
    for (let i = 0; i < fileCount; i++) {
      writeFileSync(join(repoDir, 'bulk', `file-${i}.txt`), `modified-${i}\n`);
    }

    const plan = await adapter.inspect({
      cwd: repoDir,
      mode: 'phase_boundary',
    });

    expect(plan.discardedPaths).toHaveLength(fileCount);

    const result = await adapter.execute({ plan });

    expect(result.success).toBe(true);
    expect(execGit(['rev-parse', 'HEAD'])).toBe(baselineSha);
    expect(readFileSync(join(repoDir, 'bulk', 'file-0.txt'), 'utf8')).toBe('v1-0\n');
    expect(readFileSync(join(repoDir, 'bulk', `file-${fileCount - 1}.txt`), 'utf8')).toBe(
      `v1-${fileCount - 1}\n`,
    );
  });

  it('deletes multiple untracked files concurrently in resume_baseline mode', async () => {
    const { repoDir, execGit } = initRepo();
    const adapter = new WorktreeLifecycleAdapter();

    writeFileSync(join(repoDir, 'base.txt'), 'base\n');
    execGit(['add', '.']);
    execGit(['commit', '-m', 'initial']);
    const baselineSha = execGit(['rev-parse', 'HEAD']);

    // Create untracked files
    mkdirSync(join(repoDir, 'temp'), { recursive: true });
    for (let i = 0; i < 20; i++) {
      writeFileSync(join(repoDir, 'temp', `temp-${i}.txt`), `temp-${i}\n`);
    }

    const plan = await adapter.inspect({
      cwd: repoDir,
      mode: 'resume_baseline',
      targetBaseline: baselineSha,
    });

    expect(plan.untrackedPaths).toHaveLength(20);

    const result = await adapter.execute({ plan });

    expect(result.success).toBe(true);
    for (let i = 0; i < 20; i++) {
      expect(existsSync(join(repoDir, 'temp', `temp-${i}.txt`))).toBe(false);
    }
  });
});
