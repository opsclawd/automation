import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as childProcess from 'node:child_process';
import { RepositoryMetadataResolver, RepositoryResolutionError } from '../repository-metadata-resolver.js';
import { existsSync, statSync } from 'node:fs';

vi.mock('node:child_process');
vi.mock('node:fs');

describe('RepositoryMetadataResolver', () => {
  let resolver: RepositoryMetadataResolver;
  const execFileSyncMock = vi.mocked(childProcess.execFileSync);
  const existsSyncMock = vi.mocked(existsSync);
  const statSyncMock = vi.mocked(statSync);

  beforeEach(() => {
    resolver = new RepositoryMetadataResolver();
    vi.resetAllMocks();
  });

  it('successfully resolves metadata for a valid git repository', () => {
    const targetPath = '/path/to/repo';
    existsSyncMock.mockReturnValue(true);
    statSyncMock.mockReturnValue({ isDirectory: () => true } as unknown as import('node:fs').Stats);

    execFileSyncMock.mockImplementation((cmd, args) => {
      if (cmd === 'git') {
        if (args?.includes('--show-toplevel')) return '/path/to/repo';
        if (args?.includes('get-url')) return 'https://github.com/owner/repo.git';
      }
      if (cmd === 'gh') {
        if (args?.includes('nameWithOwner')) return 'owner/repo';
        if (args?.includes('defaultBranchRef')) return 'develop';
      }
      return '';
    });

    const metadata = resolver.resolve(targetPath);

    expect(metadata).toEqual({
      rootPath: '/path/to/repo',
      nameWithOwner: 'owner/repo',
      defaultBranch: 'develop',
      remoteUrl: 'https://github.com/owner/repo.git',
    });

    // Verify all commands used the correct CWD
    expect(execFileSyncMock).toHaveBeenCalledWith('git', ['rev-parse', '--show-toplevel'], expect.objectContaining({ cwd: '/path/to/repo' }));
    expect(execFileSyncMock).toHaveBeenCalledWith('gh', expect.arrayContaining(['nameWithOwner']), expect.objectContaining({ cwd: '/path/to/repo' }));
    expect(execFileSyncMock).toHaveBeenCalledWith('gh', expect.arrayContaining(['defaultBranchRef']), expect.objectContaining({ cwd: '/path/to/repo' }));
    expect(execFileSyncMock).toHaveBeenCalledWith('git', ['remote', 'get-url', 'origin'], expect.objectContaining({ cwd: '/path/to/repo' }));
  });

  it('throws RepositoryResolutionError if path does not exist', () => {
    existsSyncMock.mockReturnValue(false);
    expect(() => resolver.resolve('/non/existent')).toThrow(RepositoryResolutionError);
    expect(() => resolver.resolve('/non/existent')).toThrow(/not an existing directory/);
  });

  it('throws RepositoryResolutionError if path is not a git repository', () => {
    existsSyncMock.mockReturnValue(true);
    statSyncMock.mockReturnValue({ isDirectory: () => true } as unknown as import('node:fs').Stats);
    execFileSyncMock.mockImplementation((cmd, args) => {
      if (cmd === 'git' && args?.includes('--show-toplevel')) {
        throw new Error('fatal: not a git repository');
      }
      return '';
    });

    expect(() => resolver.resolve('/not/a/repo')).toThrow(RepositoryResolutionError);
    expect(() => resolver.resolve('/not/a/repo')).toThrow(/not inside a git working tree/);
  });

  it('throws RepositoryResolutionError if gh resolution fails', () => {
    existsSyncMock.mockReturnValue(true);
    statSyncMock.mockReturnValue({ isDirectory: () => true } as unknown as import('node:fs').Stats);
    execFileSyncMock.mockImplementation((cmd, args) => {
      if (cmd === 'git' && args?.includes('--show-toplevel')) return '/repo';
      if (cmd === 'gh' && args?.includes('nameWithOwner')) throw new Error('gh failed');
      return '';
    });

    expect(() => resolver.resolve('/repo')).toThrow(RepositoryResolutionError);
    expect(() => resolver.resolve('/repo')).toThrow(/Failed to resolve repository identity/);
  });

  it('falls back to "main" if gh default branch resolution fails', () => {
    existsSyncMock.mockReturnValue(true);
    statSyncMock.mockReturnValue({ isDirectory: () => true } as unknown as import('node:fs').Stats);
    execFileSyncMock.mockImplementation((cmd, args) => {
      if (cmd === 'git' && args?.includes('--show-toplevel')) return '/repo';
      if (cmd === 'gh' && args?.includes('nameWithOwner')) return 'owner/repo';
      if (cmd === 'gh' && args?.includes('defaultBranchRef')) throw new Error('gh failed');
      if (cmd === 'git' && args?.includes('get-url')) return 'https://github.com/owner/repo.git';
      return '';
    });

    const metadata = resolver.resolve('/repo');
    expect(metadata.defaultBranch).toBe('main');
  });
});
