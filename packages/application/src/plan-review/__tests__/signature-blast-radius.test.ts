import { describe, expect, it } from 'vitest';
import type {
  DeclaredSignatureChange,
  SignatureReferenceAnalysis,
  SignatureReferenceLocation,
} from '../../ports/signature-reference-analyzer-port.js';
import type { TaskManifest } from '../../results/schemas/task-manifest.js';
import {
  collectDeclaredSignatureChanges,
  evaluateSignatureBlastRadius,
  renderSignatureBlastRadiusDiagnostic,
} from '../signature-blast-radius.js';

function makeManifest(...tasks: object[]): TaskManifest {
  return { version: 2, task_count: tasks.length, tasks: tasks as never[] };
}

function makeAnalysis(
  changes: DeclaredSignatureChange[],
  referencesByChange: SignatureReferenceLocation[][],
  unresolvedByChange?: string[],
): SignatureReferenceAnalysis[] {
  return changes.map((change, i) => ({
    change,
    references: referencesByChange[i] ?? [],
    unresolvedDiagnostic: unresolvedByChange?.[i],
  }));
}

describe('signature-blast-radius', () => {
  describe('collectDeclaredSignatureChanges', () => {
    it('extracts signature changes from V2 tasks with task number', () => {
      const manifest = makeManifest(
        {
          n: 1,
          title: 'Task 1',
          expected_files: ['apps/api/src/cli.ts'],
          signature_changes: [{ declaration_file: 'apps/api/src/cli.ts', symbol: 'foo' }],
        },
        {
          n: 2,
          title: 'Task 2',
          expected_files: ['apps/api/src/compose.ts'],
          signature_changes: [{ declaration_file: 'apps/api/src/compose.ts', symbol: 'bar' }],
        },
      );

      const changes = collectDeclaredSignatureChanges(manifest);
      expect(changes).toEqual([
        { n: 1, declarationFile: 'apps/api/src/cli.ts', symbol: 'foo' },
        { n: 2, declarationFile: 'apps/api/src/compose.ts', symbol: 'bar' },
      ]);
    });

    it('returns empty array when no V2 tasks have signature changes', () => {
      const manifest = makeManifest({
        n: 1,
        title: 'Task 1',
        expected_files: ['apps/api/src/cli.ts'],
      });

      const changes = collectDeclaredSignatureChanges(manifest);
      expect(changes).toEqual([]);
    });

    it('returns empty array for V1 manifest', () => {
      const manifest: TaskManifest = {
        version: 1,
        task_count: 1,
        tasks: [{ n: 1, title: 'Task 1', files: ['apps/api/src/cli.ts'] }],
      };

      const changes = collectDeclaredSignatureChanges(manifest);
      expect(changes).toEqual([]);
    });
  });

  describe('evaluateSignatureBlastRadius', () => {
    it('passes when every reference belongs to the changing task', () => {
      const manifest = makeManifest({
        n: 1,
        title: 'Task 1',
        expected_files: ['apps/api/src/cli.ts', 'apps/api/src/compose.ts'],
        signature_changes: [
          { declaration_file: 'apps/api/src/cli.ts', symbol: 'WorkerLeasePort.heartbeat' },
        ],
      });

      const analyses = makeAnalysis(
        [{ declarationFile: 'apps/api/src/cli.ts', symbol: 'WorkerLeasePort.heartbeat' }],
        [
          [
            { file: 'apps/api/src/cli.ts', line: 84, column: 7, kind: 'call' },
            { file: 'apps/api/src/compose.ts', line: 5510, column: 13, kind: 'call' },
          ],
        ],
      );

      const result = evaluateSignatureBlastRadius(manifest, analyses);
      expect(result.pass).toBe(true);
      expect(result.failures).toEqual([]);
    });

    it('passes when a reference belongs to a later task', () => {
      const manifest = makeManifest(
        {
          n: 1,
          title: 'Task 1',
          expected_files: ['apps/api/src/cli.ts'],
          signature_changes: [
            { declaration_file: 'apps/api/src/cli.ts', symbol: 'WorkerLeasePort.heartbeat' },
          ],
        },
        {
          n: 2,
          title: 'Task 2',
          expected_files: ['apps/api/src/compose.ts'],
        },
      );

      const analyses = makeAnalysis(
        [{ declarationFile: 'apps/api/src/cli.ts', symbol: 'WorkerLeasePort.heartbeat' }],
        [[{ file: 'apps/api/src/compose.ts', line: 5510, column: 13, kind: 'call' }]],
      );

      const result = evaluateSignatureBlastRadius(manifest, analyses);
      expect(result.pass).toBe(true);
      expect(result.failures).toEqual([]);
    });

    it('fails when a reference belongs to an earlier task or no task', () => {
      const manifest = makeManifest(
        {
          n: 1,
          title: 'Task 1',
          expected_files: ['apps/api/src/cli.ts'],
          signature_changes: [
            { declaration_file: 'apps/api/src/cli.ts', symbol: 'WorkerLeasePort.heartbeat' },
          ],
        },
        {
          n: 3,
          title: 'Task 3',
          expected_files: ['apps/api/src/compose.ts'],
        },
      );

      const analyses = makeAnalysis(
        [{ declarationFile: 'apps/api/src/cli.ts', symbol: 'WorkerLeasePort.heartbeat' }],
        [
          [
            { file: 'apps/api/src/cli.ts', line: 84, column: 7, kind: 'call' },
            { file: 'apps/api/src/compose.ts', line: 5510, column: 13, kind: 'call' },
          ],
        ],
      );

      const result = evaluateSignatureBlastRadius(manifest, analyses);
      expect(result.pass).toBe(false);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toMatchObject({
        taskN: 1,
        symbol: 'WorkerLeasePort.heartbeat',
        declarationFile: 'apps/api/src/cli.ts',
      });
      expect(result.failures[0].uncoveredReferences).toContainEqual({
        file: 'apps/api/src/compose.ts',
        line: 5510,
        column: 13,
        kind: 'call',
      });
    });

    it('fails closed when a declaration cannot be resolved', () => {
      const manifest = makeManifest({
        n: 1,
        title: 'Task 1',
        expected_files: ['apps/api/src/cli.ts'],
        signature_changes: [
          { declaration_file: 'apps/api/src/cli.ts', symbol: 'WorkerLeasePort.heartbeat' },
        ],
      });

      const analyses = makeAnalysis(
        [{ declarationFile: 'apps/api/src/cli.ts', symbol: 'WorkerLeasePort.heartbeat' }],
        [[]],
        ['Could not resolve declaration for WorkerLeasePort.heartbeat'],
      );

      const result = evaluateSignatureBlastRadius(manifest, analyses);
      expect(result.pass).toBe(false);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toMatchObject({
        taskN: 1,
        symbol: 'WorkerLeasePort.heartbeat',
        declarationFile: 'apps/api/src/cli.ts',
        unresolvedDiagnostic: 'Could not resolve declaration for WorkerLeasePort.heartbeat',
      });
    });

    it('passes when the declaration file is a new file owned by the changing task and not yet created', () => {
      // Regression: plan-review runs before implement, so a task introducing
      // a brand-new port/file legitimately has no such file in the worktree
      // yet. The analyzer reports "Declaration file not found" for every new
      // file every time — that's expected, not a defect, and a symbol in a
      // file that doesn't exist has zero existing callers by construction.
      // (issue #652, run 2d8537cf)
      const manifest = makeManifest({
        n: 1,
        title: 'Task 1',
        expected_files: ['packages/application/src/ports/repository-scheduler-port.ts'],
        signature_changes: [
          {
            declaration_file: 'packages/application/src/ports/repository-scheduler-port.ts',
            symbol: 'SchedulerTelemetryPort',
          },
        ],
      });

      const analyses = makeAnalysis(
        [
          {
            declarationFile: 'packages/application/src/ports/repository-scheduler-port.ts',
            symbol: 'SchedulerTelemetryPort',
          },
        ],
        [[]],
        ['Declaration file not found: packages/application/src/ports/repository-scheduler-port.ts'],
      );

      const result = evaluateSignatureBlastRadius(manifest, analyses);
      expect(result.pass).toBe(true);
      expect(result.failures).toEqual([]);
    });

    it('passes when the declaration file is a new file owned by a later task', () => {
      const manifest = makeManifest(
        {
          n: 1,
          title: 'Task 1',
          expected_files: ['apps/api/src/repository-scheduler.ts'],
          signature_changes: [
            {
              declaration_file: 'apps/api/src/repository-runtime-catalog.ts',
              symbol: 'RepositoryRuntimeCatalog',
            },
          ],
        },
        {
          n: 2,
          title: 'Task 2',
          expected_files: ['apps/api/src/repository-runtime-catalog.ts'],
        },
      );

      const analyses = makeAnalysis(
        [
          {
            declarationFile: 'apps/api/src/repository-runtime-catalog.ts',
            symbol: 'RepositoryRuntimeCatalog',
          },
        ],
        [[]],
        ['Declaration file not found: apps/api/src/repository-runtime-catalog.ts'],
      );

      const result = evaluateSignatureBlastRadius(manifest, analyses);
      expect(result.pass).toBe(true);
      expect(result.failures).toEqual([]);
    });

    it('still fails when the missing declaration file is not owned by the changing or a later task', () => {
      // A genuine plan defect: the change cites a declaration file that no
      // task (current or later) is going to create — a typo'd path, or a
      // file that was supposed to come from a task that got removed. In
      // production task-manifest.json's own schema validation guarantees a
      // signature_changes entry's declaration_file is always in the
      // declaring task's own expected_files/files, so this exact shape is
      // unreachable end-to-end — this is defensive fail-closed coverage of
      // evaluateSignatureBlastRadius as a pure function taken in isolation.
      const manifest = makeManifest({
        n: 1,
        title: 'Task 1',
        expected_files: ['apps/api/src/cli.ts'],
        signature_changes: [
          { declaration_file: 'apps/api/src/nonexistent-typo.ts', symbol: 'Foo' },
        ],
      });

      const analyses = makeAnalysis(
        [{ declarationFile: 'apps/api/src/nonexistent-typo.ts', symbol: 'Foo' }],
        [[]],
        ['Declaration file not found: apps/api/src/nonexistent-typo.ts'],
      );

      const result = evaluateSignatureBlastRadius(manifest, analyses);
      expect(result.pass).toBe(false);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toMatchObject({
        taskN: 1,
        symbol: 'Foo',
        declarationFile: 'apps/api/src/nonexistent-typo.ts',
        unresolvedDiagnostic: 'Declaration file not found: apps/api/src/nonexistent-typo.ts',
      });
    });

    it('passes when the symbol is a new export not yet added to an existing, owned file', () => {
      // Regression: one level more granular than the "new file" case above —
      // the declaration file already exists (e.g. a shared schema.ts), but
      // the specific symbol the task is adding to it does not exist yet.
      // Same root cause: plan-review runs before implement, so a brand-new
      // export has zero existing callers by construction. (issue #652, run
      // 2d8537cf, second occurrence after the #788 file-level fix)
      const manifest = makeManifest({
        n: 1,
        title: 'Task 1',
        expected_files: ['packages/shared/src/config/schema.ts'],
        signature_changes: [
          {
            declaration_file: 'packages/shared/src/config/schema.ts',
            symbol: 'schedulerConfigSchema',
          },
        ],
      });

      const analyses = makeAnalysis(
        [
          {
            declarationFile: 'packages/shared/src/config/schema.ts',
            symbol: 'schedulerConfigSchema',
          },
        ],
        [[]],
        [
          "Could not resolve symbol 'schedulerConfigSchema' in: packages/shared/src/config/schema.ts",
        ],
      );

      const result = evaluateSignatureBlastRadius(manifest, analyses);
      expect(result.pass).toBe(true);
      expect(result.failures).toEqual([]);
    });

    it('still fails when the unresolved symbol is in a file not owned by the changing or a later task', () => {
      const manifest = makeManifest({
        n: 1,
        title: 'Task 1',
        expected_files: ['apps/api/src/cli.ts'],
        signature_changes: [{ declaration_file: 'apps/api/src/compose.ts', symbol: 'Foo' }],
      });

      const analyses = makeAnalysis(
        [{ declarationFile: 'apps/api/src/compose.ts', symbol: 'Foo' }],
        [[]],
        ["Could not resolve symbol 'Foo' in: apps/api/src/compose.ts"],
      );

      const result = evaluateSignatureBlastRadius(manifest, analyses);
      expect(result.pass).toBe(false);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toMatchObject({
        taskN: 1,
        symbol: 'Foo',
        declarationFile: 'apps/api/src/compose.ts',
        unresolvedDiagnostic: "Could not resolve symbol 'Foo' in: apps/api/src/compose.ts",
      });
    });

    it('groups and sorts failures by task symbol file and location', () => {
      const manifest = makeManifest({
        n: 1,
        title: 'Task 1',
        expected_files: ['src/a.ts', 'src/b.ts'],
        signature_changes: [
          { declaration_file: 'src/a.ts', symbol: 'foo' },
          { declaration_file: 'src/b.ts', symbol: 'bar' },
        ],
      });

      const analyses = makeAnalysis(
        [
          { declarationFile: 'src/a.ts', symbol: 'foo' },
          { declarationFile: 'src/b.ts', symbol: 'bar' },
        ],
        [
          [
            { file: 'src/c.ts', line: 10, column: 1, kind: 'call' },
            { file: 'src/c.ts', line: 20, column: 2, kind: 'call' },
          ],
          [{ file: 'src/d.ts', line: 30, column: 3, kind: 'call' }],
        ],
      );

      const result = evaluateSignatureBlastRadius(manifest, analyses);
      expect(result.pass).toBe(false);
      expect(result.failures).toHaveLength(2);

      expect(result.failures[0]).toMatchObject({
        taskN: 1,
        symbol: 'foo',
        declarationFile: 'src/a.ts',
      });
      expect(result.failures[0].uncoveredReferences).toHaveLength(2);
      expect(result.failures[1]).toMatchObject({
        taskN: 1,
        symbol: 'bar',
        declarationFile: 'src/b.ts',
      });
    });

    it('V1 and V2 tasks without signature changes are a no-op', () => {
      const manifest: TaskManifest = {
        version: 2,
        task_count: 2,
        tasks: [
          {
            n: 1,
            title: 'Task 1',
            expected_files: ['apps/api/src/cli.ts'],
          },
          {
            n: 2,
            title: 'Task 2',
            files: ['apps/api/src/compose.ts'],
          },
        ],
      };

      const analyses: SignatureReferenceAnalysis[] = [];

      const result = evaluateSignatureBlastRadius(manifest, analyses);
      expect(result.pass).toBe(true);
      expect(result.failures).toEqual([]);
    });

    it('uses expected_files for V2 tasks and files as fallback', () => {
      const manifest = makeManifest({
        n: 1,
        title: 'Task 1',
        expected_files: ['apps/api/src/cli.ts'],
        signature_changes: [
          { declaration_file: 'apps/api/src/cli.ts', symbol: 'WorkerLeasePort.heartbeat' },
        ],
      });

      const analyses = makeAnalysis(
        [{ declarationFile: 'apps/api/src/cli.ts', symbol: 'WorkerLeasePort.heartbeat' }],
        [[{ file: 'apps/api/src/cli.ts', line: 84, column: 7, kind: 'call' }]],
      );

      const result = evaluateSignatureBlastRadius(manifest, analyses);
      expect(result.pass).toBe(true);
    });

    it('normalizes backslash separators without filesystem I/O', () => {
      const manifest = makeManifest({
        n: 1,
        title: 'Task 1',
        expected_files: ['apps\\api\\src\\cli.ts'],
        signature_changes: [
          { declaration_file: 'apps/api/src/cli.ts', symbol: 'WorkerLeasePort.heartbeat' },
        ],
      });

      const analyses = makeAnalysis(
        [{ declarationFile: 'apps/api/src/cli.ts', symbol: 'WorkerLeasePort.heartbeat' }],
        [[{ file: 'apps/api/src/cli.ts', line: 84, column: 7, kind: 'call' }]],
      );

      const result = evaluateSignatureBlastRadius(manifest, analyses);
      expect(result.pass).toBe(true);
    });
  });

  describe('renderSignatureBlastRadiusDiagnostic', () => {
    it('renders failures in sorted order with exact format', () => {
      const failures = [
        {
          taskN: 3,
          symbol: 'WorkerLeasePort.heartbeat',
          declarationFile: 'apps/api/src/cli.ts',
          uncoveredReferences: [
            { file: 'apps/api/src/cli.ts', line: 84, column: 7, kind: 'call' as const },
            { file: 'apps/api/src/compose.ts', line: 5510, column: 13, kind: 'call' as const },
          ],
        },
      ];

      const rendered = renderSignatureBlastRadiusDiagnostic(failures);
      expect(rendered).toMatch(
        /Task 3 changes WorkerLeasePort\.heartbeat, but these reference files are not declared by Task 3 or a later task/,
      );
      expect(rendered).toContain('apps/api/src/cli.ts:84:7');
      expect(rendered).toContain('apps/api/src/compose.ts:5510:13');
    });

    it('renders unresolved diagnostic as failure', () => {
      const failures = [
        {
          taskN: 1,
          symbol: 'WorkerLeasePort.heartbeat',
          declarationFile: 'apps/api/src/cli.ts',
          unresolvedDiagnostic: 'Could not resolve declaration for WorkerLeasePort.heartbeat',
          uncoveredReferences: [],
        },
      ];

      const rendered = renderSignatureBlastRadiusDiagnostic(failures);
      expect(rendered).toMatch(/Task 1 changes WorkerLeasePort\.heartbeat/);
      expect(rendered).toMatch(/Could not resolve declaration/);
    });

    it('returns null when no failures', () => {
      const rendered = renderSignatureBlastRadiusDiagnostic([]);
      expect(rendered).toBeNull();
    });
  });
});
