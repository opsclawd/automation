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
    it('identifies protected files including nested .gitignore and .github files', () => {
      expect(isProtectedFilePath('.gitignore')).toBe(true);
      expect(isProtectedFilePath('nested/.gitignore')).toBe(true);
      expect(isProtectedFilePath('packages/app/src/.gitignore')).toBe(true);
      expect(isProtectedFilePath('.ai-orchestrator.json')).toBe(true);
      expect(isProtectedFilePath('.github')).toBe(true);
      expect(isProtectedFilePath('.github/workflows/ci.yml')).toBe(true);
      expect(isProtectedFilePath('src/app.ts')).toBe(false);
      expect(isProtectedFilePath('get_diff.sh')).toBe(false);
      expect(isProtectedFilePath('foo.gitignore')).toBe(false);
      expect(isProtectedFilePath('packages/foo.gitignore')).toBe(false);
    });
  });

  describe('undeclaredUntrackedFiles', () => {
    it('filters out writable, reference, exempt, protected, and orchestrator artifact files', () => {
      const status = [
        '?? declared.ts',
        '?? ref.md',
        '?? exempt.txt',
        '?? .gitignore',
        '?? nested/.gitignore',
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

    it('exempts an untracked directory when a file inside it is in writableFiles, referenceFiles, or exemptFiles', () => {
      const status = ['?? src/', '?? docs/', '?? fixtures/', '?? scratch_dir/'].join('\n');

      const writable = new Set(['src/index.ts']);
      const reference = new Set(['docs/guide.md']);
      const exempt = new Set(['fixtures/test.json']);

      const untracked = undeclaredUntrackedFiles(status, writable, reference, exempt);
      expect(untracked).toEqual(['scratch_dir']);
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
    it('deletes eligible untracked files at root and nested depths', async () => {
      const tmpCwd = mkdtempSync(join(tmpdir(), 'remediation-depth-test-'));
      try {
        const rootFile = join(tmpCwd, 'scratch.js');
        const nestedDir = join(tmpCwd, 'apps/web/src');
        mkdirSync(nestedDir, { recursive: true });
        const nestedFile = join(nestedDir, 'test-mock.ts');

        writeFileSync(rootFile, 'console.log(1);');
        writeFileSync(nestedFile, 'console.log(2);');

        const status = '?? scratch.js\n?? apps/web/src/test-mock.ts';
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

        expect(deleteWorktreeFile).toHaveBeenCalledWith(tmpCwd, 'scratch.js');
        expect(deleteWorktreeFile).toHaveBeenCalledWith(tmpCwd, 'apps/web/src/test-mock.ts');
        expect(result.remediated).toBe(true);
        expect(result.deletedFiles).toEqual(['apps/web/src/test-mock.ts', 'scratch.js']);
        expect(result.remainingFiles).toEqual([]);
        expect(result.allScratchFiles).toEqual(['apps/web/src/test-mock.ts', 'scratch.js']);
        expect(existsSync(rootFile)).toBe(false);
        expect(existsSync(nestedFile)).toBe(false);

        const report = JSON.parse(await artifacts.read(runUuid, SCRATCH_FILES_ARTIFACT_PATH));
        expect(report.steps).toHaveLength(1);
        expect(report.steps[0]).toEqual({
          phaseId: 'implement',
          stepIndex: 1,
          totalSteps: 2,
          stepTitle: 'Step 1',
          files: ['apps/web/src/test-mock.ts', 'scratch.js'],
        });
      } finally {
        rmSync(tmpCwd, { recursive: true, force: true });
      }
    });

    it('preserves exact nested expected_files and may_extend deliverables', async () => {
      const tmpCwd = mkdtempSync(join(tmpdir(), 'remediation-preserve-test-'));
      try {
        const expectedFile = join(tmpCwd, 'apps/web/src/deliverable.ts');
        const mayExtendFile = join(tmpCwd, 'packages/domain/src/extended.ts');
        const scratchFile = join(tmpCwd, 'packages/domain/src/scratch.ts');

        mkdirSync(join(tmpCwd, 'apps/web/src'), { recursive: true });
        mkdirSync(join(tmpCwd, 'packages/domain/src'), { recursive: true });

        writeFileSync(expectedFile, '// deliverable');
        writeFileSync(mayExtendFile, '// may_extend');
        writeFileSync(scratchFile, '// scratch');

        const status =
          '?? apps/web/src/deliverable.ts\n?? packages/domain/src/extended.ts\n?? packages/domain/src/scratch.ts';
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
          writableFiles: new Set([
            'apps/web/src/deliverable.ts',
            'packages/domain/src/extended.ts',
          ]),
          referenceFiles: new Set(),
          exemptFiles: new Set(),
          artifacts,
          deleteWorktreeFile,
        });

        expect(deleteWorktreeFile).not.toHaveBeenCalledWith(tmpCwd, 'apps/web/src/deliverable.ts');
        expect(deleteWorktreeFile).not.toHaveBeenCalledWith(
          tmpCwd,
          'packages/domain/src/extended.ts',
        );
        expect(deleteWorktreeFile).toHaveBeenCalledWith(tmpCwd, 'packages/domain/src/scratch.ts');
        expect(result.deletedFiles).toEqual(['packages/domain/src/scratch.ts']);
        expect(result.remainingFiles).toEqual([]);
        expect(result.remediated).toBe(true);
        expect(existsSync(expectedFile)).toBe(true);
        expect(existsSync(mayExtendFile)).toBe(true);
        expect(existsSync(scratchFile)).toBe(false);
      } finally {
        rmSync(tmpCwd, { recursive: true, force: true });
      }
    });

    it('does not exempt an undeclared untracked path merely because its parent is permitted', async () => {
      const tmpCwd = mkdtempSync(join(tmpdir(), 'remediation-parent-test-'));
      try {
        const declaredFile = join(tmpCwd, 'packages/application/src/index.ts');
        const undeclaredFile = join(tmpCwd, 'packages/application/src/undeclared.ts');

        mkdirSync(join(tmpCwd, 'packages/application/src'), { recursive: true });

        writeFileSync(declaredFile, '// declared');
        writeFileSync(undeclaredFile, '// undeclared');

        const status =
          '?? packages/application/src/index.ts\n?? packages/application/src/undeclared.ts';
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
          writableFiles: new Set(['packages/application/src/index.ts']),
          referenceFiles: new Set(),
          exemptFiles: new Set(),
          artifacts,
          deleteWorktreeFile,
        });

        expect(deleteWorktreeFile).toHaveBeenCalledWith(
          tmpCwd,
          'packages/application/src/undeclared.ts',
        );
        expect(deleteWorktreeFile).not.toHaveBeenCalledWith(
          tmpCwd,
          'packages/application/src/index.ts',
        );
        expect(result.deletedFiles).toEqual(['packages/application/src/undeclared.ts']);
        expect(result.remainingFiles).toEqual([]);
        expect(result.remediated).toBe(true);
        expect(existsSync(declaredFile)).toBe(true);
        expect(existsSync(undeclaredFile)).toBe(false);
      } finally {
        rmSync(tmpCwd, { recursive: true, force: true });
      }
    });

    it('retains orchestrator artifacts and protected paths at every depth', async () => {
      const tmpCwd = mkdtempSync(join(tmpdir(), 'remediation-orch-test-'));
      try {
        const gitignore = join(tmpCwd, '.gitignore');
        const orchestratorJson = join(tmpCwd, '.ai-orchestrator.json');
        const githubWorkflow = join(tmpCwd, '.github/workflows/ci.yml');
        const planMd = join(tmpCwd, 'plan.md');
        const scratchJson = join(tmpCwd, '.ai-tmp/scratch-files.json');
        const scratchJs = join(tmpCwd, 'scratch.js');
        const nestedScratch = join(tmpCwd, 'nested/scratch.txt');

        mkdirSync(join(tmpCwd, '.github/workflows'), { recursive: true });
        mkdirSync(join(tmpCwd, '.ai-tmp'), { recursive: true });
        mkdirSync(join(tmpCwd, 'nested'), { recursive: true });

        writeFileSync(gitignore, 'node_modules');
        writeFileSync(orchestratorJson, '{}');
        writeFileSync(githubWorkflow, 'name: CI');
        writeFileSync(planMd, '# Plan');
        writeFileSync(scratchJson, '{}');
        writeFileSync(scratchJs, 'console.log(1)');
        writeFileSync(nestedScratch, 'temp');

        const status = [
          '?? .gitignore',
          '?? .ai-orchestrator.json',
          '?? .github/workflows/ci.yml',
          '?? plan.md',
          '?? .ai-tmp/scratch-files.json',
          '?? scratch.js',
          '?? nested/scratch.txt',
        ].join('\n');

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
        });

        expect(result.allScratchFiles).toEqual(['nested/scratch.txt', 'scratch.js']);
        expect(result.deletedFiles).toEqual(['nested/scratch.txt', 'scratch.js']);
        expect(result.remainingFiles).toEqual([]);
        expect(result.remediated).toBe(true);

        expect(deleteWorktreeFile).toHaveBeenCalledTimes(2);
        expect(deleteWorktreeFile).toHaveBeenCalledWith(tmpCwd, 'nested/scratch.txt');
        expect(deleteWorktreeFile).toHaveBeenCalledWith(tmpCwd, 'scratch.js');

        expect(existsSync(gitignore)).toBe(true);
        expect(existsSync(orchestratorJson)).toBe(true);
        expect(existsSync(githubWorkflow)).toBe(true);
        expect(existsSync(planMd)).toBe(true);
        expect(existsSync(scratchJson)).toBe(true);
        expect(existsSync(scratchJs)).toBe(false);
        expect(existsSync(nestedScratch)).toBe(false);
      } finally {
        rmSync(tmpCwd, { recursive: true, force: true });
      }
    });

    it('continues after one deletion failure and reports deletedFiles and remainingFiles accurately', async () => {
      const tmpCwd = mkdtempSync(join(tmpdir(), 'remediation-failure-test-'));
      try {
        const file1 = join(tmpCwd, 'file1.ts');
        const file2 = join(tmpCwd, 'file2.ts');
        const file3 = join(tmpCwd, 'file3.ts');

        writeFileSync(file1, '1');
        writeFileSync(file2, '2');
        writeFileSync(file3, '3');

        const status = '?? file1.ts\n?? file2.ts\n?? file3.ts';
        const artifacts = new FakeArtifactStore();
        const runUuid = 'test-run-uuid';

        const deleteWorktreeFile = vi.fn(async (cwd: string, rel: string) => {
          if (rel === 'file2.ts') {
            throw new Error('Permission denied');
          }
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
        });

        expect(deleteWorktreeFile).toHaveBeenCalledWith(tmpCwd, 'file1.ts');
        expect(deleteWorktreeFile).toHaveBeenCalledWith(tmpCwd, 'file2.ts');
        expect(deleteWorktreeFile).toHaveBeenCalledWith(tmpCwd, 'file3.ts');

        expect(result.deletedFiles).toEqual(['file1.ts', 'file3.ts']);
        expect(result.remainingFiles).toEqual(['file2.ts']);
        expect(result.remediated).toBe(true);

        expect(existsSync(file1)).toBe(false);
        expect(existsSync(file2)).toBe(true);
        expect(existsSync(file3)).toBe(false);
      } finally {
        rmSync(tmpCwd, { recursive: true, force: true });
      }
    });

    it('sets remediated only when at least one deletion succeeds', async () => {
      const artifacts = new FakeArtifactStore();
      const runUuid = 'test-run-uuid';

      // Case 1: no scratch files
      const resultClean = await remediateScratchFiles({
        cwd: '/tmp',
        runUuid,
        status: '',
        writableFiles: new Set(),
        referenceFiles: new Set(),
        exemptFiles: new Set(),
        artifacts,
      });
      expect(resultClean.remediated).toBe(false);
      expect(resultClean.deletedFiles).toEqual([]);
      expect(resultClean.remainingFiles).toEqual([]);

      // Case 2: scratch files exist, but deleteWorktreeFile not provided
      const resultNoDeletePort = await remediateScratchFiles({
        cwd: '/tmp',
        runUuid,
        status: '?? scratch.js\n?? nested/scratch.ts',
        writableFiles: new Set(),
        referenceFiles: new Set(),
        exemptFiles: new Set(),
        artifacts,
      });
      expect(resultNoDeletePort.remediated).toBe(false);
      expect(resultNoDeletePort.deletedFiles).toEqual([]);
      expect(resultNoDeletePort.remainingFiles).toEqual(['nested/scratch.ts', 'scratch.js']);

      // Case 3: scratch files exist, but all deletion attempts fail
      const resultAllFail = await remediateScratchFiles({
        cwd: '/tmp',
        runUuid,
        status: '?? scratch.js\n?? nested/scratch.ts',
        writableFiles: new Set(),
        referenceFiles: new Set(),
        exemptFiles: new Set(),
        artifacts,
        deleteWorktreeFile: async () => false,
      });
      expect(resultAllFail.remediated).toBe(false);
      expect(resultAllFail.deletedFiles).toEqual([]);
      expect(resultAllFail.remainingFiles).toEqual(['nested/scratch.ts', 'scratch.js']);

      // Case 4: at least one deletion succeeds
      const resultSuccess = await remediateScratchFiles({
        cwd: '/tmp',
        runUuid,
        status: '?? scratch.js\n?? nested/scratch.ts',
        writableFiles: new Set(),
        referenceFiles: new Set(),
        exemptFiles: new Set(),
        artifacts,
        deleteWorktreeFile: async (_cwd, rel) => rel === 'scratch.js',
      });
      expect(resultSuccess.remediated).toBe(true);
      expect(resultSuccess.deletedFiles).toEqual(['scratch.js']);
      expect(resultSuccess.remainingFiles).toEqual(['nested/scratch.ts']);
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

    describe('event emission', () => {
      it('emits step.scratch_files_left warning when phase is implement and stepIndex is provided', async () => {
        const artifacts = new FakeArtifactStore();
        const emit = vi.fn();

        await remediateScratchFiles({
          cwd: '/tmp',
          runUuid: 'test-run-uuid',
          status: '?? scratch.js\n?? deep/scratch.ts',
          writableFiles: new Set(),
          referenceFiles: new Set(),
          exemptFiles: new Set(),
          artifacts,
          emit,
          phase: 'implement',
          stepIndex: 1,
          totalSteps: 3,
          stepTitle: 'Implement feature',
        });

        expect(emit).toHaveBeenCalledTimes(1);
        expect(emit).toHaveBeenCalledWith(
          'step.scratch_files_left',
          'warn',
          'step 1/3 left undeclared files: deep/scratch.ts, scratch.js',
          {
            index: 1,
            total: 3,
            taskTitle: 'Implement feature',
            files: ['deep/scratch.ts', 'scratch.js'],
          },
        );
      });

      it('emits ${phaseName}.scratch_files_left warning when phase is not implement or stepIndex is missing', async () => {
        const artifacts = new FakeArtifactStore();
        const emit = vi.fn();

        await remediateScratchFiles({
          cwd: '/tmp',
          runUuid: 'test-run-uuid',
          status: '?? get_diff.sh',
          writableFiles: new Set(),
          referenceFiles: new Set(),
          exemptFiles: new Set(),
          artifacts,
          emit,
          phase: 'compound',
        });

        expect(emit).toHaveBeenCalledTimes(1);
        expect(emit).toHaveBeenCalledWith(
          'compound.scratch_files_left',
          'warn',
          'compound phase left undeclared files: get_diff.sh',
          {
            phase: 'compound',
            files: ['get_diff.sh'],
          },
        );
      });

      it('does not emit any events when no scratch files are detected', async () => {
        const artifacts = new FakeArtifactStore();
        const emit = vi.fn();

        await remediateScratchFiles({
          cwd: '/tmp',
          runUuid: 'test-run-uuid',
          status: '?? declared.ts',
          writableFiles: new Set(['declared.ts']),
          referenceFiles: new Set(),
          exemptFiles: new Set(),
          artifacts,
          emit,
          phase: 'implement',
          stepIndex: 1,
        });

        expect(emit).not.toHaveBeenCalled();
      });
    });
  });
});
