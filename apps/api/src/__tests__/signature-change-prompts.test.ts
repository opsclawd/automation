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

  describe('prompts/plan-review/plan-review.md', () => {
    it('requires the Agent to flag undeclared breaking changes', () => {
      const template = readFileSync(
        new URL('../../../../prompts/plan-review/plan-review.md', import.meta.url),
        'utf-8',
      );
      const lowerTemplate = template.toLowerCase();
      expect(lowerTemplate).toContain('undeclared breaking change');
      expect(lowerTemplate).toContain('signature');
    });

    it('treats analyzer evidence as authoritative for deterministic diagnostics', () => {
      const template = readFileSync(
        new URL('../../../../prompts/plan-review/plan-review.md', import.meta.url),
        'utf-8',
      );
      expect(template).toContain('analyzer');
      expect(template).toContain('authoritative');
    });

    it('checks later-task green boundaries for unsafe deferrals', () => {
      const template = readFileSync(
        new URL('../../../../prompts/plan-review/plan-review.md', import.meta.url),
        'utf-8',
      );
      const lowerTemplate = template.toLowerCase();
      expect(lowerTemplate).toContain('later-task');
      expect(lowerTemplate).toContain('deferral');
    });

    it('states that deterministic analyzer scope evidence cannot be rebutted', () => {
      const template = readFileSync(
        new URL('../../../../prompts/plan-review/plan-review.md', import.meta.url),
        'utf-8',
      );
      const lowerTemplate = template.toLowerCase();
      expect(lowerTemplate).toContain('deterministic');
      expect(lowerTemplate).toContain('cannot be rebutted');
    });
  });

  describe('prompts/plan-review/plan-fix.md', () => {
    it('names a general deterministic diagnostic pattern', () => {
      const template = readFileSync(
        new URL('../../../../prompts/plan-review/plan-fix.md', import.meta.url),
        'utf-8',
      );
      expect(template).toContain('deterministic');
    });

    it('permits edits to both plan.md and task-manifest.json', () => {
      const template = readFileSync(
        new URL('../../../../prompts/plan-review/plan-fix.md', import.meta.url),
        'utf-8',
      );
      expect(template).toContain('plan.md');
      expect(template).toContain('task-manifest.json');
    });

    it('requests edits to both artifacts for synchronized fixes', () => {
      const template = readFileSync(
        new URL('../../../../prompts/plan-review/plan-fix.md', import.meta.url),
        'utf-8',
      );
      expect(template.toLowerCase()).toContain('both');
    });

    it('uses {{var:deterministicDiagnostic}} composition variable', () => {
      const template = readFileSync(
        new URL('../../../../prompts/plan-review/plan-fix.md', import.meta.url),
        'utf-8',
      );
      expect(template).toContain('{{var:deterministicDiagnostic}}');
    });
  });
});
