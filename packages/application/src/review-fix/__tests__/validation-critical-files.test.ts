import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { FakeGitPort } from '../../test-doubles/fake-git-port.js';
import {
  DELETED_SENTINEL,
  hashContent,
  parseStatusPaths,
  recordValidationCriticalFilesFromWorktree,
  recordValidationCriticalFilesFromCommits,
  wasRevertedToBeforeState,
  formatValidationCriticalFilesWarning,
  checkValidationCriticalRevert,
  type ValidationCriticalFile,
} from '../validation-critical-files.js';

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

describe('validation-critical-files', () => {
  describe('hashContent', () => {
    it('returns DELETED_SENTINEL for undefined', () => {
      expect(hashContent(undefined)).toBe(DELETED_SENTINEL);
    });

    it('returns sha256 hex string for string content', () => {
      expect(hashContent('hello world')).toBe(sha256('hello world'));
    });
  });

  describe('parseStatusPaths', () => {
    it('parses modified, added, renamed, deleted, and untracked porcelain lines', () => {
      const statusOutput = [
        ' M src/modified-unstaged.ts',
        'M  src/modified-staged.ts',
        'MM src/modified-both.ts',
        'A  src/added.ts',
        ' D src/deleted.ts',
        'R  src/old-name.ts -> src/renamed.ts',
        '?? src/untracked.ts',
        '!! ignored/file.txt',
        '?? "src/quoted path/file.ts"',
        '',
      ].join('\n');

      const paths = parseStatusPaths(statusOutput, '/worktree');
      expect(paths.has('src/modified-unstaged.ts')).toBe(true);
      expect(paths.has('src/modified-staged.ts')).toBe(true);
      expect(paths.has('src/modified-both.ts')).toBe(true);
      expect(paths.has('src/added.ts')).toBe(true);
      expect(paths.has('src/deleted.ts')).toBe(true);
      expect(paths.has('src/renamed.ts')).toBe(true);
      expect(paths.has('src/old-name.ts')).toBe(false);
      expect(paths.has('src/untracked.ts')).toBe(true);
      expect(paths.has('src/quoted path/file.ts')).toBe(true);
    });

    it('returns empty set for empty or whitespace-only status', () => {
      expect(parseStatusPaths('')).toEqual(new Set());
      expect(parseStatusPaths('   \n  ')).toEqual(new Set());
    });

    it('filters out orchestrator artifacts from status paths', () => {
      const statusOutput = [
        ' M result.json',
        '?? review-head-sha.txt',
        '?? .ai/temp.txt',
        ' M code-review.md',
        ' M src/code.ts',
      ].join('\n');

      const paths = parseStatusPaths(statusOutput, '/worktree');
      expect(paths.has('src/code.ts')).toBe(true);
      expect(paths.has('result.json')).toBe(false);
      expect(paths.has('review-head-sha.txt')).toBe(false);
      expect(paths.has('.ai/temp.txt')).toBe(false);
      expect(paths.has('code-review.md')).toBe(false);
    });

    it('unquotes escaped characters in git status paths', () => {
      const statusOutput = '?? "src/foo\\tbar.ts"\n?? "src/quote\\"name.ts"\n';
      const paths = parseStatusPaths(statusOutput, '/worktree');
      expect(paths.has('src/foo\tbar.ts')).toBe(true);
      expect(paths.has('src/quote"name.ts')).toBe(true);
    });
  });

  describe('recordValidationCriticalFilesFromWorktree', () => {
    it('records a file that was dirty before and after with different content', async () => {
      const git = new FakeGitPort();
      const cwd = '/worktree';
      const path = 'src/dirty-before.ts';

      const dirtyBefore = new Map<string, string | undefined>();
      dirtyBefore.set(path, 'content before fix');

      git.statusByCwd.set(cwd, ` M ${path}`);
      git.worktreeFileContents.set(`${cwd}:${path}`, 'content after fix');

      const result = await recordValidationCriticalFilesFromWorktree({
        git,
        cwd,
        dirtyBefore,
        diagnostic: 'pnpm test failed',
        recordedAtIteration: 2,
      });

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        path,
        beforeHash: sha256('content before fix'),
        afterHash: sha256('content after fix'),
        diagnostic: 'pnpm test failed',
        recordedAtIteration: 2,
      });
    });

    it('records a previously-clean tracked file modified during the fix with beforeHash from HEAD', async () => {
      const git = new FakeGitPort();
      const cwd = '/worktree';
      const path = 'src/clean-tracked.ts';

      const dirtyBefore = new Map<string, string | undefined>();
      git.statusByCwd.set(cwd, ` M ${path}`);
      git.fileContentResults.set(`HEAD:${path}`, 'head baseline content');
      git.worktreeFileContents.set(`${cwd}:${path}`, 'modified post-fix content');

      const result = await recordValidationCriticalFilesFromWorktree({
        git,
        cwd,
        dirtyBefore,
        diagnostic: 'timeout in whisperx',
      });

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        path,
        beforeHash: sha256('head baseline content'),
        afterHash: sha256('modified post-fix content'),
        diagnostic: 'timeout in whisperx',
      });
    });

    it('records a newly created file with beforeHash = DELETED_SENTINEL', async () => {
      const git = new FakeGitPort();
      const cwd = '/worktree';
      const path = 'src/new-file.ts';

      const dirtyBefore = new Map<string, string | undefined>();
      git.statusByCwd.set(cwd, `?? ${path}`);
      // Not in git HEAD, so git.fileContent throws
      git.fileContent = async () => {
        throw new Error('path does not exist in HEAD');
      };
      git.worktreeFileContents.set(`${cwd}:${path}`, 'newly created content');

      const result = await recordValidationCriticalFilesFromWorktree({
        git,
        cwd,
        dirtyBefore,
        diagnostic: 'missing test file',
      });

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        path,
        beforeHash: DELETED_SENTINEL,
        afterHash: sha256('newly created content'),
        diagnostic: 'missing test file',
      });
    });

    it('does not record a file dirty before but restored to its pre-fix content by fix end', async () => {
      const git = new FakeGitPort();
      const cwd = '/worktree';
      const path = 'src/restored.ts';

      const dirtyBefore = new Map<string, string | undefined>();
      dirtyBefore.set(path, 'same content');

      git.statusByCwd.set(cwd, ` M ${path}`);
      git.worktreeFileContents.set(`${cwd}:${path}`, 'same content');

      const result = await recordValidationCriticalFilesFromWorktree({
        git,
        cwd,
        dirtyBefore,
        diagnostic: 'some diagnostic',
      });

      expect(result).toHaveLength(0);
    });

    it('does not record a file untouched throughout', async () => {
      const git = new FakeGitPort();
      const cwd = '/worktree';
      const dirtyBefore = new Map<string, string | undefined>();
      git.statusByCwd.set(cwd, '');

      const result = await recordValidationCriticalFilesFromWorktree({
        git,
        cwd,
        dirtyBefore,
        diagnostic: 'some diagnostic',
      });

      expect(result).toHaveLength(0);
    });

    it('does not record a file that was dirty before but restored to clean HEAD by fix end', async () => {
      const git = new FakeGitPort();
      const cwd = '/worktree';
      const path = 'src/reverted-to-head.ts';

      const dirtyBefore = new Map<string, string | undefined>();
      dirtyBefore.set(path, 'content before fix');

      // Restored to clean HEAD, so it is absent from git status
      git.statusByCwd.set(cwd, '');

      const result = await recordValidationCriticalFilesFromWorktree({
        git,
        cwd,
        dirtyBefore,
        diagnostic: 'diagnostic',
      });

      expect(result).toHaveLength(0);
    });
  });

  describe('recordValidationCriticalFilesFromCommits', () => {
    it('records changed files between commit SHAs including deleted files', async () => {
      const git = new FakeGitPort();
      const cwd = '/worktree';
      const headBefore = 'sha-before';
      const headAfter = 'sha-after';

      git.fileContentResults.set(`${headBefore}:src/file-a.ts`, 'content A before');
      git.fileContentResults.set(`${headAfter}:src/file-a.ts`, 'content A after');

      git.fileContentResults.set(`${headBefore}:src/deleted-file.ts`, 'content before deletion');
      // src/deleted-file.ts is deleted at headAfter, so fileContent throws
      const origFileContent = git.fileContent.bind(git);
      git.fileContent = async (c: string, ref: string, path: string) => {
        if (ref === headAfter && path === 'src/deleted-file.ts') {
          throw new Error('does not exist');
        }
        return origFileContent(c, ref, path);
      };

      const result = await recordValidationCriticalFilesFromCommits({
        git,
        cwd,
        headBeforeFix: headBefore,
        headAfterFix: headAfter,
        changedFiles: ['src/file-a.ts', 'src/deleted-file.ts'],
        diagnostic: 'test failed',
        recordedAtIteration: 1,
      });

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        path: 'src/file-a.ts',
        beforeHash: sha256('content A before'),
        afterHash: sha256('content A after'),
        diagnostic: 'test failed',
        recordedAtIteration: 1,
      });
      expect(result[1]).toEqual({
        path: 'src/deleted-file.ts',
        beforeHash: sha256('content before deletion'),
        afterHash: DELETED_SENTINEL,
        diagnostic: 'test failed',
        recordedAtIteration: 1,
      });
    });

    it('skips files where beforeHash === afterHash', async () => {
      const git = new FakeGitPort();
      const cwd = '/worktree';
      const headBefore = 'sha-before';
      const headAfter = 'sha-after';

      git.fileContentResults.set(`${headBefore}:src/file-same.ts`, 'identical content');
      git.fileContentResults.set(`${headAfter}:src/file-same.ts`, 'identical content');

      const result = await recordValidationCriticalFilesFromCommits({
        git,
        cwd,
        headBeforeFix: headBefore,
        headAfterFix: headAfter,
        changedFiles: ['src/file-same.ts'],
        diagnostic: 'test failed',
      });

      expect(result).toHaveLength(0);
    });
  });

  describe('wasRevertedToBeforeState', () => {
    const critical: ValidationCriticalFile = {
      path: 'src/timeout.ts',
      beforeHash: sha256('before content'),
      afterHash: sha256('fixed content'),
      diagnostic: 'timeout error',
    };

    it('returns true on exact match with beforeHash', () => {
      expect(wasRevertedToBeforeState({ currentHash: sha256('before content'), critical })).toBe(
        true,
      );
    });

    it('returns false for afterHash or third state', () => {
      expect(wasRevertedToBeforeState({ currentHash: sha256('fixed content'), critical })).toBe(
        false,
      );
      expect(wasRevertedToBeforeState({ currentHash: sha256('other new content'), critical })).toBe(
        false,
      );
    });
  });

  describe('formatValidationCriticalFilesWarning', () => {
    it('returns empty string for empty array', () => {
      expect(formatValidationCriticalFilesWarning([])).toBe('');
    });

    it('formats a list of validation-critical files with diagnostic excerpts', () => {
      const files: ValidationCriticalFile[] = [
        {
          path: 'src/timeout.ts',
          beforeHash: 'hash1',
          afterHash: 'hash2',
          diagnostic: 'timeout in whisperx (exit 1)',
        },
      ];
      const output = formatValidationCriticalFilesWarning(files);
      expect(output).toContain('### Validation-Critical Files (Do Not Revert)');
      expect(output).toContain('- `src/timeout.ts` (timeout in whisperx (exit 1))');
      expect(output).toContain('Do not instruct reverting or restoring them to prior states.');
    });
  });

  describe('checkValidationCriticalRevert', () => {
    it('detects when a changed file matches beforeHash', async () => {
      const git = new FakeGitPort();
      const cwd = '/worktree';
      const headSha = 'head-123';
      const path = 'src/timeout.ts';

      const critical = new Map<string, ValidationCriticalFile>();
      critical.set(path, {
        path,
        beforeHash: sha256('pre-fix content'),
        afterHash: sha256('post-fix content'),
        diagnostic: 'timeout failure',
      });

      git.fileContentResults.set(`${headSha}:${path}`, 'pre-fix content');

      const check = await checkValidationCriticalRevert({
        git,
        cwd,
        changedFiles: [path],
        critical,
        headAfterFix: headSha,
      });

      expect(check.reverted).toBe(true);
      expect(check.path).toBe(path);
      expect(check.diagnostic).toBe('timeout failure');
    });

    it('returns reverted: false when file has afterHash or different content', async () => {
      const git = new FakeGitPort();
      const cwd = '/worktree';
      const headSha = 'head-123';
      const path = 'src/timeout.ts';

      const critical = new Map<string, ValidationCriticalFile>();
      critical.set(path, {
        path,
        beforeHash: sha256('pre-fix content'),
        afterHash: sha256('post-fix content'),
        diagnostic: 'timeout failure',
      });

      git.fileContentResults.set(`${headSha}:${path}`, 'post-fix content');

      const check = await checkValidationCriticalRevert({
        git,
        cwd,
        changedFiles: [path],
        critical,
        headAfterFix: headSha,
      });

      expect(check.reverted).toBe(false);
    });
  });
});
