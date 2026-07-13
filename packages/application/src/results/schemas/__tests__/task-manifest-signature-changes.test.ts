import { describe, expect, it } from 'vitest';
import { taskManifestSchema } from '../task-manifest.js';

describe('signature_changes in task-manifest V2', () => {
  describe('parses valid V2 function and interface-member signature changes', () => {
    it('accepts a top-level function signature change', () => {
      const manifest = {
        version: 2,
        task_count: 1,
        tasks: [
          {
            n: 1,
            title: 'Add signature tracking',
            expected_files: ['packages/core/src/api.ts'],
            signature_changes: [
              { declaration_file: 'packages/core/src/api.ts', symbol: 'createClient' },
            ],
          },
        ],
      };
      const parsed = taskManifestSchema.parse(manifest);
      expect(parsed.tasks[0].signature_changes).toHaveLength(1);
      expect(parsed.tasks[0].signature_changes![0]).toMatchObject({
        declaration_file: 'packages/core/src/api.ts',
        symbol: 'createClient',
      });
    });

    it('accepts a qualified interface member signature change', () => {
      const manifest = {
        version: 2,
        task_count: 1,
        tasks: [
          {
            n: 1,
            title: 'Update heartbeat method',
            expected_files: ['packages/core/src/ports.ts'],
            signature_changes: [
              {
                declaration_file: 'packages/core/src/ports.ts',
                symbol: 'WorkerLeasePort.heartbeat',
              },
            ],
          },
        ],
      };
      const parsed = taskManifestSchema.parse(manifest);
      expect(parsed.tasks[0].signature_changes).toHaveLength(1);
      expect(parsed.tasks[0].signature_changes![0]).toMatchObject({
        declaration_file: 'packages/core/src/ports.ts',
        symbol: 'WorkerLeasePort.heartbeat',
      });
    });

    it('accepts multiple signature changes in the same task', () => {
      const manifest = {
        version: 2,
        task_count: 1,
        tasks: [
          {
            n: 1,
            title: 'Refactor API surface',
            expected_files: ['packages/core/src/api.ts', 'packages/core/src/ports.ts'],
            signature_changes: [
              { declaration_file: 'packages/core/src/api.ts', symbol: 'createClient' },
              { declaration_file: 'packages/core/src/api.ts', symbol: 'createAgent' },
              {
                declaration_file: 'packages/core/src/ports.ts',
                symbol: 'WorkerLeasePort.heartbeat',
              },
            ],
          },
        ],
      };
      const parsed = taskManifestSchema.parse(manifest);
      expect(parsed.tasks[0].signature_changes).toHaveLength(3);
    });
  });

  describe('keeps signature changes optional for V1 and existing V2 manifests', () => {
    it('accepts a V1 manifest without signature_changes', () => {
      const manifest = {
        version: 1,
        task_count: 1,
        tasks: [{ n: 1, title: 'Old task', files: ['src/foo.ts'] }],
      };
      const parsed = taskManifestSchema.parse(manifest);
      expect(parsed.version).toBe(1);
    });

    it('accepts a V2 manifest without signature_changes', () => {
      const manifest = {
        version: 2,
        task_count: 1,
        tasks: [{ n: 1, title: 'Existing task', expected_files: ['src/foo.ts'] }],
      };
      const parsed = taskManifestSchema.parse(manifest);
      expect(parsed.version).toBe(2);
      expect((parsed.tasks[0] as Record<string, unknown>).signature_changes).toBeUndefined();
    });

    it('accepts a V2 manifest with null signature_changes', () => {
      const manifest = {
        version: 2,
        task_count: 1,
        tasks: [
          {
            n: 1,
            title: 'Task with null sig',
            expected_files: ['src/foo.ts'],
            signature_changes: null,
          },
        ],
      };
      const parsed = taskManifestSchema.parse(manifest);
      expect(parsed.version).toBe(2);
    });
  });

  describe('rejects blank absolute and traversal signature change declarations', () => {
    it('rejects a blank declaration_file', () => {
      const manifest = {
        version: 2,
        task_count: 1,
        tasks: [
          {
            n: 1,
            title: 'Bad task',
            expected_files: ['packages/core/src/api.ts'],
            signature_changes: [{ declaration_file: '', symbol: 'createClient' }],
          },
        ],
      };
      expect(() => taskManifestSchema.parse(manifest)).toThrow();
    });

    it('rejects a blank symbol', () => {
      const manifest = {
        version: 2,
        task_count: 1,
        tasks: [
          {
            n: 1,
            title: 'Bad task',
            expected_files: ['packages/core/src/api.ts'],
            signature_changes: [{ declaration_file: 'packages/core/src/api.ts', symbol: '   ' }],
          },
        ],
      };
      expect(() => taskManifestSchema.parse(manifest)).toThrow();
    });

    it('rejects an absolute path as declaration_file', () => {
      const manifest = {
        version: 2,
        task_count: 1,
        tasks: [
          {
            n: 1,
            title: 'Bad task',
            expected_files: ['packages/core/src/api.ts'],
            signature_changes: [{ declaration_file: '/abs/path/to/file.ts', symbol: 'foo' }],
          },
        ],
      };
      expect(() => taskManifestSchema.parse(manifest)).toThrow();
    });

    it('rejects a dot-dot traversal path as declaration_file', () => {
      const manifest = {
        version: 2,
        task_count: 1,
        tasks: [
          {
            n: 1,
            title: 'Bad task',
            expected_files: ['packages/core/src/api.ts'],
            signature_changes: [{ declaration_file: '../escape.ts', symbol: 'foo' }],
          },
        ],
      };
      expect(() => taskManifestSchema.parse(manifest)).toThrow();
    });

    it('rejects a mixed dot-dot traversal path as declaration_file', () => {
      const manifest = {
        version: 2,
        task_count: 1,
        tasks: [
          {
            n: 1,
            title: 'Bad task',
            expected_files: ['packages/core/src/api.ts'],
            signature_changes: [{ declaration_file: 'foo/../bar/escape.ts', symbol: 'foo' }],
          },
        ],
      };
      expect(() => taskManifestSchema.parse(manifest)).toThrow();
    });

    it('rejects backslash traversal in declaration_file', () => {
      const manifest = {
        version: 2,
        task_count: 1,
        tasks: [
          {
            n: 1,
            title: 'Bad task',
            expected_files: ['packages/core/src/api.ts'],
            signature_changes: [{ declaration_file: 'foo\\..\\bar\\escape.ts', symbol: 'foo' }],
          },
        ],
      };
      expect(() => taskManifestSchema.parse(manifest)).toThrow();
    });
  });

  describe('rejects a signature declaration file outside the changing task ownership', () => {
    it('rejects a declaration_file not in expected_files', () => {
      const manifest = {
        version: 2,
        task_count: 1,
        tasks: [
          {
            n: 1,
            title: 'Task with unowned file',
            expected_files: ['packages/core/src/api.ts'],
            signature_changes: [
              { declaration_file: 'packages/other/src/unowned.ts', symbol: 'someSymbol' },
            ],
          },
        ],
      };
      expect(() => taskManifestSchema.parse(manifest)).toThrow();
    });

    it('rejects a declaration_file only in legacy files field but not in expected_files', () => {
      const manifest = {
        version: 2,
        task_count: 1,
        tasks: [
          {
            n: 1,
            title: 'Task with legacy files only',
            files: ['packages/core/src/api.ts'],
            expected_files: undefined,
            signature_changes: [
              { declaration_file: 'packages/core/src/api.ts', symbol: 'createClient' },
            ],
          },
        ],
      };
      const parsed = taskManifestSchema.parse(manifest);
      expect(parsed.tasks[0].signature_changes).toHaveLength(1);
    });

    it('rejects when declaration_file is in files but not expected_files', () => {
      const manifest = {
        version: 2,
        task_count: 1,
        tasks: [
          {
            n: 1,
            title: 'Task with mismatched fields',
            files: ['packages/core/src/api.ts'],
            expected_files: ['packages/core/src/other.ts'],
            signature_changes: [
              { declaration_file: 'packages/core/src/api.ts', symbol: 'createClient' },
            ],
          },
        ],
      };
      expect(() => taskManifestSchema.parse(manifest)).toThrow();
    });

    it('accepts declaration_file in expected_files even when files is also present', () => {
      const manifest = {
        version: 2,
        task_count: 1,
        tasks: [
          {
            n: 1,
            title: 'Task with both fields',
            files: ['packages/core/src/api.ts'],
            expected_files: ['packages/core/src/api.ts'],
            signature_changes: [
              { declaration_file: 'packages/core/src/api.ts', symbol: 'createClient' },
            ],
          },
        ],
      };
      const parsed = taskManifestSchema.parse(manifest);
      expect(parsed.tasks[0].signature_changes).toHaveLength(1);
    });
  });
});
