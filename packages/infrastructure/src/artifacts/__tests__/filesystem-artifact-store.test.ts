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

  it('writes canonical deliverables to .ai in worktree root and not legacy root', async () => {
    const { baseDir, durableRoot, worktreeRoot } = createTempRoots();
    try {
      const store = createFilesystemArtifactStore({ durableRoot, worktreeRoot });

      const artifact = await store.write({
        runId: 'run-1',
        phaseId: 'plan',
        relativePath: 'plan.md',
        contents: '# plan content\n',
      });

      expect(artifact.runId).toBe('run-1');
      expect(artifact.phaseId).toBe('plan');
      expect(artifact.relativePath).toBe('plan.md');
      expect(artifact.absolutePath).toBe(join(durableRoot, 'plan.md'));
      expect(artifact.bytes).toBe(Buffer.byteLength('# plan content\n'));
      expect(artifact.createdAt).toBeInstanceOf(Date);

      expect(readFileSync(join(durableRoot, 'plan.md'), 'utf8')).toBe('# plan content\n');
      expect(readFileSync(join(worktreeRoot, '.ai', 'plan.md'), 'utf8')).toBe('# plan content\n');
      expect(existsSync(join(worktreeRoot, 'plan.md'))).toBe(false);
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

  it('lists only durable artifacts, not worktree files', async () => {
    const { baseDir, durableRoot, worktreeRoot } = createTempRoots();
    try {
      mkdirSync(join(durableRoot, 'validate'), { recursive: true });
      mkdirSync(join(worktreeRoot, 'notes'), { recursive: true });
      writeFileSync(
        join(durableRoot, 'validate', 'validation-result.json'),
        '{"passed":true}',
        'utf8',
      );
      // worktree file should NOT appear in list() — walking the full worktree
      // would enumerate source files and node_modules as artifacts
      writeFileSync(join(worktreeRoot, 'notes', 'todo.md'), 'todo', 'utf8');

      const store = createFilesystemArtifactStore({ durableRoot, worktreeRoot });
      const artifacts = await store.list('run-1');

      expect(artifacts.map((artifact) => artifact.relativePath)).toEqual([
        'validate/validation-result.json',
      ]);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('returns durable artifact when same path exists in both roots', async () => {
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

  it('hydrates canonical deliverables into .ai and removes legacy root files', async () => {
    const { baseDir, durableRoot, worktreeRoot } = createTempRoots();
    try {
      mkdirSync(durableRoot, { recursive: true });
      mkdirSync(worktreeRoot, { recursive: true });

      const deliverables = [
        { key: 'issue.md', content: '# Issue\n' },
        { key: 'issue-comments.md', content: '# Comments\n' },
        { key: 'design.md', content: '# Design\n' },
        { key: 'plan.md', content: '# Plan\n' },
        { key: 'task-manifest.json', content: '{"tasks":[]}' },
      ];

      for (const { key, content } of deliverables) {
        writeFileSync(join(durableRoot, key), content, 'utf8');
        // Place a stale legacy root copy
        writeFileSync(join(worktreeRoot, key), 'stale legacy copy', 'utf8');
      }

      const store = createFilesystemArtifactStore({ durableRoot, worktreeRoot });
      await store.hydrateWorktree('run-1');

      for (const { key, content } of deliverables) {
        // Must exist in .ai/
        expect(existsSync(join(worktreeRoot, '.ai', key))).toBe(true);
        expect(readFileSync(join(worktreeRoot, '.ai', key), 'utf8')).toBe(content);
        // Must NOT exist at root
        expect(existsSync(join(worktreeRoot, key))).toBe(false);
      }
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('preserves worktree paths for non-deliverable artifacts', async () => {
    const { baseDir, durableRoot, worktreeRoot } = createTempRoots();
    try {
      mkdirSync(join(durableRoot, 'logs'), { recursive: true });
      mkdirSync(worktreeRoot, { recursive: true });

      writeFileSync(join(durableRoot, 'implementation-log.md'), '# Implementation Log\n', 'utf8');
      writeFileSync(join(durableRoot, 'logs', 'build.log'), 'build output', 'utf8');

      const store = createFilesystemArtifactStore({ durableRoot, worktreeRoot });
      await store.hydrateWorktree('run-1');

      // Non-deliverable artifacts must be preserved at their original relative paths
      expect(existsSync(join(worktreeRoot, 'implementation-log.md'))).toBe(true);
      expect(readFileSync(join(worktreeRoot, 'implementation-log.md'), 'utf8')).toBe(
        '# Implementation Log\n',
      );
      expect(existsSync(join(worktreeRoot, '.ai', 'implementation-log.md'))).toBe(false);

      expect(existsSync(join(worktreeRoot, 'logs', 'build.log'))).toBe(true);
      expect(readFileSync(join(worktreeRoot, 'logs', 'build.log'), 'utf8')).toBe('build output');
      expect(existsSync(join(worktreeRoot, '.ai', 'logs', 'build.log'))).toBe(false);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('is idempotent on repeated hydration calls', async () => {
    const { baseDir, durableRoot, worktreeRoot } = createTempRoots();
    try {
      mkdirSync(durableRoot, { recursive: true });
      mkdirSync(worktreeRoot, { recursive: true });

      writeFileSync(join(durableRoot, 'plan.md'), '# Plan\n', 'utf8');
      writeFileSync(join(durableRoot, 'implementation-log.md'), '# Log\n', 'utf8');

      const store = createFilesystemArtifactStore({ durableRoot, worktreeRoot });

      await store.hydrateWorktree('run-1');
      const planContent1 = readFileSync(join(worktreeRoot, '.ai', 'plan.md'), 'utf8');
      const logContent1 = readFileSync(join(worktreeRoot, 'implementation-log.md'), 'utf8');

      // Second hydration should succeed without errors and maintain identical content
      await store.hydrateWorktree('run-1');
      const planContent2 = readFileSync(join(worktreeRoot, '.ai', 'plan.md'), 'utf8');
      const logContent2 = readFileSync(join(worktreeRoot, 'implementation-log.md'), 'utf8');

      expect(planContent1).toBe(planContent2);
      expect(logContent1).toBe(logContent2);
      expect(existsSync(join(worktreeRoot, 'plan.md'))).toBe(false);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('overwrites stale worktree copy with durable content during hydration', async () => {
    const { baseDir, durableRoot, worktreeRoot } = createTempRoots();
    try {
      mkdirSync(durableRoot, { recursive: true });
      mkdirSync(join(worktreeRoot, '.ai'), { recursive: true });

      writeFileSync(join(durableRoot, 'plan.md'), '# Durable Plan\n', 'utf8');
      writeFileSync(join(worktreeRoot, '.ai', 'plan.md'), '# Stale AI Plan\n', 'utf8');
      writeFileSync(join(worktreeRoot, 'plan.md'), '# Stale Root Plan\n', 'utf8');

      const store = createFilesystemArtifactStore({ durableRoot, worktreeRoot });
      await store.hydrateWorktree('run-1');

      expect(readFileSync(join(worktreeRoot, '.ai', 'plan.md'), 'utf8')).toBe('# Durable Plan\n');
      expect(existsSync(join(worktreeRoot, 'plan.md'))).toBe(false);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('overwrites equal-sized stale content during hydration', async () => {
    const { baseDir, durableRoot, worktreeRoot } = createTempRoots();
    try {
      mkdirSync(durableRoot, { recursive: true });
      mkdirSync(worktreeRoot, { recursive: true });

      writeFileSync(join(durableRoot, 'implementation-log.md'), 'durable', 'utf8');
      writeFileSync(join(worktreeRoot, 'implementation-log.md'), 'stale!!', 'utf8');

      const store = createFilesystemArtifactStore({ durableRoot, worktreeRoot });
      await store.hydrateWorktree('run-1');

      expect(readFileSync(join(worktreeRoot, 'implementation-log.md'), 'utf8')).toBe('durable');
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('migrates root-only legacy deliverable to .ai without data loss', async () => {
    const { baseDir, durableRoot, worktreeRoot } = createTempRoots();
    try {
      mkdirSync(durableRoot, { recursive: true });
      mkdirSync(worktreeRoot, { recursive: true });

      const legacyPlan = '# Legacy Root Plan\n';
      writeFileSync(join(worktreeRoot, 'plan.md'), legacyPlan, 'utf8');

      const store = createFilesystemArtifactStore({ durableRoot, worktreeRoot });
      await store.hydrateWorktree('run-1');

      expect(existsSync(join(worktreeRoot, '.ai', 'plan.md'))).toBe(true);
      expect(readFileSync(join(worktreeRoot, '.ai', 'plan.md'), 'utf8')).toBe(legacyPlan);
      expect(existsSync(join(worktreeRoot, 'plan.md'))).toBe(false);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('fails on root and .ai content conflict when durable copy is absent', async () => {
    const { baseDir, durableRoot, worktreeRoot } = createTempRoots();
    try {
      mkdirSync(durableRoot, { recursive: true });
      mkdirSync(join(worktreeRoot, '.ai'), { recursive: true });

      writeFileSync(join(worktreeRoot, 'plan.md'), '# Root Plan\n', 'utf8');
      writeFileSync(join(worktreeRoot, '.ai', 'plan.md'), '# AI Plan\n', 'utf8');

      const store = createFilesystemArtifactStore({ durableRoot, worktreeRoot });

      await expect(store.hydrateWorktree('run-1')).rejects.toThrow(/conflict/i);

      // Both copies must be preserved
      expect(existsSync(join(worktreeRoot, 'plan.md'))).toBe(true);
      expect(readFileSync(join(worktreeRoot, 'plan.md'), 'utf8')).toBe('# Root Plan\n');
      expect(existsSync(join(worktreeRoot, '.ai', 'plan.md'))).toBe(true);
      expect(readFileSync(join(worktreeRoot, '.ai', 'plan.md'), 'utf8')).toBe('# AI Plan\n');
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('does not treat a stray hydrated-path durable file as a canonical durable copy', async () => {
    const { baseDir, durableRoot, worktreeRoot } = createTempRoots();
    try {
      mkdirSync(join(durableRoot, '.ai'), { recursive: true });
      mkdirSync(join(worktreeRoot, '.ai'), { recursive: true });

      writeFileSync(join(durableRoot, '.ai', 'plan.md'), '# Stray Durable Plan\n', 'utf8');
      writeFileSync(join(worktreeRoot, 'plan.md'), '# Legacy Root Plan\n', 'utf8');
      writeFileSync(join(worktreeRoot, '.ai', 'plan.md'), '# Hydrated Plan\n', 'utf8');

      const store = createFilesystemArtifactStore({ durableRoot, worktreeRoot });

      await expect(store.hydrateWorktree('run-1')).rejects.toThrow(/conflict/i);
      expect(readFileSync(join(worktreeRoot, 'plan.md'), 'utf8')).toBe('# Legacy Root Plan\n');
      expect(readFileSync(join(worktreeRoot, '.ai', 'plan.md'), 'utf8')).toBe('# Hydrated Plan\n');
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('preserves source file if migration destination write fails', async () => {
    const { baseDir, durableRoot, worktreeRoot } = createTempRoots();
    try {
      mkdirSync(durableRoot, { recursive: true });
      mkdirSync(worktreeRoot, { recursive: true });

      // Create a directory at .ai/plan.md so renaming/writing a file to .ai/plan.md fails
      mkdirSync(join(worktreeRoot, '.ai', 'plan.md'), { recursive: true });
      writeFileSync(join(worktreeRoot, 'plan.md'), '# Root Plan Content\n', 'utf8');

      const store = createFilesystemArtifactStore({ durableRoot, worktreeRoot });

      await expect(store.hydrateWorktree('run-1')).rejects.toThrow();

      // Source file must be preserved
      expect(existsSync(join(worktreeRoot, 'plan.md'))).toBe(true);
      expect(readFileSync(join(worktreeRoot, 'plan.md'), 'utf8')).toBe('# Root Plan Content\n');
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('removes redundant root copy if .ai already has identical content and durable copy is absent', async () => {
    const { baseDir, durableRoot, worktreeRoot } = createTempRoots();
    try {
      mkdirSync(durableRoot, { recursive: true });
      mkdirSync(join(worktreeRoot, '.ai'), { recursive: true });

      const content = '# Identical Plan\n';
      writeFileSync(join(worktreeRoot, 'plan.md'), content, 'utf8');
      writeFileSync(join(worktreeRoot, '.ai', 'plan.md'), content, 'utf8');

      const store = createFilesystemArtifactStore({ durableRoot, worktreeRoot });
      await store.hydrateWorktree('run-1');

      expect(existsSync(join(worktreeRoot, '.ai', 'plan.md'))).toBe(true);
      expect(readFileSync(join(worktreeRoot, '.ai', 'plan.md'), 'utf8')).toBe(content);
      expect(existsSync(join(worktreeRoot, 'plan.md'))).toBe(false);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('reads canonical deliverable from .ai in worktree when durable copy is absent', async () => {
    const { baseDir, durableRoot, worktreeRoot } = createTempRoots();
    try {
      mkdirSync(join(worktreeRoot, '.ai'), { recursive: true });
      writeFileSync(join(worktreeRoot, '.ai', 'plan.md'), '# Worktree AI Plan\n', 'utf8');

      const store = createFilesystemArtifactStore({ durableRoot, worktreeRoot });
      await expect(store.read('run-1', 'plan.md')).resolves.toBe('# Worktree AI Plan\n');
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('falls back to legacy root in worktree when .ai and durable copies are absent', async () => {
    const { baseDir, durableRoot, worktreeRoot } = createTempRoots();
    try {
      mkdirSync(worktreeRoot, { recursive: true });
      writeFileSync(join(worktreeRoot, 'plan.md'), '# Legacy Root Plan\n', 'utf8');

      const store = createFilesystemArtifactStore({ durableRoot, worktreeRoot });
      await expect(store.read('run-1', 'plan.md')).resolves.toBe('# Legacy Root Plan\n');
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('throws ArtifactNotFoundError when canonical deliverable is absent from durable, .ai, and root', async () => {
    const { baseDir, durableRoot, worktreeRoot } = createTempRoots();
    try {
      mkdirSync(durableRoot, { recursive: true });
      mkdirSync(worktreeRoot, { recursive: true });

      const store = createFilesystemArtifactStore({ durableRoot, worktreeRoot });
      await expect(store.read('run-1', 'plan.md')).rejects.toThrow();
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
