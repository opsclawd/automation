import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('signature_changePrompts', () => {
  describe('prompts/plan-write/plan-write.md', () => {
    it('documents the signature_changes JSON field for V2 tasks', () => {
      const template = readFileSync(
        new URL('../../../../prompts/plan-write/plan-write.md', import.meta.url),
        'utf-8',
      );
      expect(template).toContain('signature_changes');
    });

    it('documents the reference_files JSON field for V2 tasks', () => {
      const template = readFileSync(
        new URL('../../../../prompts/plan-write/plan-write.md', import.meta.url),
        'utf-8',
      );
      expect(template).toContain('"reference_files": ["path/to/read-only.ts"]');
      expect(template).toContain('- `tasks[].reference_files`: read-only files');
      expect(template).toContain('must modify and commit');
      expect(template).toContain(
        'Declaration files MUST be in expected_files (or legacy files), or reference_files (when change is "not_modified")',
      );
      expect(template).toContain(
        'Declaration files for `"not_modified"` entries may be listed in `reference_files`',
      );
      expect(template).toContain('breaking: false');
      expect(template).toContain('pass-through');
    });

    it('requires signature_changes for parameter-list changes to exported APIs', () => {
      const template = readFileSync(
        new URL('../../../../prompts/plan-write/plan-write.md', import.meta.url),
        'utf-8',
      );
      const lowerTemplate = template.toLowerCase();
      expect(lowerTemplate).toContain('parameter-list');
      expect(lowerTemplate).toContain('signature_change');
    });

    it('requires signature_changes for return-type changes to exported APIs', () => {
      const template = readFileSync(
        new URL('../../../../prompts/plan-write/plan-write.md', import.meta.url),
        'utf-8',
      );
      const lowerTemplate = template.toLowerCase();
      expect(lowerTemplate).toContain('return-type');
      expect(lowerTemplate).toContain('signature_change');
    });

    it('requires signature_changes for overload-set changes to exported APIs', () => {
      const template = readFileSync(
        new URL('../../../../prompts/plan-write/plan-write.md', import.meta.url),
        'utf-8',
      );
      const lowerTemplate = template.toLowerCase();
      expect(lowerTemplate).toContain('overload-set');
      expect(lowerTemplate).toContain('signature_change');
    });

    it('requires signature_changes for required-generic changes to exported APIs', () => {
      const template = readFileSync(
        new URL('../../../../prompts/plan-write/plan-write.md', import.meta.url),
        'utf-8',
      );
      const lowerTemplate = template.toLowerCase();
      expect(lowerTemplate).toContain('required-generic');
      expect(lowerTemplate).toContain('signature_change');
    });

    it('requires signature_changes for required-member-shape changes to exported APIs', () => {
      const template = readFileSync(
        new URL('../../../../prompts/plan-write/plan-write.md', import.meta.url),
        'utf-8',
      );
      const lowerTemplate = template.toLowerCase();
      expect(lowerTemplate).toContain('required-member-shape');
      expect(lowerTemplate).toContain('signature_change');
    });

    it('preserves the port/adapter atomicity hard rule', () => {
      const template = readFileSync(
        new URL('../../../../prompts/plan-write/plan-write.md', import.meta.url),
        'utf-8',
      );
      expect(template).toContain('PORT/INTERFACE CHANGES');
      expect(template).toContain('same task');
    });

    it('documents modified and not_modified signature annotations', () => {
      const template = readFileSync(
        new URL('../../../../prompts/plan-write/plan-write.md', import.meta.url),
        'utf-8',
      );
      expect(template).toContain('"change": "modified"');
      expect(template).toContain('"not_modified"');
      expect(template).toContain('"note"');
    });

    it('requires reference-only signature entries to use not_modified', () => {
      const template = readFileSync(
        new URL('../../../../prompts/plan-write/plan-write.md', import.meta.url),
        'utf-8',
      );
      expect(template).toContain('referenced for context');
      expect(template).toContain('MUST set `"change": "not_modified"`');
    });

    it('documents strict signature entry validation', () => {
      const template = readFileSync(
        new URL('../../../../prompts/plan-write/plan-write.md', import.meta.url),
        'utf-8',
      );
      expect(template).toContain('Unknown fields in a `signature_changes` entry are rejected');
    });
  });

  describe('prompts/plan-write/plan-write-repair.md', () => {
    it('preserves V2 version when repairing', () => {
      const template = readFileSync(
        new URL('../../../../prompts/plan-write/plan-write-repair.md', import.meta.url),
        'utf-8',
      );
      expect(template).toContain('version: 2');
    });

    it('preserves signature_changes field in V2 repairs', () => {
      const template = readFileSync(
        new URL('../../../../prompts/plan-write/plan-write-repair.md', import.meta.url),
        'utf-8',
      );
      expect(template).toContain('signature_changes');
    });

    it('does not downgrade V2 to V1 when repairing', () => {
      const template = readFileSync(
        new URL('../../../../prompts/plan-write/plan-write-repair.md', import.meta.url),
        'utf-8',
      );
      expect(template).not.toContain('downgrade');
      expect(template).not.toContain('migrate');
    });
  });
});
