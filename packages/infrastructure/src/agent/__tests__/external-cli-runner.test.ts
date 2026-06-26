import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { runExternalCli } from '../external-cli-runner.js';

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
        writeFileSync(
          join(specDir, '2026-04-26-ops-57-fix-score-trace-build-design.md'),
          '# Design',
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
        expect(readFileSync(join(cwd, 'design.md'), 'utf-8')).toBe('# Design');
        expect(result.remediatedArtifacts).toEqual([
          {
            src: 'docs/superpowers/specs/2026-04-26-ops-57-fix-score-trace-build-design.md',
            artifact: 'design.md',
          },
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
        writeFileSync(join(specDir, '2026-04-26-design.md'), '# Other');
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
        const specDir = join(cwd, 'docs', 'superpowers', 'specs');
        mkdirSync(specDir, { recursive: true });
        writeFileSync(join(specDir, '2026-04-26-design-a.md'), '# A');
        writeFileSync(join(specDir, '2026-04-26-design-b.md'), '# B');
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
        writeFileSync(join(specDir, '2026-04-26-design.md'), '# Tracked');
        execSync('git add docs/superpowers/specs/2026-04-26-design.md', { cwd, stdio: 'pipe' });
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
        writeFileSync(join(specDir, '2026-04-26-design.md'), '# Design');
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
        // The spec directory should be removed since it was created by the agent
        // and is now empty (the file was moved out)
        expect(existsSync(specDir)).toBe(false);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        rmSync(artifactsDir, { recursive: true, force: true });
      }
    });
  });
});
