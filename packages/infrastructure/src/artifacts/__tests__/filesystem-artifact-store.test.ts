import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { createFilesystemArtifactStore } from '../filesystem-artifact-store.js';

function createTempRoots(): { baseDir: string; durableRoot: string; worktreeRoot: string } {
  const baseDir = mkdtempSync(join(tmpdir(), 'filesystem-artifact-store-'));
  return {
    baseDir,
    durableRoot: join(baseDir, 'durable'),
    worktreeRoot: join(baseDir, 'worktree'),
  };
}

describe('createFilesystemArtifactStore', () => {
  it('writes to the durable root and mirrors to the worktree root', async () => {
    const { baseDir, durableRoot, worktreeRoot } = createTempRoots();
    try {
      const store = createFilesystemArtifactStore({ durableRoot, worktreeRoot });

      const artifact = await store.write({
        runId: 'run-1',
        phaseId: 'implement',
        relativePath: 'implementation-log.md',
        contents: '# implementation log\n',
      });

      expect(artifact.runId).toBe('run-1');
      expect(artifact.phaseId).toBe('implement');
      expect(artifact.relativePath).toBe('implementation-log.md');
      expect(artifact.absolutePath).toBe(join(durableRoot, 'implementation-log.md'));
      expect(artifact.bytes).toBe(Buffer.byteLength('# implementation log\n'));
      expect(artifact.createdAt).toBeInstanceOf(Date);

      expect(readFileSync(join(durableRoot, 'implementation-log.md'), 'utf8')).toBe(
        '# implementation log\n',
      );
      expect(readFileSync(join(worktreeRoot, 'implementation-log.md'), 'utf8')).toBe(
        '# implementation log\n',
      );
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('reads the durable copy when durable and worktree copies differ', async () => {
    const { baseDir, durableRoot, worktreeRoot } = createTempRoots();
    try {
      mkdirSync(durableRoot, { recursive: true });
      mkdirSync(worktreeRoot, { recursive: true });
      writeFileSync(join(durableRoot, 'implementation-log.md'), 'durable copy', 'utf8');
      writeFileSync(join(worktreeRoot, 'implementation-log.md'), 'worktree copy', 'utf8');

      const store = createFilesystemArtifactStore({ durableRoot, worktreeRoot });

      await expect(store.read('run-1', 'implementation-log.md')).resolves.toBe('durable copy');
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('falls back to the worktree copy when the durable copy is absent', async () => {
    const { baseDir, durableRoot, worktreeRoot } = createTempRoots();
    try {
      mkdirSync(worktreeRoot, { recursive: true });
      writeFileSync(join(worktreeRoot, 'implementation-log.md'), 'worktree copy', 'utf8');

      const store = createFilesystemArtifactStore({ durableRoot, worktreeRoot });

      await expect(store.read('run-1', 'implementation-log.md')).resolves.toBe('worktree copy');
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('lists durable and worktree artifacts recursively', async () => {
    const { baseDir, durableRoot, worktreeRoot } = createTempRoots();
    try {
      mkdirSync(join(durableRoot, 'validate'), { recursive: true });
      mkdirSync(join(worktreeRoot, 'notes'), { recursive: true });
      writeFileSync(
        join(durableRoot, 'validate', 'validation-result.json'),
        '{"passed":true}',
        'utf8',
      );
      writeFileSync(join(worktreeRoot, 'notes', 'todo.md'), 'todo', 'utf8');

      const store = createFilesystemArtifactStore({ durableRoot, worktreeRoot });
      const artifacts = await store.list('run-1');

      expect(artifacts.map((artifact) => artifact.relativePath)).toEqual([
        'notes/todo.md',
        'validate/validation-result.json',
      ]);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('prefers durable metadata when list finds the same relative path in both roots', async () => {
    const { baseDir, durableRoot, worktreeRoot } = createTempRoots();
    try {
      mkdirSync(durableRoot, { recursive: true });
      mkdirSync(worktreeRoot, { recursive: true });
      writeFileSync(join(durableRoot, 'implementation-log.md'), 'durable', 'utf8');
      writeFileSync(join(worktreeRoot, 'implementation-log.md'), 'worktree-copy', 'utf8');

      const store = createFilesystemArtifactStore({ durableRoot, worktreeRoot });
      const artifacts = await store.list('run-1');

      expect(artifacts).toHaveLength(1);
      expect(artifacts[0]?.relativePath).toBe('implementation-log.md');
      expect(artifacts[0]?.absolutePath).toBe(join(durableRoot, 'implementation-log.md'));
      expect(artifacts[0]?.bytes).toBe(Buffer.byteLength('durable'));
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it.each(['../escape.md', join(tmpdir(), 'absolute-escape.md')])(
    'rejects unsafe path %s without creating files outside either root',
    async (relativePath) => {
      const { baseDir, durableRoot, worktreeRoot } = createTempRoots();
      try {
        const store = createFilesystemArtifactStore({ durableRoot, worktreeRoot });
        const outsidePath =
          relativePath === '../escape.md' ? join(baseDir, 'escape.md') : relativePath;

        await expect(
          store.write({
            runId: 'run-1',
            relativePath,
            contents: 'escape',
          }),
        ).rejects.toThrow();
        await expect(store.read('run-1', relativePath)).rejects.toThrow();
        expect(existsSync(outsidePath)).toBe(false);
        expect(existsSync(join(durableRoot, 'escape.md'))).toBe(false);
        expect(existsSync(join(worktreeRoot, 'escape.md'))).toBe(false);
      } finally {
        rmSync(baseDir, { recursive: true, force: true });
      }
    },
  );

  it('rejects unsafe path with backslashes on POSIX and Windows', async () => {
    const { baseDir, durableRoot, worktreeRoot } = createTempRoots();
    try {
      const store = createFilesystemArtifactStore({ durableRoot, worktreeRoot });
      await expect(
        store.write({
          runId: 'run-1',
          relativePath: '..\\escape.md',
          contents: 'escape',
        }),
      ).rejects.toThrow();
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('rejects path containing symlink pointing outside the root', async () => {
    const { baseDir, durableRoot, worktreeRoot } = createTempRoots();
    try {
      mkdirSync(durableRoot, { recursive: true });
      mkdirSync(worktreeRoot, { recursive: true });

      // Create a directory outside the roots
      const externalDir = join(baseDir, 'external');
      mkdirSync(externalDir, { recursive: true });
      writeFileSync(join(externalDir, 'secret.txt'), 'sensitive content', 'utf8');

      // Create a symlink in the worktree root pointing to the external directory
      const symlinkPath = join(worktreeRoot, 'symlink_outside');
      symlinkSync(externalDir, symlinkPath, 'dir');

      const store = createFilesystemArtifactStore({ durableRoot, worktreeRoot });

      // Trying to write or read relative to the symlink should fail
      await expect(
        store.write({
          runId: 'run-1',
          relativePath: 'symlink_outside/secret.txt',
          contents: 'hack',
        }),
      ).rejects.toThrow();

      await expect(store.read('run-1', 'symlink_outside/secret.txt')).rejects.toThrow();
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('does not block reading a valid file if a directory exists with the same name in the other root', async () => {
    const { baseDir, durableRoot, worktreeRoot } = createTempRoots();
    try {
      mkdirSync(durableRoot, { recursive: true });
      mkdirSync(worktreeRoot, { recursive: true });

      // Create a file in durableRoot and a directory in worktreeRoot with the same relative path
      writeFileSync(join(durableRoot, 'conflicting.md'), 'durable content', 'utf8');
      mkdirSync(join(worktreeRoot, 'conflicting.md'), { recursive: true });

      const store = createFilesystemArtifactStore({ durableRoot, worktreeRoot });

      // Reading should succeed and return durable content
      await expect(store.read('run-1', 'conflicting.md')).resolves.toBe('durable content');
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('rejects binary content containing null bytes', async () => {
    const { baseDir, durableRoot, worktreeRoot } = createTempRoots();
    try {
      const store = createFilesystemArtifactStore({ durableRoot, worktreeRoot });
      await expect(
        store.write({
          runId: 'run-1',
          relativePath: 'binary.bin',
          contents: 'hello\0world',
        }),
      ).rejects.toThrow(/binary files are not supported/);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
