import { describe, expect, it } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { TypescriptError } from '@ai-sdlc/application';
import { deriveTrustedImplicatedFiles } from '../typecheck-implicated-files.js';

const WORKTREE_ROOT = join(process.cwd(), '../../');

describe('deriveTrustedImplicatedFiles', () => {
  describe('normalizes existing in-worktree TypeScript diagnostic paths', () => {
    it('resolves relative paths to repository-relative paths', () => {
      const errors: TypescriptError[] = [
        {
          file: 'packages/application/src/index.ts',
          line: 1,
          col: 1,
          code: 'TS2304',
          message: 'Not found',
        },
      ];
      const result = deriveTrustedImplicatedFiles(WORKTREE_ROOT, errors);
      expect(result).toContain('packages/application/src/index.ts');
    });

    it('resolves absolute paths within the worktree to relative paths', () => {
      const absPath = join(WORKTREE_ROOT, 'packages', 'application', 'src', 'index.ts');
      const errors: TypescriptError[] = [
        { file: absPath, line: 1, col: 1, code: 'TS2304', message: 'Not found' },
      ];
      const result = deriveTrustedImplicatedFiles(WORKTREE_ROOT, errors);
      expect(result).toContain('packages/application/src/index.ts');
    });

    it('normalizes Windows-style backslash separators to forward slashes', () => {
      const errors: TypescriptError[] = [
        {
          file: 'packages\\application\\src\\index.ts',
          line: 1,
          col: 1,
          code: 'TS2304',
          message: 'Not found',
        },
      ];
      const result = deriveTrustedImplicatedFiles(WORKTREE_ROOT, errors);
      expect(result).toContain('packages/application/src/index.ts');
    });
  });

  describe('deduplicates and sorts implicated files', () => {
    it('deduplicates repeated errors in the same file', () => {
      const errors: TypescriptError[] = [
        {
          file: 'packages/application/src/index.ts',
          line: 1,
          col: 1,
          code: 'TS2304',
          message: 'Not found',
        },
        {
          file: 'packages/application/src/index.ts',
          line: 2,
          col: 1,
          code: 'TS2304',
          message: 'Not found',
        },
        {
          file: 'packages/application/src/index.ts',
          line: 3,
          col: 1,
          code: 'TS2304',
          message: 'Not found',
        },
      ];
      const result = deriveTrustedImplicatedFiles(WORKTREE_ROOT, errors);
      expect(result).toEqual(['packages/application/src/index.ts']);
    });

    it('sorts implicated files lexicographically', () => {
      const errors: TypescriptError[] = [
        {
          file: 'packages/domain/src/agent-types.ts',
          line: 1,
          col: 1,
          code: 'TS2304',
          message: 'Not found',
        },
        {
          file: 'packages/application/src/index.ts',
          line: 1,
          col: 1,
          code: 'TS2304',
          message: 'Not found',
        },
        {
          file: 'packages/shared/src/index.ts',
          line: 1,
          col: 1,
          code: 'TS2304',
          message: 'Not found',
        },
      ];
      const result = deriveTrustedImplicatedFiles(WORKTREE_ROOT, errors);
      expect(result).toEqual([
        'packages/application/src/index.ts',
        'packages/domain/src/agent-types.ts',
        'packages/shared/src/index.ts',
      ]);
    });
  });

  describe('rejects traversal and absolute paths outside the worktree', () => {
    it('rejects path traversal with ../', () => {
      const errors: TypescriptError[] = [
        { file: '../escape.ts', line: 1, col: 1, code: 'TS2304', message: 'Not found' },
      ];
      const result = deriveTrustedImplicatedFiles(WORKTREE_ROOT, errors);
      expect(result).not.toContain('../escape.ts');
      expect(result).toEqual([]);
    });

    it('rejects absolute paths outside the worktree', () => {
      const errors: TypescriptError[] = [
        { file: '/tmp/external-file.ts', line: 1, col: 1, code: 'TS2304', message: 'Not found' },
      ];
      const result = deriveTrustedImplicatedFiles(WORKTREE_ROOT, errors);
      expect(result).toEqual([]);
    });

    it('rejects sibling absolute paths that escape the worktree root', () => {
      const siblingRoot = join(WORKTREE_ROOT, '..', 'sibling-project');
      const errors: TypescriptError[] = [
        { file: siblingRoot, line: 1, col: 1, code: 'TS2304', message: 'Not found' },
      ];
      const result = deriveTrustedImplicatedFiles(WORKTREE_ROOT, errors);
      expect(result).toEqual([]);
    });
  });

  describe('rejects dependencies outputs caches orchestration artifacts and unsupported extensions', () => {
    it('rejects node_modules paths', () => {
      const errors: TypescriptError[] = [
        {
          file: 'node_modules/some-package/index.ts',
          line: 1,
          col: 1,
          code: 'TS2304',
          message: 'Not found',
        },
      ];
      const result = deriveTrustedImplicatedFiles(WORKTREE_ROOT, errors);
      expect(result).toEqual([]);
    });

    it('rejects dist output paths', () => {
      const errors: TypescriptError[] = [
        {
          file: 'packages/app/dist/index.js',
          line: 1,
          col: 1,
          code: 'TS2304',
          message: 'Not found',
        },
      ];
      const result = deriveTrustedImplicatedFiles(WORKTREE_ROOT, errors);
      expect(result).toEqual([]);
    });

    it('rejects coverage paths', () => {
      const errors: TypescriptError[] = [
        { file: 'coverage/index.ts', line: 1, col: 1, code: 'TS2304', message: 'Not found' },
      ];
      const result = deriveTrustedImplicatedFiles(WORKTREE_ROOT, errors);
      expect(result).toEqual([]);
    });

    it('rejects .next output paths', () => {
      const errors: TypescriptError[] = [
        { file: '.next/server/index.ts', line: 1, col: 1, code: 'TS2304', message: 'Not found' },
      ];
      const result = deriveTrustedImplicatedFiles(WORKTREE_ROOT, errors);
      expect(result).toEqual([]);
    });

    it('rejects cache and orchestration artifact paths', () => {
      const errors: TypescriptError[] = [
        {
          file: '.ai-runs/some-run/phase-artifacts/index.ts',
          line: 1,
          col: 1,
          code: 'TS2304',
          message: 'Not found',
        },
        {
          file: '.ai-tmp/some-tmp/index.ts',
          line: 1,
          col: 1,
          code: 'TS2304',
          message: 'Not found',
        },
      ];
      const result = deriveTrustedImplicatedFiles(WORKTREE_ROOT, errors);
      expect(result).toEqual([]);
    });

    it('rejects generated .d.ts declaration files', () => {
      const errors: TypescriptError[] = [
        {
          file: 'packages/app/dist/index.d.ts',
          line: 1,
          col: 1,
          code: 'TS2304',
          message: 'Not found',
        },
      ];
      const result = deriveTrustedImplicatedFiles(WORKTREE_ROOT, errors);
      expect(result).toEqual([]);
    });

    it('rejects files with unsupported extensions', () => {
      const errors: TypescriptError[] = [
        { file: 'packages/app/src/a.js', line: 1, col: 1, code: 'TS2304', message: 'Not found' },
        { file: 'packages/app/src/b.json', line: 1, col: 1, code: 'TS2304', message: 'Not found' },
        { file: 'packages/app/src/c.md', line: 1, col: 1, code: 'TS2304', message: 'Not found' },
      ];
      const result = deriveTrustedImplicatedFiles(WORKTREE_ROOT, errors);
      expect(result).toEqual([]);
    });

    it('accepts only existing source and test files with supported extensions', () => {
      const tempDir = join(WORKTREE_ROOT, 'temp-test-' + Date.now());
      mkdirSync(tempDir, { recursive: true });
      try {
        const testFile = join(tempDir, 'a.ts');
        writeFileSync(testFile, 'export const x: number = 1;');
        const errors: TypescriptError[] = [
          { file: testFile, line: 1, col: 1, code: 'TS2304', message: 'Not found' },
        ];
        const result = deriveTrustedImplicatedFiles(WORKTREE_ROOT, errors);
        expect(result.length).toBe(1);
        expect(result[0]!).toMatch(/^temp-test-\d+\/a\.ts$/);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('rejects nonexistent files', () => {
      const errors: TypescriptError[] = [
        {
          file: 'packages/app/src/nonexistent.ts',
          line: 1,
          col: 1,
          code: 'TS2304',
          message: 'Not found',
        },
      ];
      const result = deriveTrustedImplicatedFiles(WORKTREE_ROOT, errors);
      expect(result).toEqual([]);
    });
  });

  describe('fileless and unparsed diagnostics do not implicate files', () => {
    it('returns empty array when errors array is empty', () => {
      const result = deriveTrustedImplicatedFiles(WORKTREE_ROOT, []);
      expect(result).toEqual([]);
    });

    it('returns empty array when all errors have empty file paths', () => {
      const errors: TypescriptError[] = [
        { file: '', line: 0, col: 0, code: 'TS2304', message: 'Not found' },
      ];
      const result = deriveTrustedImplicatedFiles(WORKTREE_ROOT, errors);
      expect(result).toEqual([]);
    });

    it('returns empty array when errors cannot be parsed (no file in line)', () => {
      const errors: TypescriptError[] = [
        {
          file: 'error TS6133: is declared but its value is never read',
          line: 0,
          col: 0,
          code: 'TS6133',
          message: 'is declared but its value is never read',
        },
      ];
      const result = deriveTrustedImplicatedFiles(WORKTREE_ROOT, errors);
      expect(result).toEqual([]);
    });
  });

  describe('build failures and typecheck failures use the same trust filter', () => {
    it('returns implicated files from build error output', () => {
      const errors: TypescriptError[] = [
        {
          file: 'packages/application/src/index.ts',
          line: 1,
          col: 1,
          code: 'TS2304',
          message: 'Not found',
        },
      ];
      const result = deriveTrustedImplicatedFiles(WORKTREE_ROOT, errors);
      expect(result).toEqual(['packages/application/src/index.ts']);
    });

    it('returns implicated files from typecheck error output', () => {
      const errors: TypescriptError[] = [
        {
          file: 'packages/shared/src/index.ts',
          line: 10,
          col: 5,
          code: 'TS2339',
          message: 'Not found',
        },
      ];
      const result = deriveTrustedImplicatedFiles(WORKTREE_ROOT, errors);
      expect(result).toEqual(['packages/shared/src/index.ts']);
    });

    it('returns empty for passing typecheck (no errors)', () => {
      const result = deriveTrustedImplicatedFiles(WORKTREE_ROOT, []);
      expect(result).toEqual([]);
    });
  });

  describe('symlink handling', () => {
    it('resolves symlinks and rejects symlink targets outside worktree', () => {
      const tempDir = join(WORKTREE_ROOT, 'temp-symlink-test-' + Date.now());
      mkdirSync(tempDir, { recursive: true });
      try {
        const realFile = join(tempDir, 'real.ts');
        writeFileSync(realFile, 'export const x: number = 1;');
        const symlinkPath = join(tempDir, 'link.ts');
        symlinkSync(realFile, symlinkPath);

        const errors: TypescriptError[] = [
          { file: symlinkPath, line: 1, col: 1, code: 'TS2304', message: 'Not found' },
        ];
        const result = deriveTrustedImplicatedFiles(WORKTREE_ROOT, errors);
        expect(result.length).toBe(1);
        expect(result[0]!).toMatch(/^temp-symlink-test-\d+\/link\.ts$/);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});
