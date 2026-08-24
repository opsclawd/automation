import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { revertScopeFiles } from '../revert-scope-files.js';

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
  const repoDir = trackDir(mkdtempSync(join(tmpdir(), 'revert-scope-files-')));
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', repoDir], { stdio: 'pipe' });
  execFileSync('git', ['-C', repoDir, 'config', 'user.email', 'test@example.com'], {
    stdio: 'pipe',
  });
  execFileSync('git', ['-C', repoDir, 'config', 'user.name', 'Test User'], { stdio: 'pipe' });

  const execGit = (args: string[]) =>
    execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8' }).trim();

  return { repoDir, execGit };
}

describe('revertScopeFiles', () => {
  it('refuses to amend when expectedHeadSha differs from HEAD', async () => {
    const { repoDir, execGit } = initRepo();

    writeFileSync(join(repoDir, '.gitignore'), '/node_modules\n');
    execGit(['add', '.']);
    execGit(['commit', '-m', 'chore: baseline']);
    const baselineSha = execGit(['rev-parse', 'HEAD']);

    writeFileSync(join(repoDir, '.gitignore'), '/dist\n');
    execGit(['add', '.']);
    execGit(['commit', '-m', 'feat: step commit']);
    const actualHeadSha = execGit(['rev-parse', 'HEAD']);

    const staleExpectedHeadSha = '0000000000000000000000000000000000000000';

    await expect(
      revertScopeFiles({
        cwd: repoDir,
        baseline: baselineSha,
        expectedHeadSha: staleExpectedHeadSha,
        rewriteSafety: 'unpublished',
        scopeFiles: ['.gitignore'],
      }),
    ).rejects.toThrow(/expected HEAD.*does not match current HEAD/i);

    expect(execGit(['rev-parse', 'HEAD'])).toBe(actualHeadSha);
    expect(readFileSync(join(repoDir, '.gitignore'), 'utf8')).toBe('/dist\n');
  });

  it('refuses to amend when rewriteSafety is not unpublished', async () => {
    const { repoDir, execGit } = initRepo();

    writeFileSync(join(repoDir, '.gitignore'), '/node_modules\n');
    execGit(['add', '.']);
    execGit(['commit', '-m', 'chore: baseline']);
    const baselineSha = execGit(['rev-parse', 'HEAD']);

    writeFileSync(join(repoDir, '.gitignore'), '/dist\n');
    execGit(['add', '.']);
    execGit(['commit', '-m', 'feat: step commit']);
    const actualHeadSha = execGit(['rev-parse', 'HEAD']);

    await expect(
      revertScopeFiles({
        cwd: repoDir,
        baseline: baselineSha,
        expectedHeadSha: actualHeadSha,
        rewriteSafety: 'published' as unknown as 'unpublished',
        scopeFiles: ['.gitignore'],
      }),
    ).rejects.toThrow(/rewriteSafety must be "unpublished"/i);

    expect(execGit(['rev-parse', 'HEAD'])).toBe(actualHeadSha);
  });

  it('restores a baseline-present scope path and preserves unrelated in-scope work', async () => {
    const { repoDir, execGit } = initRepo();

    // Baseline commit with protected files and source file
    const baselineGitignore = '# Baseline gitignore\n/artifacts.log\n';
    const baselineOrchestratorJson = '{"version": 1}\n';
    const baselineSource = 'console.log("hello");\n';

    writeFileSync(join(repoDir, '.gitignore'), baselineGitignore);
    writeFileSync(join(repoDir, '.ai-orchestrator.json'), baselineOrchestratorJson);
    mkdirSync(join(repoDir, 'src'), { recursive: true });
    writeFileSync(join(repoDir, 'src', 'index.ts'), baselineSource);

    execGit(['add', '.']);
    execGit(['commit', '-m', 'chore: baseline commit']);
    const baselineSha = execGit(['rev-parse', 'HEAD']);

    // Step mutates protected files and source file
    writeFileSync(join(repoDir, '.gitignore'), '# Inverted gitignore\n!/artifacts.log\n');
    writeFileSync(join(repoDir, '.ai-orchestrator.json'), '{"version": 2}\n');
    writeFileSync(join(repoDir, 'src', 'index.ts'), 'console.log("hello world");\n');

    execGit(['add', '.']);
    execGit(['commit', '-m', 'feat: step changes']);
    const stepHeadSha = execGit(['rev-parse', 'HEAD']);

    const result = await revertScopeFiles({
      cwd: repoDir,
      baseline: baselineSha,
      expectedHeadSha: stepHeadSha,
      rewriteSafety: 'unpublished',
      scopeFiles: ['.gitignore', '.ai-orchestrator.json'],
    });

    // Verify result object
    expect(result.revertedScopeFiles).toEqual(['.ai-orchestrator.json', '.gitignore']);
    expect(result.removedNewlyIgnoredFiles).toEqual([]);
    expect(result.amendedHeadSha).toBeDefined();
    expect(result.amendedHeadSha).not.toBe(stepHeadSha);

    const currentHeadSha = execGit(['rev-parse', 'HEAD']);
    expect(result.amendedHeadSha).toBe(currentHeadSha);

    // Verify disk content restored to baseline
    expect(readFileSync(join(repoDir, '.gitignore'), 'utf8')).toBe(baselineGitignore);
    expect(readFileSync(join(repoDir, '.ai-orchestrator.json'), 'utf8')).toBe(
      baselineOrchestratorJson,
    );
    expect(readFileSync(join(repoDir, 'src', 'index.ts'), 'utf8')).toBe(
      'console.log("hello world");\n',
    );

    // Verify cumulative diff between baseline and current HEAD only contains src/index.ts
    const diffFiles = execGit(['diff', '--name-only', '-z', `${baselineSha}..${currentHeadSha}`])
      .split('\0')
      .filter(Boolean);
    expect(diffFiles).toEqual(['src/index.ts']);

    // Working directory should be clean
    expect(execGit(['status', '--porcelain'])).toBe('');
  });

  it('removes a baseline-absent scope directory recursively from index and worktree', async () => {
    const { repoDir, execGit } = initRepo();

    mkdirSync(join(repoDir, 'src'), { recursive: true });
    writeFileSync(join(repoDir, 'src', 'index.ts'), 'export const a = 1;\n');

    execGit(['add', '.']);
    execGit(['commit', '-m', 'chore: baseline commit']);
    const baselineSha = execGit(['rev-parse', 'HEAD']);

    // Step creates a nested scope directory and a feature file
    mkdirSync(join(repoDir, 'scratch-dir', 'nested'), { recursive: true });
    writeFileSync(
      join(repoDir, 'scratch-dir', 'nested', 'probe.ts'),
      'export const probe = true;\n',
    );
    writeFileSync(join(repoDir, 'scratch-dir', 'other.ts'), 'export const other = true;\n');
    writeFileSync(join(repoDir, 'src', 'feature.ts'), 'export const f = 2;\n');

    execGit(['add', '.']);
    execGit(['commit', '-m', 'feat: add scratch-dir and feature']);
    const stepHeadSha = execGit(['rev-parse', 'HEAD']);

    const result = await revertScopeFiles({
      cwd: repoDir,
      baseline: baselineSha,
      expectedHeadSha: stepHeadSha,
      rewriteSafety: 'unpublished',
      scopeFiles: ['scratch-dir'],
    });

    expect(result.revertedScopeFiles).toEqual(['scratch-dir']);
    expect(result.removedNewlyIgnoredFiles).toEqual([]);
    expect(result.amendedHeadSha).not.toBe(stepHeadSha);

    // Directory should be removed from disk and git tracking
    expect(existsSync(join(repoDir, 'scratch-dir'))).toBe(false);

    const trackedFiles = execGit(['ls-files', '-z']).split('\0').filter(Boolean);
    expect(trackedFiles).not.toContain('scratch-dir/nested/probe.ts');
    expect(trackedFiles).not.toContain('scratch-dir/other.ts');
    expect(trackedFiles).toContain('src/feature.ts');

    const diffFiles = execGit(['diff', '--name-only', '-z', `${baselineSha}..HEAD`])
      .split('\0')
      .filter(Boolean);
    expect(diffFiles).toEqual(['src/feature.ts']);

    expect(execGit(['status', '--porcelain'])).toBe('');
  });

  it('normalizes, removes empty entries, deduplicates, and sorts requested scope paths', async () => {
    const { repoDir, execGit } = initRepo();

    writeFileSync(join(repoDir, '.gitignore'), '/dist\n');
    mkdirSync(join(repoDir, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(repoDir, '.github', 'workflows', 'b.yml'), 'name: B\n');
    writeFileSync(join(repoDir, '.github', 'workflows', 'a.yml'), 'name: A\n');

    execGit(['add', '.']);
    execGit(['commit', '-m', 'chore: baseline commit']);
    const baselineSha = execGit(['rev-parse', 'HEAD']);

    // Step modifies .gitignore, a.yml, b.yml, and creates c.yml
    writeFileSync(join(repoDir, '.gitignore'), '/build\n');
    writeFileSync(join(repoDir, '.github', 'workflows', 'b.yml'), 'name: B modified\n');
    writeFileSync(join(repoDir, '.github', 'workflows', 'a.yml'), 'name: A modified\n');
    writeFileSync(join(repoDir, '.github', 'workflows', 'c.yml'), 'name: C new\n');

    execGit(['add', '.']);
    execGit(['commit', '-m', 'feat: step changes']);
    const stepHeadSha = execGit(['rev-parse', 'HEAD']);

    // Pass redundant, unnormalized, empty, and duplicate paths
    const result = await revertScopeFiles({
      cwd: repoDir,
      baseline: baselineSha,
      expectedHeadSha: stepHeadSha,
      rewriteSafety: 'unpublished',
      scopeFiles: [
        '.github/workflows/../workflows/b.yml',
        '.gitignore',
        '',
        '.github/workflows/c.yml',
        '   ',
        '.gitignore',
        '.github/workflows/a.yml',
      ],
    });

    expect(result.revertedScopeFiles).toEqual([
      '.github/workflows/a.yml',
      '.github/workflows/b.yml',
      '.github/workflows/c.yml',
      '.gitignore',
    ]);

    expect(existsSync(join(repoDir, '.github', 'workflows', 'c.yml'))).toBe(false);
    expect(readFileSync(join(repoDir, '.github', 'workflows', 'a.yml'), 'utf8')).toBe('name: A\n');
    expect(readFileSync(join(repoDir, '.github', 'workflows', 'b.yml'), 'utf8')).toBe('name: B\n');
    expect(readFileSync(join(repoDir, '.gitignore'), 'utf8')).toBe('/dist\n');
  });

  it('does not consume or report a repair when final verification finds a requested path still changed', async () => {
    const { repoDir, execGit } = initRepo();

    mkdirSync(join(repoDir, 'src'), { recursive: true });
    writeFileSync(join(repoDir, 'src', 'index.ts'), 'export const a = 1;\n');

    execGit(['add', '.']);
    execGit(['commit', '-m', 'chore: baseline commit']);
    const baselineSha = execGit(['rev-parse', 'HEAD']);

    // Step creates a non-goal file and a feature file
    writeFileSync(join(repoDir, 'src', 'unauthorized.ts'), 'export const bad = true;\n');
    writeFileSync(join(repoDir, 'src', 'index.ts'), 'export const a = 2;\n');

    execGit(['add', '.']);
    execGit(['commit', '-m', 'feat: add unauthorized and update index']);
    const stepHeadSha = execGit(['rev-parse', 'HEAD']);

    // Create a post-commit hook that re-creates the unauthorized file after commit --amend
    execGit(['config', 'core.hooksPath', '.git/hooks']);
    mkdirSync(join(repoDir, '.git', 'hooks'), { recursive: true });
    const hookPath = join(repoDir, '.git', 'hooks', 'post-commit');
    writeFileSync(
      hookPath,
      `#!/bin/sh\necho "re-created" > "${join(repoDir, 'src', 'unauthorized.ts')}"\n`,
      { mode: 0o755 },
    );

    // Attempting to revert should fail verification because unauthorized.ts is still modified/untracked in status
    await expect(
      revertScopeFiles({
        cwd: repoDir,
        baseline: baselineSha,
        expectedHeadSha: stepHeadSha,
        rewriteSafety: 'unpublished',
        scopeFiles: ['src/unauthorized.ts'],
      }),
    ).rejects.toThrow(/Scope repair verification failed/i);
  });

  it('removes only newly added ignored files while retaining pre-existing tracked ignored files', async () => {
    const { repoDir, execGit } = initRepo();

    // Baseline commit has .gitignore with rules and a pre-existing tracked ignored file
    const baselineGitignore = '/pre-existing-ignored.txt\n/newly-ignored.txt\n';
    writeFileSync(join(repoDir, '.gitignore'), baselineGitignore);
    writeFileSync(join(repoDir, 'pre-existing-ignored.txt'), 'pre-existing tracked content\n');
    mkdirSync(join(repoDir, 'src'), { recursive: true });
    writeFileSync(join(repoDir, 'src', 'index.ts'), 'export const base = 1;\n');

    // Force-track pre-existing-ignored.txt
    execGit(['add', '.gitignore', 'src/index.ts']);
    execGit(['add', '-f', 'pre-existing-ignored.txt']);
    execGit(['commit', '-m', 'chore: baseline commit']);
    const baselineSha = execGit(['rev-parse', 'HEAD']);

    // Step mutates .gitignore (e.g. un-ignoring /newly-ignored.txt) and adds newly-ignored.txt
    writeFileSync(join(repoDir, '.gitignore'), '# mutated\n/pre-existing-ignored.txt\n');
    writeFileSync(join(repoDir, 'newly-ignored.txt'), 'newly ignored content\n');
    writeFileSync(join(repoDir, 'src', 'work.ts'), 'export const work = 1;\n');

    execGit(['add', '.']);
    execGit(['commit', '-m', 'feat: step added newly-ignored and work']);
    const stepHeadSha = execGit(['rev-parse', 'HEAD']);

    const result = await revertScopeFiles({
      cwd: repoDir,
      baseline: baselineSha,
      expectedHeadSha: stepHeadSha,
      rewriteSafety: 'unpublished',
      scopeFiles: ['.gitignore'],
    });

    expect(result.revertedScopeFiles).toEqual(['.gitignore']);
    expect(result.removedNewlyIgnoredFiles).toEqual(['newly-ignored.txt']);

    // Pre-existing tracked ignored file must still be tracked
    const trackedFiles = execGit(['ls-files', '-z']).split('\0').filter(Boolean);
    expect(trackedFiles).toContain('pre-existing-ignored.txt');
    expect(trackedFiles).not.toContain('newly-ignored.txt');
    expect(trackedFiles).toContain('src/work.ts');

    // newly-ignored.txt must remain on disk
    expect(existsSync(join(repoDir, 'newly-ignored.txt'))).toBe(true);
    expect(readFileSync(join(repoDir, 'newly-ignored.txt'), 'utf8')).toBe(
      'newly ignored content\n',
    );

    // .gitignore must be restored to baseline
    expect(readFileSync(join(repoDir, '.gitignore'), 'utf8')).toBe(baselineGitignore);

    // Diff against baseline must contain only src/work.ts
    const diffFiles = execGit(['diff', '--name-only', '-z', `${baselineSha}..HEAD`])
      .split('\0')
      .filter(Boolean);
    expect(diffFiles).toEqual(['src/work.ts']);
  });

  it('keeps repaired artifact contents on disk while removing them from the amended commit', async () => {
    const { repoDir, execGit } = initRepo();

    // Baseline commit has .gitignore ignoring orchestrator artifacts
    const baselineGitignore = [
      '/task-manifest.json',
      '/design.md',
      '/plan.md',
      '/result.json',
      '',
    ].join('\n');
    writeFileSync(join(repoDir, '.gitignore'), baselineGitignore);
    mkdirSync(join(repoDir, 'src'), { recursive: true });
    writeFileSync(join(repoDir, 'src', 'app.ts'), 'export const app = 1;\n');

    execGit(['add', '.']);
    execGit(['commit', '-m', 'chore: baseline commit']);
    const baselineSha = execGit(['rev-parse', 'HEAD']);

    // Agent modifies .gitignore to un-ignore artifacts, creates artifacts, and updates source
    writeFileSync(
      join(repoDir, '.gitignore'),
      ['!/task-manifest.json', '!/design.md', '!/result.json', ''].join('\n'),
    );
    writeFileSync(join(repoDir, 'design.md'), '# Design document\n');
    writeFileSync(join(repoDir, 'task-manifest.json'), '{"version": 2}\n');
    writeFileSync(join(repoDir, 'result.json'), '{"outcome": "passed"}\n');
    writeFileSync(join(repoDir, 'src', 'app.ts'), 'export const app = 2;\n');

    execGit(['add', '.']);
    execGit(['commit', '-m', 'feat: un-ignore and add artifacts and app update']);
    const stepHeadSha = execGit(['rev-parse', 'HEAD']);

    const result = await revertScopeFiles({
      cwd: repoDir,
      baseline: baselineSha,
      expectedHeadSha: stepHeadSha,
      rewriteSafety: 'unpublished',
      scopeFiles: ['.gitignore'],
    });

    expect(result.revertedScopeFiles).toEqual(['.gitignore']);
    expect(result.removedNewlyIgnoredFiles).toEqual([
      'design.md',
      'result.json',
      'task-manifest.json',
    ]);

    // All artifacts must remain on disk with exact content
    expect(existsSync(join(repoDir, 'design.md'))).toBe(true);
    expect(readFileSync(join(repoDir, 'design.md'), 'utf8')).toBe('# Design document\n');
    expect(existsSync(join(repoDir, 'task-manifest.json'))).toBe(true);
    expect(readFileSync(join(repoDir, 'task-manifest.json'), 'utf8')).toBe('{"version": 2}\n');
    expect(existsSync(join(repoDir, 'result.json'))).toBe(true);
    expect(readFileSync(join(repoDir, 'result.json'), 'utf8')).toBe('{"outcome": "passed"}\n');

    // Artifacts must be untracked in Git
    const trackedFiles = execGit(['ls-files', '-z']).split('\0').filter(Boolean);
    expect(trackedFiles).not.toContain('design.md');
    expect(trackedFiles).not.toContain('task-manifest.json');
    expect(trackedFiles).not.toContain('result.json');
    expect(trackedFiles).toContain('src/app.ts');

    // Cumulative diff between baseline and HEAD contains only src/app.ts
    const diffFiles = execGit(['diff', '--name-only', '-z', `${baselineSha}..HEAD`])
      .split('\0')
      .filter(Boolean);
    expect(diffFiles).toEqual(['src/app.ts']);

    // Working copy status should be clean because artifacts are now ignored
    expect(execGit(['status', '--porcelain'])).toBe('');
  });

  it('preserves declared changes and the commit message across repair', async () => {
    const { repoDir, execGit } = initRepo();

    writeFileSync(join(repoDir, '.gitignore'), '/dist\n');
    mkdirSync(join(repoDir, 'src'), { recursive: true });
    writeFileSync(join(repoDir, 'src', 'feature.ts'), 'export const a = 1;\n');

    execGit(['add', '.']);
    execGit(['commit', '-m', 'chore: baseline commit']);
    const baselineSha = execGit(['rev-parse', 'HEAD']);

    // Step mutates .gitignore and makes declared changes with detailed commit message
    writeFileSync(join(repoDir, '.gitignore'), '/build\n');
    writeFileSync(join(repoDir, 'src', 'feature.ts'), 'export const a = 2;\nexport const b = 3;\n');
    writeFileSync(join(repoDir, 'src', 'extra.ts'), 'export const extra = true;\n');

    execGit(['add', '.']);
    const originalMessage = 'feat(core): implement core feature\n\n- added b\n- added extra';
    execGit(['commit', '-m', originalMessage]);
    const stepHeadSha = execGit(['rev-parse', 'HEAD']);

    const result = await revertScopeFiles({
      cwd: repoDir,
      baseline: baselineSha,
      expectedHeadSha: stepHeadSha,
      rewriteSafety: 'unpublished',
      scopeFiles: ['.gitignore'],
    });

    expect(result.revertedScopeFiles).toEqual(['.gitignore']);

    // Commit message must be exactly preserved
    const amendedMessage = execGit(['log', '-1', '--format=%B']);
    expect(amendedMessage).toBe(originalMessage);

    // Declared changes must be preserved in cumulative diff
    const diffFiles = execGit(['diff', '--name-only', '-z', `${baselineSha}..HEAD`])
      .split('\0')
      .filter(Boolean)
      .sort();
    expect(diffFiles).toEqual(['src/extra.ts', 'src/feature.ts']);
  });

  it('removes newly added files inside an existing baseline protected directory', async () => {
    const { repoDir, execGit } = initRepo();

    mkdirSync(join(repoDir, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(repoDir, '.github', 'workflows', 'ci.yml'), 'name: CI baseline\n');
    mkdirSync(join(repoDir, 'src'), { recursive: true });
    writeFileSync(join(repoDir, 'src', 'index.ts'), 'export const a = 1;\n');

    execGit(['add', '.']);
    execGit(['commit', '-m', 'chore: baseline commit']);
    const baselineSha = execGit(['rev-parse', 'HEAD']);

    // Step modifies ci.yml and adds an undeclared workflow file inside .github/workflows
    writeFileSync(join(repoDir, '.github', 'workflows', 'ci.yml'), 'name: CI modified\n');
    writeFileSync(join(repoDir, '.github', 'workflows', 'malicious.yml'), 'name: Malicious\n');
    writeFileSync(join(repoDir, 'src', 'index.ts'), 'export const a = 2;\n');

    execGit(['add', '.']);
    execGit(['commit', '-m', 'feat: add malicious workflow and modify ci']);
    const stepHeadSha = execGit(['rev-parse', 'HEAD']);

    const result = await revertScopeFiles({
      cwd: repoDir,
      baseline: baselineSha,
      expectedHeadSha: stepHeadSha,
      rewriteSafety: 'unpublished',
      scopeFiles: ['.github/workflows'],
    });

    expect(result.revertedScopeFiles).toEqual(['.github/workflows']);
    expect(existsSync(join(repoDir, '.github', 'workflows', 'malicious.yml'))).toBe(false);
    expect(readFileSync(join(repoDir, '.github', 'workflows', 'ci.yml'), 'utf8')).toBe(
      'name: CI baseline\n',
    );
    expect(readFileSync(join(repoDir, 'src', 'index.ts'), 'utf8')).toBe('export const a = 2;\n');

    const trackedFiles = execGit(['ls-files', '-z']).split('\0').filter(Boolean);
    expect(trackedFiles).not.toContain('.github/workflows/malicious.yml');
    expect(trackedFiles).toContain('.github/workflows/ci.yml');
    expect(trackedFiles).toContain('src/index.ts');

    const diffFiles = execGit(['diff', '--name-only', '-z', `${baselineSha}..HEAD`])
      .split('\0')
      .filter(Boolean);
    expect(diffFiles).toEqual(['src/index.ts']);
    expect(execGit(['status', '--porcelain'])).toBe('');
  });

  it('detects newly added files when git rename detection would classify them as renames', async () => {
    const { repoDir, execGit } = initRepo();

    const identicalContent = 'export const commonContent = "1234567890abcdef";\n';
    writeFileSync(join(repoDir, '.gitignore'), '/renamed-artifact.txt\n');
    writeFileSync(join(repoDir, 'deleted-file.txt'), identicalContent);
    mkdirSync(join(repoDir, 'src'), { recursive: true });
    writeFileSync(join(repoDir, 'src', 'index.ts'), 'export const base = 1;\n');

    execGit(['add', '.']);
    execGit(['commit', '-m', 'chore: baseline commit']);
    const baselineSha = execGit(['rev-parse', 'HEAD']);

    // Step removes deleted-file.txt, un-ignores renamed-artifact.txt, creates renamed-artifact.txt with identical content
    writeFileSync(join(repoDir, '.gitignore'), '# mutated\n');
    execGit(['rm', 'deleted-file.txt']);
    writeFileSync(join(repoDir, 'renamed-artifact.txt'), identicalContent);
    writeFileSync(join(repoDir, 'src', 'index.ts'), 'export const base = 2;\n');

    execGit(['add', '.']);
    execGit(['commit', '-m', 'feat: delete and add identical file']);
    const stepHeadSha = execGit(['rev-parse', 'HEAD']);

    const result = await revertScopeFiles({
      cwd: repoDir,
      baseline: baselineSha,
      expectedHeadSha: stepHeadSha,
      rewriteSafety: 'unpublished',
      scopeFiles: ['.gitignore'],
    });

    expect(result.revertedScopeFiles).toEqual(['.gitignore']);
    expect(result.removedNewlyIgnoredFiles).toEqual(['renamed-artifact.txt']);

    const trackedFiles = execGit(['ls-files', '-z']).split('\0').filter(Boolean);
    expect(trackedFiles).not.toContain('renamed-artifact.txt');
    expect(trackedFiles).not.toContain('deleted-file.txt');
    expect(trackedFiles).toContain('src/index.ts');
    expect(existsSync(join(repoDir, 'renamed-artifact.txt'))).toBe(true);
    expect(readFileSync(join(repoDir, 'renamed-artifact.txt'), 'utf8')).toBe(identicalContent);
    expect(execGit(['status', '--porcelain'])).toBe('');
  });

  it('preserves exact paths without mangling filenames with whitespace', async () => {
    const { repoDir, execGit } = initRepo();

    writeFileSync(join(repoDir, '.gitignore'), '/*.log\n');
    mkdirSync(join(repoDir, 'src'), { recursive: true });
    writeFileSync(join(repoDir, 'src', 'index.ts'), 'export const a = 1;\n');

    execGit(['add', '.']);
    execGit(['commit', '-m', 'chore: baseline commit']);
    const baselineSha = execGit(['rev-parse', 'HEAD']);

    // Step un-ignores, creates a file with spaces around name, modifies src
    writeFileSync(join(repoDir, '.gitignore'), '# mutated\n');
    const spacedFilename = ' test space .log';
    writeFileSync(join(repoDir, spacedFilename), 'log data\n');
    writeFileSync(join(repoDir, 'src', 'index.ts'), 'export const a = 2;\n');

    execGit(['add', '.']);
    execGit(['commit', '-m', 'feat: add spaced file']);
    const stepHeadSha = execGit(['rev-parse', 'HEAD']);

    const result = await revertScopeFiles({
      cwd: repoDir,
      baseline: baselineSha,
      expectedHeadSha: stepHeadSha,
      rewriteSafety: 'unpublished',
      scopeFiles: ['.gitignore'],
    });

    expect(result.revertedScopeFiles).toEqual(['.gitignore']);
    expect(result.removedNewlyIgnoredFiles).toEqual([spacedFilename]);

    const trackedFiles = execGit(['ls-files', '-z']).split('\0').filter(Boolean);
    expect(trackedFiles).not.toContain(spacedFilename);
    expect(existsSync(join(repoDir, spacedFilename))).toBe(true);
    expect(execGit(['status', '--porcelain'])).toBe('');
  });
});
