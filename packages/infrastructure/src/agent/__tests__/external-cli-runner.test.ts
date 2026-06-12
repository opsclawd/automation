import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
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
});
