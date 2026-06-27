import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  renameSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { runExternalCli } from '../external-cli-runner.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync: vi.fn((src: string, dest: string) => actual.renameSync(src, dest)),
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
  });
});
