import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isProtectedFilePath,
  undeclaredUntrackedFiles,
  remediateScratchFiles,
  recordScratchFilesReport,
  SCRATCH_FILES_ARTIFACT_PATH,
} from '../scratch-file-remediation.js';
import { FakeArtifactStore } from '../test-doubles/fake-artifact-store.js';

describe('scratch-file-remediation', () => {
  describe('isProtectedFilePath', () => {
    it('identifies protected files', () => {
      expect(isProtectedFilePath('.gitignore')).toBe(true);
      expect(isProtectedFilePath('.ai-orchestrator.json')).toBe(true);
      expect(isProtectedFilePath('.github/workflows/ci.yml')).toBe(true);
      expect(isProtectedFilePath('src/app.ts')).toBe(false);
      expect(isProtectedFilePath('get_diff.sh')).toBe(false);
    });
  });

  describe('undeclaredUntrackedFiles', () => {
    it('filters out writable, reference, exempt, protected, and orchestrator artifact files', () => {
      const status = [
        '?? declared.ts',
        '?? ref.md',
        '?? exempt.txt',
        '?? .gitignore',
        '?? plan.md',
        '?? scratch.js',
        '?? dir/nested.ts',
      ].join('\n');

      const writable = new Set(['declared.ts']);
      const reference = new Set(['ref.md']);
      const exempt = new Set(['exempt.txt']);

      const untracked = undeclaredUntrackedFiles(status, writable, reference, exempt);
      expect(untracked).toEqual(['dir/nested.ts', 'scratch.js']);
    });
  });

  describe('recordScratchFilesReport', () => {
    it('stores phaseId in ScratchFileStepRecord and differentiates phases with same stepIndex', async () => {
      const artifacts = new FakeArtifactStore();
      const runUuid = 'test-run-uuid';

      await recordScratchFilesReport(
        artifacts,
        runUuid,
        1,
        2,
        'Step 1',
        ['implement-scratch.js'],
        'implement',
      );
      await recordScratchFilesReport(
        artifacts,
        runUuid,
        1,
        1,
        'compound',
        ['compound-scratch.js'],
        'compound',
      );

      const report = JSON.parse(await artifacts.read(runUuid, SCRATCH_FILES_ARTIFACT_PATH));
      expect(report.steps).toHaveLength(2);
      expect(report.steps[0]).toEqual({
        phaseId: 'implement',
        stepIndex: 1,
        totalSteps: 2,
        stepTitle: 'Step 1',
        files: ['implement-scratch.js'],
      });
      expect(report.steps[1]).toEqual({
        phaseId: 'compound',
        stepIndex: 1,
        totalSteps: 1,
        stepTitle: 'compound',
        files: ['compound-scratch.js'],
      });
    });

    it('updates existing record when matching same phaseId and stepIndex', async () => {
      const artifacts = new FakeArtifactStore();
      const runUuid = 'test-run-uuid';

      await recordScratchFilesReport(
        artifacts,
        runUuid,
        1,
        2,
        'Step 1',
        ['old-file.js'],
        'implement',
      );
      await recordScratchFilesReport(
        artifacts,
        runUuid,
        1,
        2,
        'Step 1',
        ['new-file.js'],
        'implement',
      );

      const report = JSON.parse(await artifacts.read(runUuid, SCRATCH_FILES_ARTIFACT_PATH));
      expect(report.steps).toHaveLength(1);
      expect(report.steps[0]).toEqual({
        phaseId: 'implement',
        stepIndex: 1,
        totalSteps: 2,
        stepTitle: 'Step 1',
        files: ['new-file.js'],
      });
    });
  });

  describe('remediateScratchFiles', () => {
    it('deletes root untracked files and leaves subdirectory files while recording both in report', async () => {
      const tmpCwd = mkdtempSync(join(tmpdir(), 'remediation-test-'));
      try {
        const rootFile = join(tmpCwd, 'scratch.js');
        const subDir = join(tmpCwd, 'subdir');
        mkdirSync(subDir, { recursive: true });
        const subDirFile = join(subDir, 'nested.js');

        writeFileSync(rootFile, 'console.log(1);');
        writeFileSync(subDirFile, 'console.log(2);');

        const status = '?? scratch.js\n?? subdir/nested.js';
        const artifacts = new FakeArtifactStore();
        const runUuid = 'test-run-uuid';

        const deleteWorktreeFile = vi.fn(async (cwd: string, rel: string) => {
          const fullPath = join(cwd, rel);
          if (existsSync(fullPath)) {
            rmSync(fullPath);
            return true;
          }
          return false;
        });

        const result = await remediateScratchFiles({
          cwd: tmpCwd,
          runUuid,
          status,
          writableFiles: new Set(),
          referenceFiles: new Set(),
          exemptFiles: new Set(),
          artifacts,
          deleteWorktreeFile,
          phase: 'implement',
          stepIndex: 1,
          totalSteps: 2,
          stepTitle: 'Step 1',
        });

        expect(result.remediated).toBe(true);
        expect(result.deletedRootFiles).toEqual(['scratch.js']);
        expect(result.remainingSubDirFiles).toEqual(['subdir/nested.js']);
        expect(deleteWorktreeFile).toHaveBeenCalledWith(tmpCwd, 'scratch.js');
        expect(deleteWorktreeFile).not.toHaveBeenCalledWith(tmpCwd, 'subdir/nested.js');
        expect(existsSync(rootFile)).toBe(false);
        expect(existsSync(subDirFile)).toBe(true);

        const report = JSON.parse(await artifacts.read(runUuid, SCRATCH_FILES_ARTIFACT_PATH));
        expect(report.steps).toHaveLength(1);
        expect(report.steps[0]).toEqual({
          phaseId: 'implement',
          stepIndex: 1,
          totalSteps: 2,
          stepTitle: 'Step 1',
          files: ['scratch.js', 'subdir/nested.js'],
        });
      } finally {
        rmSync(tmpCwd, { recursive: true, force: true });
      }
    });

    it('merges new phase reports with existing step reports without overwriting', async () => {
      const tmpCwd = mkdtempSync(join(tmpdir(), 'remediation-merge-test-'));
      try {
        const artifacts = new FakeArtifactStore();
        const runUuid = 'test-run-uuid';

        // Existing report written by implement
        await artifacts.write({
          runId: runUuid,
          phaseId: 'implement',
          relativePath: SCRATCH_FILES_ARTIFACT_PATH,
          contents: JSON.stringify({
            steps: [
              {
                phaseId: 'implement',
                stepIndex: 1,
                totalSteps: 1,
                stepTitle: 'Task 1',
                files: ['packages/core/temp.ts'],
              },
            ],
          }),
        });

        const rootFile = join(tmpCwd, 'get_diff.sh');
        writeFileSync(rootFile, '#!/bin/bash');

        await remediateScratchFiles({
          cwd: tmpCwd,
          runUuid,
          status: '?? get_diff.sh',
          writableFiles: new Set(),
          referenceFiles: new Set(),
          exemptFiles: new Set(),
          artifacts,
          deleteWorktreeFile: async (cwd: string, rel: string) => {
            const p = join(cwd, rel);
            if (existsSync(p)) {
              rmSync(p);
              return true;
            }
            return false;
          },
          phase: 'compound',
          stepIndex: 1,
          totalSteps: 1,
          stepTitle: 'compound',
        });

        const report = JSON.parse(await artifacts.read(runUuid, SCRATCH_FILES_ARTIFACT_PATH));
        expect(report.steps).toHaveLength(2);
        expect(report.steps[0].phaseId).toBe('implement');
        expect(report.steps[0].stepTitle).toBe('Task 1');
        expect(report.steps[1].phaseId).toBe('compound');
        expect(report.steps[1].stepTitle).toBe('compound');
        expect(report.steps[1].files).toEqual(['get_diff.sh']);
      } finally {
        rmSync(tmpCwd, { recursive: true, force: true });
      }
    });
  });
});
