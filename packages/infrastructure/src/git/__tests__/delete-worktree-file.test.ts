import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deleteWorktreeFile } from '../delete-worktree-file.js';

describe('deleteWorktreeFile', () => {
  let tmpCwd: string;

  beforeEach(async () => {
    tmpCwd = await mkdtemp(join(tmpdir(), 'delete-worktree-file-test-'));
  });

  afterEach(async () => {
    await rm(tmpCwd, { recursive: true, force: true });
  });

  it('deletes an existing file in cwd and returns true', async () => {
    const filePath = join(tmpCwd, 'test.txt');
    await writeFile(filePath, 'hello');
    expect(existsSync(filePath)).toBe(true);

    const result = await deleteWorktreeFile(tmpCwd, 'test.txt');
    expect(result).toBe(true);
    expect(existsSync(filePath)).toBe(false);
  });

  it('returns false for a non-existent file', async () => {
    const result = await deleteWorktreeFile(tmpCwd, 'does-not-exist.txt');
    expect(result).toBe(false);
  });

  it('rejects path traversal attempts and returns false', async () => {
    const outsideFile = join(tmpdir(), 'outside-test.txt');
    await writeFile(outsideFile, 'secret');
    try {
      const result = await deleteWorktreeFile(tmpCwd, '../outside-test.txt');
      expect(result).toBe(false);
      expect(existsSync(outsideFile)).toBe(true);
    } finally {
      await rm(outsideFile, { force: true });
    }
  });

  it('rejects absolute paths and returns false', async () => {
    const filePath = join(tmpCwd, 'test.txt');
    await writeFile(filePath, 'hello');

    const result = await deleteWorktreeFile(tmpCwd, filePath);
    expect(result).toBe(false);
  });
});
