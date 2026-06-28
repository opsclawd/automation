import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildLintTaskSize } from '../lint-task-size.js';
import type { TaskManifest } from '@ai-sdlc/application';

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop()!;
    rmSync(d, { recursive: true, force: true });
  }
});

function createTempTestFile(filename: string, content: string): { dir: string; relPath: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lint-task-size-'));
  tempDirs.push(dir);
  const filePath = path.join(dir, filename);
  writeFileSync(filePath, content, 'utf-8');
  return { dir, relPath: filename };
}

describe('buildLintTaskSize', () => {
  it('correctly counts various test declaration styles and ignores commented out tests and template literals', async () => {
    const fileContent = `
      // Standard declarations
      it('should work', () => {});
      test('should work', () => {});

      // Skipped/only declarations
      it.skip('should work', () => {});
      test.only('should work', () => {});

      // Chained declarations
      it.each([1, 2])('should work', () => {});
      test.concurrent('should work', () => {});
      it.todo('should work', () => {});

      // Aliases
      xit('should work', () => {});
      xtest('should work', () => {});

      // Single line comments (should not count)
      // it('commented out single line', () => {});
      //   test('commented out single line', () => {});

      // Multi-line block comments (should not count)
      /*
        it('commented out block', () => {});
      */

      // Template string literals (should not count)
      const doc = \`
        it('inside template string', () => {});
      \`;
    `;

    const { dir, relPath } = createTempTestFile('my.test.ts', fileContent);
    const linter = buildLintTaskSize({
      maxTestFileLines: 100,
      maxTestCases: 5,
      blockOversizedTasks: true,
    });

    const manifest: TaskManifest = {
      version: 1,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'Run test suite task',
          files: [relPath],
        },
      ],
    };

    const result = await linter(dir, manifest);

    // Let's verify the counts:
    // Legitimate test cases:
    // 1. it('should work'
    // 2. test('should work'
    // 3. it.skip('should work'
    // 4. test.only('should work'
    // 5. it.each([1, 2])('should work'
    // 6. test.concurrent('should work'
    // 7. it.todo('should work'
    // 8. xit('should work'
    // 9. xtest('should work'
    // Total should be 9.
    expect(result.ok).toBe(false);
    expect(result.oversized).toHaveLength(1);
    expect(result.oversized[0]?.testCaseCount).toBe(9);
  });

  it('matches single-dot test files (e.g. test.ts)', async () => {
    const { dir, relPath } = createTempTestFile(
      'test.ts',
      `
      it('should run', () => {});
    `,
    );
    const linter = buildLintTaskSize({
      maxTestFileLines: 100,
      maxTestCases: 0, // trigger oversized
      blockOversizedTasks: true,
    });
    const manifest: TaskManifest = {
      version: 1,
      task_count: 1,
      tasks: [{ n: 1, title: 'task', files: [relPath] }],
    };
    const result = await linter(dir, manifest);
    expect(result.oversized).toHaveLength(1);
    expect(result.oversized[0]?.testCaseCount).toBe(1);
  });

  it('counts bats test cases and strips bats comments', async () => {
    const { dir, relPath } = createTempTestFile(
      'my_script.bats',
      `
      @test "first test case" {
        run something
      }
      # @test "commented out case" {
      #   run something
      # }
      @test "second test case" {
        run something
      }
    `,
    );
    const linter = buildLintTaskSize({
      maxTestFileLines: 100,
      maxTestCases: 1, // trigger oversized
      blockOversizedTasks: true,
    });
    const manifest: TaskManifest = {
      version: 1,
      task_count: 1,
      tasks: [{ n: 1, title: 'task', files: [relPath] }],
    };
    const result = await linter(dir, manifest);
    expect(result.oversized).toHaveLength(1);
    expect(result.oversized[0]?.testCaseCount).toBe(2);
  });

  it('prevents path traversal', async () => {
    const linter = buildLintTaskSize({
      maxTestFileLines: 100,
      maxTestCases: 5,
      blockOversizedTasks: true,
    });
    const manifest: TaskManifest = {
      version: 1,
      task_count: 1,
      tasks: [{ n: 1, title: 'task', files: ['../outside.test.ts'] }],
    };
    await expect(linter('/some/cwd', manifest)).rejects.toThrow('Path traversal detected');
  });

  it('handles escaped backticks in template literals', async () => {
    const fileContent = `
      const a = \`foo \\\` bar\`;
      it('should count', () => {});
    `;
    const { dir, relPath } = createTempTestFile('my.test.ts', fileContent);
    const linter = buildLintTaskSize({
      maxTestFileLines: 100,
      maxTestCases: 0,
      blockOversizedTasks: true,
    });
    const manifest: TaskManifest = {
      version: 1,
      task_count: 1,
      tasks: [{ n: 1, title: 'task', files: [relPath] }],
    };
    const result = await linter(dir, manifest);
    expect(result.oversized[0]?.testCaseCount).toBe(1);
  });

  it('correctly handles trailing newline for line counts', async () => {
    const { dir, relPath: relPath1 } = createTempTestFile('with_newline.test.ts', 'line1\nline2\n');
    const { dir: dir2, relPath: relPath2 } = createTempTestFile(
      'no_newline.test.ts',
      'line1\nline2',
    );
    const linter = buildLintTaskSize({
      maxTestFileLines: 1, // trigger oversized
      maxTestCases: 5,
      blockOversizedTasks: true,
    });
    const manifest1: TaskManifest = {
      version: 1,
      task_count: 1,
      tasks: [{ n: 1, title: 'task', files: [relPath1] }],
    };
    const result1 = await linter(dir, manifest1);
    expect(result1.oversized[0]?.lineCount).toBe(2);

    const manifest2: TaskManifest = {
      version: 1,
      task_count: 1,
      tasks: [{ n: 1, title: 'task', files: [relPath2] }],
    };
    const result2 = await linter(dir2, manifest2);
    expect(result2.oversized[0]?.lineCount).toBe(2);
  });
});
