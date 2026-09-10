import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hasEvidence, classifyResultFailure } from '../failure-classification.js';

describe('failure-classification', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'failure-class-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('hasEvidence', () => {
    it('returns false when stdoutPath is undefined or empty', () => {
      expect(hasEvidence(undefined)).toBe(false);
      expect(hasEvidence('')).toBe(false);
    });

    it('returns false when stdout file does not exist', () => {
      expect(hasEvidence(join(tempDir, 'nonexistent.log'))).toBe(false);
    });

    it('returns false when stdout file is 0 bytes', () => {
      const log = join(tempDir, 'empty.log');
      writeFileSync(log, '');
      expect(hasEvidence(log)).toBe(false);
      expect(classifyResultFailure(log)).toBe('unrecoverable_artifact');
    });

    it('returns true when stdout file has content', () => {
      const log = join(tempDir, 'build.log');
      writeFileSync(log, 'pnpm build succeeded\n');
      expect(hasEvidence(log)).toBe(true);
      expect(classifyResultFailure(log)).toBe('serialization_artifact');
    });

    it('returns true when a candidate path exists on disk with content (#1162)', () => {
      const log = join(tempDir, 'empty.log');
      writeFileSync(log, '');

      const cand = join(tempDir, 'result.json');
      writeFileSync(cand, '{"result":"done_with_fixes"}');

      expect(
        hasEvidence(log, {
          candidatePaths: ['result.json'],
          cwd: tempDir,
        }),
      ).toBe(true);
      expect(
        classifyResultFailure(log, {
          candidatePaths: ['result.json'],
          cwd: tempDir,
        }),
      ).toBe('serialization_artifact');
    });

    it('returns false when candidate path does not exist and stdout is empty', () => {
      const log = join(tempDir, 'empty.log');
      writeFileSync(log, '');

      expect(
        hasEvidence(log, {
          candidatePaths: ['result.json'],
          cwd: tempDir,
        }),
      ).toBe(false);
      expect(
        classifyResultFailure(log, {
          candidatePaths: ['result.json'],
          cwd: tempDir,
        }),
      ).toBe('unrecoverable_artifact');
    });
  });
});
