import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  renameSync,
  readdirSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync, execFileSync } from 'node:child_process';
import { runExternalCli } from '../external-cli-runner.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync: vi.fn((src: string, dest: string) => actual.renameSync(src, dest)),
    readdirSync: vi.fn(
      (
        path: Parameters<typeof actual.readdirSync>[0],
        options?: Parameters<typeof actual.readdirSync>[1],
      ) => actual.readdirSync(path, options),
    ),
  };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const g = globalThis as unknown as { mockOriginalExecFileSync: typeof execFileSync };
  g.mockOriginalExecFileSync = actual.execFileSync;
  return {
    ...actual,
    execFileSync: vi.fn(
      (
        file: Parameters<typeof actual.execFileSync>[0],
        args: Parameters<typeof actual.execFileSync>[1],
        options: Parameters<typeof actual.execFileSync>[2],
      ) => actual.execFileSync(file, args, options),
    ),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'ext-cli-test-'));
}

function makeGitRepo(dir: string): string {
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email test@test.com', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name test', { cwd: dir, stdio: 'pipe' });
  execSync('git commit --allow-empty -m init', { cwd: dir, stdio: 'pipe' });
  return execSync('git rev-parse HEAD', { cwd: dir, stdio: 'pipe' }).toString().trim();
}

describe('runExternalCli', () => {
  describe('artifact enforcement', () => {
    it('sets outcome to contract_violation when expected artifact is missing', async () => {
      const cwd = makeTmpDir();
      const artifactsDir = makeTmpDir();
      try {
        writeFileSync(join(cwd, '.gitkeep'), '');
        const result = await runExternalCli({
          runtime: 'opencode',
          bin: 'true',
          args: [],
          cwd,
          artifactsDir,
          model: 'test',
          expectedArtifacts: ['output.md'],
        });
        expect(result.outcome).toBe('contract_violation');
        expect(result.contractViolations).toContain('missing_required_artifact');
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        rmSync(artifactsDir, { recursive: true, force: true });
      }
    });

    it('keeps success outcome when all expected artifacts exist', async () => {
      const cwd = makeTmpDir();
      const artifactsDir = makeTmpDir();
      try {
        writeFileSync(join(cwd, 'output.md'), 'content');
        const result = await runExternalCli({
          runtime: 'opencode',
          bin: 'true',
          args: [],
          cwd,
          artifactsDir,
          model: 'test',
          expectedArtifacts: ['output.md'],
        });
        expect(result.outcome).toBe('success');
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        rmSync(artifactsDir, { recursive: true, force: true });
      }
    });

    it('fail-fast: reports only the first missing artifact in stderr', async () => {
      const cwd = makeTmpDir();
      const artifactsDir = makeTmpDir();
      try {
        // Make cwd a git repo so `git rev-parse HEAD` resolves and no
        // `missing_commit` violation is added. Otherwise this test is
        // non-hermetic: it passes only when os.tmpdir() happens to sit under a
        // git repo (e.g. a repo-local TMPDIR) and fails under CI's bare /tmp.
        makeGitRepo(cwd);
        const result = await runExternalCli({
          runtime: 'opencode',
          bin: 'true',
          args: [],
          cwd,
          artifactsDir,
          model: 'test',
          expectedArtifacts: ['findings.md', 'judgment.md'],
        });
        expect(result.outcome).toBe('contract_violation');
        expect(result.contractViolations).toEqual(['missing_required_artifact']);
        const stderrText = readFileSync(result.stderrPath, 'utf-8');
        expect(stderrText).toContain('MISSING_REQUIRED_ARTIFACT: findings.md');
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        rmSync(artifactsDir, { recursive: true, force: true });
      }
    });

    it('is a no-op when expectedArtifacts is empty', async () => {
      const cwd = makeTmpDir();
      const artifactsDir = makeTmpDir();
      try {
        const result = await runExternalCli({
          runtime: 'opencode',
          bin: 'true',
          args: [],
          cwd,
          artifactsDir,
          model: 'test',
          expectedArtifacts: [],
        });
        expect(result.outcome).toBe('success');
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        rmSync(artifactsDir, { recursive: true, force: true });
      }
    });

    it('does not interfere with non-zero exit handling (still failed, not contract_violation)', async () => {
      const cwd = makeTmpDir();
      const artifactsDir = makeTmpDir();
      try {
        const result = await runExternalCli({
          runtime: 'opencode',
          bin: 'false',
          args: [],
          cwd,
          artifactsDir,
          model: 'test',
          expectedArtifacts: ['output.md'],
        });
        expect(result.outcome).toBe('failed');
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        rmSync(artifactsDir, { recursive: true, force: true });
      }
    });

    it('does not conflict with NO_OUTPUT heuristic when expectedArtifacts is empty', async () => {
      const cwd = makeTmpDir();
      const artifactsDir = makeTmpDir();
      try {
        const startCommitSha = makeGitRepo(cwd);
        const result = await runExternalCli({
          runtime: 'opencode',
          bin: 'true',
          args: [],
          cwd,
          artifactsDir,
          model: 'test',
          expectedArtifacts: [],
          startCommitSha,
        });
        expect(result.outcome).toBe('contract_violation');
        expect(result.contractViolations).toContain('no_output');
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        rmSync(artifactsDir, { recursive: true, force: true });
      }
    });
  });

  describe('artifact remediation', () => {
    it('moves misplaced design.md from subdirectory to worktree root', async () => {
      const cwd = makeTmpDir();
      const artifactsDir = makeTmpDir();
      try {
        makeGitRepo(cwd);
        const specDir = join(cwd, 'docs', 'superpowers', 'specs');
        mkdirSync(specDir, { recursive: true });
        writeFileSync(join(specDir, 'design.md'), '# Design');
        const result = await runExternalCli({
          runtime: 'opencode',
          bin: 'true',
          args: [],
          cwd,
          artifactsDir,
          model: 'test',
          expectedArtifacts: ['design.md'],
        });
        expect(result.outcome).toBe('success');
        expect(existsSync(join(cwd, 'design.md'))).toBe(true);
        expect(readFileSync(join(cwd, 'design.md'), 'utf-8')).toBe('# Design');
        expect(result.remediatedArtifacts).toEqual([
          { src: 'docs/superpowers/specs/design.md', artifact: 'design.md' },
        ]);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        rmSync(artifactsDir, { recursive: true, force: true });
      }
    });

    it('does not remediate when design.md already exists at root', async () => {
      const cwd = makeTmpDir();
      const artifactsDir = makeTmpDir();
      try {
        makeGitRepo(cwd);
        writeFileSync(join(cwd, 'design.md'), '# Existing');
        const specDir = join(cwd, 'docs', 'superpowers', 'specs');
        mkdirSync(specDir, { recursive: true });
        writeFileSync(join(specDir, 'design.md'), '# Other');
        const result = await runExternalCli({
          runtime: 'opencode',
          bin: 'true',
          args: [],
          cwd,
          artifactsDir,
          model: 'test',
          expectedArtifacts: ['design.md'],
        });
        expect(result.outcome).toBe('success');
        expect(readFileSync(join(cwd, 'design.md'), 'utf-8')).toBe('# Existing');
        expect(result.remediatedArtifacts).toBeUndefined();
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        rmSync(artifactsDir, { recursive: true, force: true });
      }
    });

    it('does not remediate when multiple untracked matching files exist', async () => {
      const cwd = makeTmpDir();
      const artifactsDir = makeTmpDir();
      try {
        makeGitRepo(cwd);
        mkdirSync(join(cwd, 'docs', 'a'), { recursive: true });
        mkdirSync(join(cwd, 'docs', 'b'), { recursive: true });
        writeFileSync(join(cwd, 'docs', 'a', 'design.md'), '# A');
        writeFileSync(join(cwd, 'docs', 'b', 'design.md'), '# B');
        const result = await runExternalCli({
          runtime: 'opencode',
          bin: 'true',
          args: [],
          cwd,
          artifactsDir,
          model: 'test',
          expectedArtifacts: ['design.md'],
        });
        expect(result.outcome).toBe('contract_violation');
        expect(result.contractViolations).toContain('missing_required_artifact');
        expect(result.remediatedArtifacts).toBeUndefined();
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        rmSync(artifactsDir, { recursive: true, force: true });
      }
    });

    it('does not remediate when the misplaced file is git-tracked', async () => {
      const cwd = makeTmpDir();
      const artifactsDir = makeTmpDir();
      try {
        makeGitRepo(cwd);
        const specDir = join(cwd, 'docs', 'superpowers', 'specs');
        mkdirSync(specDir, { recursive: true });
        writeFileSync(join(specDir, 'design.md'), '# Tracked');
        execSync('git add docs/superpowers/specs/design.md', { cwd, stdio: 'pipe' });
        execSync('git commit -m "add tracked design"', { cwd, stdio: 'pipe' });
        const result = await runExternalCli({
          runtime: 'opencode',
          bin: 'true',
          args: [],
          cwd,
          artifactsDir,
          model: 'test',
          expectedArtifacts: ['design.md'],
        });
        expect(result.outcome).toBe('contract_violation');
        expect(result.contractViolations).toContain('missing_required_artifact');
        expect(result.remediatedArtifacts).toBeUndefined();
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        rmSync(artifactsDir, { recursive: true, force: true });
      }
    });

    it('cleans up empty ancestor directories after moving misplaced file', async () => {
      const cwd = makeTmpDir();
      const artifactsDir = makeTmpDir();
      try {
        makeGitRepo(cwd);
        const specDir = join(cwd, 'docs', 'superpowers', 'specs');
        mkdirSync(specDir, { recursive: true });
        writeFileSync(join(specDir, 'design.md'), '# Design');
        const result = await runExternalCli({
          runtime: 'opencode',
          bin: 'true',
          args: [],
          cwd,
          artifactsDir,
          model: 'test',
          expectedArtifacts: ['design.md'],
        });
        expect(result.outcome).toBe('success');
        expect(existsSync(join(cwd, 'design.md'))).toBe(true);
        expect(existsSync(specDir)).toBe(false);
        expect(existsSync(join(cwd, 'docs'))).toBe(false);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        rmSync(artifactsDir, { recursive: true, force: true });
      }
    });

    it('moves misplaced plan.md from subdirectory to worktree root', async () => {
      const cwd = makeTmpDir();
      const artifactsDir = makeTmpDir();
      try {
        makeGitRepo(cwd);
        const planDir = join(cwd, 'docs', 'plans');
        mkdirSync(planDir, { recursive: true });
        writeFileSync(join(planDir, 'plan.md'), '# Plan');
        const result = await runExternalCli({
          runtime: 'opencode',
          bin: 'true',
          args: [],
          cwd,
          artifactsDir,
          model: 'test',
          expectedArtifacts: ['plan.md'],
        });
        expect(result.outcome).toBe('success');
        expect(existsSync(join(cwd, 'plan.md'))).toBe(true);
        expect(readFileSync(join(cwd, 'plan.md'), 'utf-8')).toBe('# Plan');
        expect(result.remediatedArtifacts).toEqual([
          { src: 'docs/plans/plan.md', artifact: 'plan.md' },
        ]);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        rmSync(artifactsDir, { recursive: true, force: true });
      }
    });

    it('moves misplaced compound.md from subdirectory to worktree root', async () => {
      const cwd = makeTmpDir();
      const artifactsDir = makeTmpDir();
      try {
        makeGitRepo(cwd);
        const solutionDir = join(cwd, 'docs', 'solutions', 'performance');
        mkdirSync(solutionDir, { recursive: true });
        writeFileSync(join(solutionDir, 'compound.md'), '# Solution');
        const result = await runExternalCli({
          runtime: 'opencode',
          bin: 'true',
          args: [],
          cwd,
          artifactsDir,
          model: 'test',
          expectedArtifacts: ['compound.md'],
        });
        expect(result.outcome).toBe('success');
        expect(existsSync(join(cwd, 'compound.md'))).toBe(true);
        expect(result.remediatedArtifacts).toEqual([
          { src: 'docs/solutions/performance/compound.md', artifact: 'compound.md' },
        ]);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        rmSync(artifactsDir, { recursive: true, force: true });
      }
    });

    it('remediates misplaced artifact even when the file is gitignored', async () => {
      const cwd = makeTmpDir();
      const artifactsDir = makeTmpDir();
      try {
        makeGitRepo(cwd);
        // Add a .gitignore that hides plan.md from git ls-files
        writeFileSync(join(cwd, '.gitignore'), 'plan.md\n');
        execSync('git add .gitignore && git commit -m "add gitignore"', {
          cwd,
          stdio: 'pipe',
          shell: true,
        });
        const planDir = join(cwd, 'docs', 'plans');
        mkdirSync(planDir, { recursive: true });
        writeFileSync(join(planDir, 'plan.md'), '# Ignored Plan');
        const result = await runExternalCli({
          runtime: 'opencode',
          bin: 'true',
          args: [],
          cwd,
          artifactsDir,
          model: 'test',
          expectedArtifacts: ['plan.md'],
        });
        expect(result.outcome).toBe('success');
        expect(existsSync(join(cwd, 'plan.md'))).toBe(true);
        expect(readFileSync(join(cwd, 'plan.md'), 'utf-8')).toBe('# Ignored Plan');
        expect(result.remediatedArtifacts).toHaveLength(1);
        expect(result.remediatedArtifacts![0]!.artifact).toBe('plan.md');
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        rmSync(artifactsDir, { recursive: true, force: true });
      }
    });

    it('remains contract_violation when only some artifacts can be remediated', async () => {
      const cwd = makeTmpDir();
      const artifactsDir = makeTmpDir();
      try {
        makeGitRepo(cwd);
        // design.md is misplaced — recoverable
        const specDir = join(cwd, 'docs', 'specs');
        mkdirSync(specDir, { recursive: true });
        writeFileSync(join(specDir, 'design.md'), '# Design');
        // plan.md is truly absent — not recoverable
        const result = await runExternalCli({
          runtime: 'opencode',
          bin: 'true',
          args: [],
          cwd,
          artifactsDir,
          model: 'test',
          expectedArtifacts: ['design.md', 'plan.md'],
        });
        expect(result.outcome).toBe('contract_violation');
        expect(result.contractViolations).toContain('missing_required_artifact');
        // design.md was moved even though we stayed contract_violation
        expect(existsSync(join(cwd, 'design.md'))).toBe(true);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        rmSync(artifactsDir, { recursive: true, force: true });
      }
    });

    it('falls back to copy+unlink on EXDEV rename error', async () => {
      const cwd = makeTmpDir();
      const artifactsDir = makeTmpDir();
      try {
        makeGitRepo(cwd);
        const specDir = join(cwd, 'docs', 'specs');
        mkdirSync(specDir, { recursive: true });
        writeFileSync(join(specDir, 'design.md'), '# Design EXDEV');

        // Patch renameSync to throw EXDEV on the first call, then restore
        const { renameSync: originalRename } =
          await vi.importActual<typeof import('node:fs')>('node:fs');
        let callCount = 0;
        vi.mocked(renameSync).mockImplementation((src, dest) => {
          callCount++;
          if (callCount === 1) {
            const err = Object.assign(new Error('EXDEV'), { code: 'EXDEV' });
            throw err;
          }
          return originalRename(src as string, dest as string);
        });

        const result = await runExternalCli({
          runtime: 'opencode',
          bin: 'true',
          args: [],
          cwd,
          artifactsDir,
          model: 'test',
          expectedArtifacts: ['design.md'],
        });

        vi.restoreAllMocks();

        expect(result.outcome).toBe('success');
        expect(existsSync(join(cwd, 'design.md'))).toBe(true);
        expect(readFileSync(join(cwd, 'design.md'), 'utf-8')).toBe('# Design EXDEV');
      } finally {
        vi.restoreAllMocks();
        rmSync(cwd, { recursive: true, force: true });
        rmSync(artifactsDir, { recursive: true, force: true });
      }
    });
    it('is safe against shell command injection via artifact names/paths', async () => {
      const cwd = makeTmpDir();
      const artifactsDir = makeTmpDir();
      try {
        makeGitRepo(cwd);
        const injectionDir = join(cwd, 'docs; touch injection-test.txt');
        mkdirSync(injectionDir, { recursive: true });
        writeFileSync(join(injectionDir, 'design.md'), '# Safe');

        const result = await runExternalCli({
          runtime: 'opencode',
          bin: 'true',
          args: [],
          cwd,
          artifactsDir,
          model: 'test',
          expectedArtifacts: ['design.md'],
        });

        expect(result.outcome).toBe('success');
        expect(existsSync(join(cwd, 'design.md'))).toBe(true);
        expect(existsSync(join(cwd, 'injection-test.txt'))).toBe(false);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        rmSync(artifactsDir, { recursive: true, force: true });
      }
    });

    it('skips subdirectories where readdirSync throws an error and continues scanning', async () => {
      const cwd = makeTmpDir();
      const artifactsDir = makeTmpDir();
      try {
        makeGitRepo(cwd);
        const badDir = join(cwd, 'docs', 'unreadable');
        const goodDir = join(cwd, 'docs', 'readable');
        mkdirSync(badDir, { recursive: true });
        mkdirSync(goodDir, { recursive: true });
        writeFileSync(join(goodDir, 'design.md'), '# Design');

        const { readdirSync: originalReaddir } =
          await vi.importActual<typeof import('node:fs')>('node:fs');

        vi.mocked(readdirSync).mockImplementation(
          (
            path: Parameters<typeof readdirSync>[0],
            options?: Parameters<typeof readdirSync>[1],
          ) => {
            if (typeof path === 'string' && path.includes('unreadable')) {
              throw new Error('EACCES: permission denied');
            }
            return originalReaddir(path, options);
          },
        );

        const result = await runExternalCli({
          runtime: 'opencode',
          bin: 'true',
          args: [],
          cwd,
          artifactsDir,
          model: 'test',
          expectedArtifacts: ['design.md'],
        });

        expect(result.outcome).toBe('success');
        expect(existsSync(join(cwd, 'design.md'))).toBe(true);
      } finally {
        vi.restoreAllMocks();
        rmSync(cwd, { recursive: true, force: true });
        rmSync(artifactsDir, { recursive: true, force: true });
      }
    });

    it('creates missing destination directories recursively when moving misplaced artifact', async () => {
      const cwd = makeTmpDir();
      const artifactsDir = makeTmpDir();
      try {
        makeGitRepo(cwd);
        const specDir = join(cwd, 'temp_docs');
        mkdirSync(specDir, { recursive: true });
        writeFileSync(join(specDir, 'plan.md'), '# Nested Plan');

        const result = await runExternalCli({
          runtime: 'opencode',
          bin: 'true',
          args: [],
          cwd,
          artifactsDir,
          model: 'test',
          expectedArtifacts: ['nested/docs/plan.md'],
        });

        expect(result.outcome).toBe('success');
        expect(existsSync(join(cwd, 'nested', 'docs', 'plan.md'))).toBe(true);
        expect(readFileSync(join(cwd, 'nested', 'docs', 'plan.md'), 'utf-8')).toBe('# Nested Plan');
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        rmSync(artifactsDir, { recursive: true, force: true });
      }
    });

    it('does not remediate tracked files when directory begins with a hyphen', async () => {
      const cwd = makeTmpDir();
      const artifactsDir = makeTmpDir();
      try {
        makeGitRepo(cwd);
        const specDir = join(cwd, '-docs');
        mkdirSync(specDir, { recursive: true });
        writeFileSync(join(specDir, 'design.md'), '# Tracked in hyphen dir');
        execSync('git add -- "-docs/design.md"', { cwd, stdio: 'pipe' });
        execSync('git commit -m "add tracked design in hyphen dir"', { cwd, stdio: 'pipe' });

        const result = await runExternalCli({
          runtime: 'opencode',
          bin: 'true',
          args: [],
          cwd,
          artifactsDir,
          model: 'test',
          expectedArtifacts: ['design.md'],
        });

        expect(result.outcome).toBe('contract_violation');
        expect(result.contractViolations).toContain('missing_required_artifact');
        expect(result.remediatedArtifacts).toBeUndefined();
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        rmSync(artifactsDir, { recursive: true, force: true });
      }
    });

    it('does not hijack or overwrite correct artifacts situated at expected locations', async () => {
      const cwd = makeTmpDir();
      const artifactsDir = makeTmpDir();
      try {
        makeGitRepo(cwd);
        // specs/design.md is missing.
        // docs/design.md is successfully created (untracked).
        const docsDir = join(cwd, 'docs');
        mkdirSync(docsDir, { recursive: true });
        writeFileSync(join(docsDir, 'design.md'), '# Correctly situated');

        const result = await runExternalCli({
          runtime: 'opencode',
          bin: 'true',
          args: [],
          cwd,
          artifactsDir,
          model: 'test',
          expectedArtifacts: ['docs/design.md', 'specs/design.md'],
        });

        expect(result.outcome).toBe('contract_violation');
        expect(result.contractViolations).toContain('missing_required_artifact');
        expect(existsSync(join(cwd, 'docs', 'design.md'))).toBe(true);
        expect(readFileSync(join(cwd, 'docs', 'design.md'), 'utf-8')).toBe('# Correctly situated');
        expect(existsSync(join(cwd, 'specs', 'design.md'))).toBe(false);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        rmSync(artifactsDir, { recursive: true, force: true });
      }
    });

    it('does not scan beyond recursion depth 5', async () => {
      const cwd = makeTmpDir();
      const artifactsDir = makeTmpDir();
      try {
        makeGitRepo(cwd);
        // create a deep directory: level 1 is cwd
        // level 2: d2
        // level 3: d2/d3
        // level 4: d2/d3/d4
        // level 5: d2/d3/d4/d5
        // level 6: d2/d3/d4/d5/d6
        const deepDir = join(cwd, 'd2', 'd3', 'd4', 'd5', 'd6');
        mkdirSync(deepDir, { recursive: true });
        writeFileSync(join(deepDir, 'design.md'), '# Deeply nested');

        const result = await runExternalCli({
          runtime: 'opencode',
          bin: 'true',
          args: [],
          cwd,
          artifactsDir,
          model: 'test',
          expectedArtifacts: ['design.md'],
        });

        expect(result.outcome).toBe('contract_violation');
        expect(result.contractViolations).toContain('missing_required_artifact');
        expect(existsSync(join(cwd, 'design.md'))).toBe(false);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        rmSync(artifactsDir, { recursive: true, force: true });
      }
    });

    it('skips candidates when git ls-files fails with an error status other than 1', async () => {
      const cwd = makeTmpDir();
      const artifactsDir = makeTmpDir();
      try {
        makeGitRepo(cwd);
        const specDir = join(cwd, 'docs', 'specs');
        mkdirSync(specDir, { recursive: true });
        writeFileSync(join(specDir, 'design.md'), '# Design');

        vi.mocked(execFileSync).mockImplementation((file, args, options) => {
          if (file === 'git' && Array.isArray(args) && args.includes('ls-files')) {
            const err = Object.assign(new Error('git command failed with status 128'), {
              status: 128,
            });
            throw err;
          }
          const g = globalThis as unknown as { mockOriginalExecFileSync: typeof execFileSync };
          return g.mockOriginalExecFileSync(file, args, options);
        });

        const result = await runExternalCli({
          runtime: 'opencode',
          bin: 'true',
          args: [],
          cwd,
          artifactsDir,
          model: 'test',
          expectedArtifacts: ['design.md'],
        });

        expect(result.outcome).toBe('contract_violation');
        expect(result.contractViolations).toContain('missing_required_artifact');
        expect(result.remediatedArtifacts).toBeUndefined();
      } finally {
        vi.restoreAllMocks();
        rmSync(cwd, { recursive: true, force: true });
        rmSync(artifactsDir, { recursive: true, force: true });
      }
    });

    it('remediates stem-prefix match when multiple untracked candidates exist (picks newest by mtime)', async () => {
      const cwd = makeTmpDir();
      const artifactsDir = makeTmpDir();
      try {
        makeGitRepo(cwd);
        // Two wrong-named files; older has content "old", newer has "new".
        writeFileSync(join(cwd, 'implementation-log-task-1.md'), 'old');
        writeFileSync(join(cwd, 'implementation-log-task-9.md'), 'new');
        // Force deterministic mtime ordering (older=1, newer=2).
        const oldPath = join(cwd, 'implementation-log-task-1.md');
        const newPath = join(cwd, 'implementation-log-task-9.md');
        const baseTime = new Date('2026-07-03T00:00:00Z').getTime() / 1000;
        utimesSync(oldPath, baseTime, baseTime);
        utimesSync(newPath, baseTime + 60, baseTime + 60);

        const result = await runExternalCli({
          runtime: 'opencode',
          bin: 'true',
          args: [],
          cwd,
          artifactsDir,
          model: 'test',
          expectedArtifacts: ['implementation-log.md'],
        });

        expect(result.outcome).toBe('success');
        expect(existsSync(join(cwd, 'implementation-log.md'))).toBe(true);
        expect(readFileSync(join(cwd, 'implementation-log.md'), 'utf-8')).toBe('new');
        expect(result.remediatedArtifacts).toEqual([
          { src: 'implementation-log-task-9.md', artifact: 'implementation-log.md' },
        ]);
        expect(result.contractViolations).not.toContain('missing_required_artifact');
        expect(result.contractViolations).toContain('misplaced_artifact');
        // The untracked chosen source is cleaned up; the older untracked source remains.
        expect(existsSync(newPath)).toBe(false);
        expect(existsSync(oldPath)).toBe(true);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        rmSync(artifactsDir, { recursive: true, force: true });
      }
    });

    it('remediates stem-prefix match when multiple tracked candidates exist (picks newest by mtime)', async () => {
      const cwd = makeTmpDir();
      const artifactsDir = makeTmpDir();
      try {
        makeGitRepo(cwd);
        // Write and commit both wrong-named candidates so neither gets unlinked.
        writeFileSync(join(cwd, 'implementation-log-task-1.md'), 'old');
        writeFileSync(join(cwd, 'implementation-log-task-9.md'), 'new');
        execSync('git add implementation-log-task-1.md implementation-log-task-9.md', {
          cwd,
          stdio: 'pipe',
        });
        execSync('git commit -m "add wrong-named logs"', { cwd, stdio: 'pipe' });
        // Force deterministic mtime ordering.
        const oldPath = join(cwd, 'implementation-log-task-1.md');
        const newPath = join(cwd, 'implementation-log-task-9.md');
        const baseTime = new Date('2026-07-03T00:00:00Z').getTime() / 1000;
        utimesSync(oldPath, baseTime, baseTime);
        utimesSync(newPath, baseTime + 60, baseTime + 60);

        const result = await runExternalCli({
          runtime: 'opencode',
          bin: 'true',
          args: [],
          cwd,
          artifactsDir,
          model: 'test',
          expectedArtifacts: ['implementation-log.md'],
        });

        expect(result.outcome).toBe('success');
        expect(existsSync(join(cwd, 'implementation-log.md'))).toBe(true);
        expect(readFileSync(join(cwd, 'implementation-log.md'), 'utf-8')).toBe('new');
        expect(result.remediatedArtifacts).toEqual([
          { src: 'implementation-log-task-9.md', artifact: 'implementation-log.md' },
        ]);
        // Both tracked sources remain in git after the copy.
        expect(existsSync(oldPath)).toBe(true);
        expect(existsSync(newPath)).toBe(true);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        rmSync(artifactsDir, { recursive: true, force: true });
      }
    });

    it('does not remediate stem-prefix when zero matches', async () => {
      const cwd = makeTmpDir();
      const artifactsDir = makeTmpDir();
      try {
        makeGitRepo(cwd);
        // Files that do NOT match the implementation-log stem filter.
        writeFileSync(join(cwd, 'other.md'), '# Other');
        writeFileSync(join(cwd, 'implementation-notes.md'), '# Notes');

        const result = await runExternalCli({
          runtime: 'opencode',
          bin: 'true',
          args: [],
          cwd,
          artifactsDir,
          model: 'test',
          expectedArtifacts: ['implementation-log.md'],
        });

        expect(result.outcome).toBe('contract_violation');
        expect(result.contractViolations).toContain('missing_required_artifact');
        expect(result.remediatedArtifacts).toBeUndefined();
        expect(existsSync(join(cwd, 'implementation-log.md'))).toBe(false);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        rmSync(artifactsDir, { recursive: true, force: true });
      }
    });
  });

  describe('provider error reclassification on zero-exit path', () => {
    it('reclassifies outcome to failed when provider error appears in last 200 lines of stderr (exit 0)', async () => {
      const cwd = makeTmpDir();
      const artifactsDir = makeTmpDir();
      try {
        const result = await runExternalCli({
          runtime: 'codex',
          bin: 'bash',
          args: ['-c', 'echo "AI_APICallError: HTTP 500 Internal Server Error" >&2'],
          cwd,
          artifactsDir,
          model: 'test',
        });
        expect(result.outcome).toBe('failed');
        expect(result.contractViolations).toContain('provider_error');
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        rmSync(artifactsDir, { recursive: true, force: true });
      }
    });

    it('reclassifies zero-exit outcome when provider error appears at the end of a long stderr stream (fixing false negative)', async () => {
      const cwd = makeTmpDir();
      const artifactsDir = makeTmpDir();
      try {
        // Simulate a command echoing 200 harmless lines, then "Quota exceeded" at the end
        const scriptLines = ['#!/bin/bash'];
        for (let i = 1; i <= 200; i++) {
          scriptLines.push(`echo "docs content line ${i}" >&2`);
        }
        scriptLines.push('echo "Quota exceeded: API limit reached" >&2');
        const scriptPath = join(cwd, 'stderr-gen.sh');
        writeFileSync(scriptPath, scriptLines.join('\n'));
        execSync(`chmod +x ${scriptPath}`);

        const result = await runExternalCli({
          runtime: 'codex',
          bin: 'bash',
          args: [scriptPath],
          cwd,
          artifactsDir,
          model: 'test',
        });
        expect(result.outcome).toBe('failed');
        expect(result.contractViolations).toContain('provider_error');
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        rmSync(artifactsDir, { recursive: true, force: true });
      }
    });

    it('does not reclassify zero-exit outcome on environment variable dumps or bash tracing containing provider error pattern', async () => {
      const cwd = makeTmpDir();
      const artifactsDir = makeTmpDir();
      try {
        // Simulate env var dumps and bash tracing containing patterns, followed by many lines of log/docs content
        const scriptLines = [
          '#!/bin/bash',
          'echo "export REVIEWER_PROVIDER_ERROR_PATTERNS=\'AI_APICallError\'" >&2',
          'echo "+ AI_APICallError: HTTP 500 Internal Server Error" >&2',
          'echo "export SOME_PATTERNS=\'Quota limit exceeded\'" >&2',
        ];
        for (let i = 1; i <= 250; i++) {
          scriptLines.push(`echo "docs content line ${i}" >&2`);
        }
        const scriptPath = join(cwd, 'stderr-gen-fp.sh');
        writeFileSync(scriptPath, scriptLines.join('\n'));
        execSync(`chmod +x ${scriptPath}`);

        const result = await runExternalCli({
          runtime: 'codex',
          bin: 'bash',
          args: [scriptPath],
          cwd,
          artifactsDir,
          model: 'test',
        });
        expect(result.outcome).toBe('success');
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        rmSync(artifactsDir, { recursive: true, force: true });
      }
    });
  });
});
