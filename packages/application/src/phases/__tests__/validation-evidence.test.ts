import { describe, it, expect, vi } from 'vitest';
import {
  computeWorktreeSourceFingerprint,
  recordValidationEvidence,
  invalidateValidationEvidence,
  verifyValidationFreshness,
  VALIDATION_RESULT_ARTIFACT,
  VALIDATION_HEADSHA_ARTIFACT,
  VALIDATION_FINGERPRINT_ARTIFACT,
} from '../validation-evidence.js';
import { FakeArtifactStore, FakeGitPort } from '../../test-doubles/index.js';
import type { PhaseHandlerContext } from '../handler.js';

describe('validation-evidence', () => {
  const createMockContext = (
    artifacts: FakeArtifactStore,
    git: FakeGitPort,
  ): PhaseHandlerContext => {
    git.headByCwd.set('/test/repo', 'a'.repeat(40));
    return {
      runUuid: 'run-1',
      cwd: '/test/repo',
      artifacts,
      git,
      events: { publish: vi.fn() },
      now: () => new Date(),
    } as unknown as PhaseHandlerContext;
  };

  it('computes consistent fingerprints for same source state regardless of orchestrator artifacts', async () => {
    const git = new FakeGitPort();
    git.headByCwd.set('/test/repo', 'a'.repeat(40));

    git.statusByCwd.set('/test/repo', ' M src/foo.ts\n?? validation.result\n');
    const fp1 = await computeWorktreeSourceFingerprint({ git, cwd: '/test/repo' });

    git.statusByCwd.set(
      '/test/repo',
      ' M src/foo.ts\n?? validation.result\n?? validation.fingerprint\n?? review-fix-plan.json\n',
    );
    const fp2 = await computeWorktreeSourceFingerprint({ git, cwd: '/test/repo' });

    expect(fp1).toBe(fp2);

    git.statusByCwd.set('/test/repo', ' M src/foo.ts\n M src/bar.ts\n');
    const fp3 = await computeWorktreeSourceFingerprint({ git, cwd: '/test/repo' });

    expect(fp3).not.toBe(fp1);
  });

  it('records validation evidence across all three artifacts', async () => {
    const artifacts = new FakeArtifactStore();
    const git = new FakeGitPort();
    const ctx = createMockContext(artifacts, git);

    await recordValidationEvidence(ctx, 'validate');

    const result = await artifacts.read('run-1', VALIDATION_RESULT_ARTIFACT);
    expect(result.trim()).toBe('passed');

    const headsha = await artifacts.read('run-1', VALIDATION_HEADSHA_ARTIFACT);
    expect(headsha.trim()).toBe('a'.repeat(40));

    const fingerprint = await artifacts.read('run-1', VALIDATION_FINGERPRINT_ARTIFACT);
    expect(fingerprint.trim().length).toBe(64); // SHA-256 hex string
  });

  it('invalidates validation evidence on code mutation', async () => {
    const artifacts = new FakeArtifactStore();
    const git = new FakeGitPort();
    const ctx = createMockContext(artifacts, git);

    await recordValidationEvidence(ctx, 'validate');
    await invalidateValidationEvidence(ctx, 'fix-review');

    const result = await artifacts.read('run-1', VALIDATION_RESULT_ARTIFACT);
    expect(result.trim()).toBe('invalidated');

    const freshness = await verifyValidationFreshness(ctx);
    expect(freshness.fresh).toBe(false);
    expect(freshness.reason).toContain('invalidated');
  });

  it('verifies freshness correctly when valid evidence is present', async () => {
    const artifacts = new FakeArtifactStore();
    const git = new FakeGitPort();
    const ctx = createMockContext(artifacts, git);

    await recordValidationEvidence(ctx, 'validate');

    const freshness = await verifyValidationFreshness(ctx);
    expect(freshness.fresh).toBe(true);
  });

  it('rejects freshness when validation.result is missing', async () => {
    const artifacts = new FakeArtifactStore();
    const git = new FakeGitPort();
    const ctx = createMockContext(artifacts, git);

    const freshness = await verifyValidationFreshness(ctx);
    expect(freshness.fresh).toBe(false);
    expect(freshness.reason).toContain('missing');
  });

  it('rejects freshness when worktree source status changes after validation', async () => {
    const artifacts = new FakeArtifactStore();
    const git = new FakeGitPort();
    const ctx = createMockContext(artifacts, git);

    await recordValidationEvidence(ctx, 'validate');

    // Mutate source state
    git.statusByCwd.set('/test/repo', ' M src/mutated.ts\n');

    const freshness = await verifyValidationFreshness(ctx);
    expect(freshness.fresh).toBe(false);
    expect(freshness.reason).toContain('stale');
  });

  it('detects content changes in the same dirty tracked file and invalidates freshness', async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const testDir = await mkdtemp(join(tmpdir(), 'val-evidence-test-'));
    try {
      await mkdir(join(testDir, 'src'), { recursive: true });
      const filePath = join(testDir, 'src', 'app.ts');

      // Initial uncommitted source state
      await writeFile(filePath, 'export const version = 1;\n', 'utf-8');

      const git = new FakeGitPort();
      git.headByCwd.set(testDir, 'a'.repeat(40));
      git.statusByCwd.set(testDir, ' M src/app.ts\n');
      git.worktreeFileContents.set(`${testDir}:src/app.ts`, 'export const version = 1;\n');

      const artifacts = new FakeArtifactStore();
      const ctx = {
        runUuid: 'run-1',
        cwd: testDir,
        artifacts,
        git,
        events: { publish: vi.fn() },
        now: () => new Date(),
      } as unknown as PhaseHandlerContext;

      await recordValidationEvidence(ctx, 'validate');
      const fp1 = await artifacts.read('run-1', VALIDATION_FINGERPRINT_ARTIFACT);

      // Verify evidence is currently fresh
      const initialFreshness = await verifyValidationFreshness(ctx);
      expect(initialFreshness.fresh).toBe(true);

      // Mutate the content of the same dirty tracked file (git status line remains identical: ' M src/app.ts')
      await writeFile(filePath, 'export const version = 2; // mutated code\n', 'utf-8');
      git.worktreeFileContents.set(
        `${testDir}:src/app.ts`,
        'export const version = 2; // mutated code\n',
      );

      // Fingerprint must change due to content hash difference
      const fp2 = await computeWorktreeSourceFingerprint({ git, cwd: testDir });
      expect(fp2).not.toBe(fp1.trim());

      // Freshness check must fail
      const mutatedFreshness = await verifyValidationFreshness(ctx);
      expect(mutatedFreshness.fresh).toBe(false);
      expect(mutatedFreshness.reason).toContain('stale');
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it('correctly unquotes Git status paths and detects content modifications in quoted files', async () => {
    const git = new FakeGitPort();
    git.headByCwd.set('/test/repo', 'a'.repeat(40));
    // Git status returns quoted paths for files with spaces
    git.statusByCwd.set('/test/repo', ' M "src/my special file.ts"\n');
    git.worktreeFileContents.set('/test/repo:src/my special file.ts', 'const x = 1;\n');

    const artifacts = new FakeArtifactStore();
    const ctx = {
      runUuid: 'run-1',
      cwd: '/test/repo',
      artifacts,
      git,
      events: { publish: vi.fn() },
      now: () => new Date(),
    } as unknown as PhaseHandlerContext;

    await recordValidationEvidence(ctx, 'validate');
    const fp1 = await artifacts.read('run-1', VALIDATION_FINGERPRINT_ARTIFACT);

    const initialFreshness = await verifyValidationFreshness(ctx);
    expect(initialFreshness.fresh).toBe(true);

    // In-place edit to the quoted path source file (status line stays ' M "src/my special file.ts"')
    git.worktreeFileContents.set('/test/repo:src/my special file.ts', 'const x = 2; // modified\n');

    const fp2 = await computeWorktreeSourceFingerprint({ git, cwd: '/test/repo' });
    expect(fp2).not.toBe(fp1.trim());

    const mutatedFreshness = await verifyValidationFreshness(ctx);
    expect(mutatedFreshness.fresh).toBe(false);
    expect(mutatedFreshness.reason).toContain('stale');
  });

  it('preserves leading and trailing whitespace in quoted paths and detects in-place content modifications', async () => {
    const git = new FakeGitPort();
    git.headByCwd.set('/test/repo', 'a'.repeat(40));
    // Git status returns quoted paths for files with leading or trailing spaces
    git.statusByCwd.set('/test/repo', ' M "src/ leading space.ts"\n M "src/trailing space.ts "\n');
    git.worktreeFileContents.set('/test/repo:src/ leading space.ts', 'const a = 1;\n');
    git.worktreeFileContents.set('/test/repo:src/trailing space.ts ', 'const b = 1;\n');

    const artifacts = new FakeArtifactStore();
    const ctx = {
      runUuid: 'run-1',
      cwd: '/test/repo',
      artifacts,
      git,
      events: { publish: vi.fn() },
      now: () => new Date(),
    } as unknown as PhaseHandlerContext;

    await recordValidationEvidence(ctx, 'validate');
    const fp1 = await artifacts.read('run-1', VALIDATION_FINGERPRINT_ARTIFACT);

    const initialFreshness = await verifyValidationFreshness(ctx);
    expect(initialFreshness.fresh).toBe(true);

    // In-place edit to file with trailing space in name
    git.worktreeFileContents.set('/test/repo:src/trailing space.ts ', 'const b = 2; // modified\n');

    const fp2 = await computeWorktreeSourceFingerprint({ git, cwd: '/test/repo' });
    expect(fp2).not.toBe(fp1.trim());

    const mutatedFreshness = await verifyValidationFreshness(ctx);
    expect(mutatedFreshness.fresh).toBe(false);
    expect(mutatedFreshness.reason).toContain('stale');
  });
});
