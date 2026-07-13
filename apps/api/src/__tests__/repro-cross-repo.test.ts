import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as childProcess from 'node:child_process';
import { composeRoot } from '../compose.js';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn(),
  };
});

// We need to NOT mock fs globally because composeRoot uses it heavily,
// and our mock might break it. But RepositoryMetadataResolver uses existsSync and statSync.
// Instead of mocking fs, we'll let it use the real temp directories we created.

describe('Cross-repo metadata resolution regression', () => {
  // This is a narrow regression test that proves there is no fallback from
  // a selected registry Repository to the composition process's target root.
  // It verifies that when an explicit target repo is provided, its metadata
  // (default branch, repo identity) is used directly rather than falling back
  // to ambient GITHUB_REPOSITORY or other composition-level values.
  let repoRoot: string;
  let targetRepoRoot: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    repoRoot = mkdtempSync(path.join(os.tmpdir(), 'repro-repo-'));
    targetRepoRoot = mkdtempSync(path.join(os.tmpdir(), 'repro-target-'));
    // Ensure we have a pnpm-workspace.yaml so findRepoRoot works if called
    writeFileSync(path.join(repoRoot, 'pnpm-workspace.yaml'), '');

    vi.resetAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(targetRepoRoot, { recursive: true, force: true });
    process.env = { ...originalEnv };
  });

  it('correctly resolves default branch from target repository', () => {
    const execFileSyncMock = vi.mocked(childProcess.execFileSync);

    execFileSyncMock.mockImplementation((cmd, args, opts) => {
      if (cmd === 'git') {
        if (args?.includes('--show-toplevel')) {
          return 'target-root-resolved';
        }
        if (args?.includes('get-url')) {
          return 'https://github.com/owner/target.git';
        }
      }
      if (cmd === 'gh' && args?.includes('defaultBranchRef')) {
        if (opts?.cwd === 'target-root-resolved') {
          return 'target-default';
        }
      }
      if (cmd === 'gh' && args?.includes('nameWithOwner')) {
        if (opts?.cwd === 'target-root-resolved') {
          return 'owner/target';
        }
      }
      return '';
    });

    const container = composeRoot({
      repoRoot,
      targetRepoRoot,
      scriptPath: 'fake',
      runStartupSweeps: false,
    });

    expect(container.defaultBranch).toBe('target-default');
  });

  it('prevents GITHUB_REPOSITORY from overriding target repository identity', () => {
    const execFileSyncMock = vi.mocked(childProcess.execFileSync);

    process.env.GITHUB_REPOSITORY = 'owner/orchestrator';

    execFileSyncMock.mockImplementation((cmd, args, opts) => {
      if (cmd === 'git') {
        if (args?.includes('--show-toplevel')) {
          return 'target-root-resolved';
        }
        if (args?.includes('get-url')) {
          return 'https://github.com/owner/target.git';
        }
      }
      if (cmd === 'gh' && args?.includes('nameWithOwner')) {
        if (opts?.cwd === 'target-root-resolved') {
          return 'owner/target';
        }
      }
      if (cmd === 'gh' && args?.includes('defaultBranchRef')) {
        return 'main';
      }
      return '';
    });

    const container = composeRoot({
      repoRoot,
      targetRepoRoot,
      scriptPath: 'fake',
      runStartupSweeps: false,
    });

    expect(container.repoFullName).toBe('owner/target');
  });
});
