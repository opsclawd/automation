import { describe, it, expect, vi } from 'vitest';
import {
  parseTaskManifest,
  derivePlanTasks,
  extractTaskBody,
  validatePlanTaskList,
} from '../plan-tasks.js';

describe('plan-tasks parsing and validation', () => {
  describe('parseTaskManifest', () => {
    it('valid manifest parsing', () => {
      const json = JSON.stringify({
        version: 1,
        task_count: 2,
        tasks: [
          { n: 1, title: 'First Task', files: ['f1.ts'], validation: ['v1'] },
          { n: 2, title: 'Second Task', files: ['f2.ts'], validation: ['v2'] },
        ],
      });
      const result = parseTaskManifest(json);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.manifest.version).toBe(1);
        expect(result.manifest.task_count).toBe(2);
        expect(result.manifest.tasks).toHaveLength(2);
        expect(result.manifest.tasks[0]?.title).toBe('First Task');
      }
    });

    it('malformed JSON', () => {
      const result = parseTaskManifest('{ version: 1, ');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('manifest is not valid JSON');
      }
    });

    it('wrong version', () => {
      const json = JSON.stringify({
        version: 2,
        task_count: 1,
        tasks: [{ n: 1, title: 'Task' }],
      });
      const result = parseTaskManifest(json);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('manifest validation failed');
      }
    });

    it('mismatched task_count', () => {
      const json = JSON.stringify({
        version: 1,
        task_count: 3,
        tasks: [
          { n: 1, title: 'T1' },
          { n: 2, title: 'T2' },
        ],
      });
      const result = parseTaskManifest(json);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('manifest validation failed');
      }
    });

    it('non-contiguous task numbers', () => {
      const json = JSON.stringify({
        version: 1,
        task_count: 2,
        tasks: [
          { n: 1, title: 'T1' },
          { n: 3, title: 'T3' },
        ],
      });
      const result = parseTaskManifest(json);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('manifest validation failed');
      }
    });

    it('empty titles', () => {
      const json = JSON.stringify({
        version: 1,
        task_count: 1,
        tasks: [{ n: 1, title: '' }],
      });
      const result = parseTaskManifest(json);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('manifest validation failed');
      }
    });
  });

  describe('extractTaskBody', () => {
    it('clean heading outside a fence', () => {
      const plan = `
## Task 1: Clean heading
Body line 1.
Body line 2.

## Task 2: Next task
Next body.
`;
      const result = extractTaskBody(plan, { taskNumber: 1 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.body.trim()).toBe('Body line 1.\nBody line 2.');
        expect(result.headingLine).toBe(2);
      }
    });

    it('H3 headings extraction', () => {
      const plan = `
### Task 1: Clean H3 heading
Body line 1.
Body line 2.

### Task 2: Next H3 task
Next body.
`;
      const result = extractTaskBody(plan, { taskNumber: 1 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.body.trim()).toBe('Body line 1.\nBody line 2.');
        expect(result.headingLine).toBe(2);
      }
    });

    it('H3 task heading extraction preserves H2 non-task headings', () => {
      const plan = `
### Task 1: H3 heading
Body line 1.

## Verification
Some verification.
`;
      const result = extractTaskBody(plan, { taskNumber: 1 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.body.trim()).toBe('Body line 1.\n\n## Verification\nSome verification.');
      }
    });

    it('unbalanced-fence raw fallback', () => {
      const plan = `
## Task 1: Heading one
\`\`\`
unclosed fence starts

## Task 2: Heading two
This body is inside the unclosed fence, but extracted since fences are odd.
`;
      const result = extractTaskBody(plan, { taskNumber: 2 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.body.trim()).toBe(
          'This body is inside the unclosed fence, but extracted since fences are odd.',
        );
      }
    });

    it('heading inside balanced fence rejection', () => {
      const plan = `
## Task 1: Heading one

\`\`\`
## Task 2: Fenced heading two
Fenced body.
\`\`\`

## Task 2: Real heading two
Real body.
`;
      const result = extractTaskBody(plan, { taskNumber: 2 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.body.trim()).toBe('Real body.');
        expect(result.headingLine).toBe(9);
      }
    });

    it('only fenced heading inside balanced fence returns structured failure', () => {
      const plan = `
## Task 1: Heading one

\`\`\`
## Task 2: Fenced heading two
Fenced body.
\`\`\`
`;
      const result = extractTaskBody(plan, { taskNumber: 2 });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('inside_balanced_fence_only');
      }
    });

    it('missing heading returns structured failure', () => {
      const plan = `
## Task 1: Heading one
`;
      const result = extractTaskBody(plan, { taskNumber: 2 });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('missing_heading');
      }
    });
  });

  describe('validatePlanTaskList', () => {
    it('valid manifest and matching plan', () => {
      const plan = `
## Task 1: T1
Body 1.

## Task 2: T2
Body 2.
`;
      const manifestJson = JSON.stringify({
        version: 1,
        task_count: 2,
        tasks: [
          { n: 1, title: 'T1' },
          { n: 2, title: 'T2' },
        ],
      });
      const result = validatePlanTaskList(plan, manifestJson);
      expect(result.success).toBe(true);
    });

    it('valid manifest and matching plan with H3 headings', () => {
      const plan = `
### Task 1: T1
Body 1.

### Task 2: T2
Body 2.
`;
      const manifestJson = JSON.stringify({
        version: 1,
        task_count: 2,
        tasks: [
          { n: 1, title: 'T1' },
          { n: 2, title: 'T2' },
        ],
      });
      const result = validatePlanTaskList(plan, manifestJson);
      expect(result.success).toBe(true);
    });

    it('manifest/prose count mismatch (missing from prose)', () => {
      const plan = `
## Task 1: T1
Body 1.
`;
      const manifestJson = JSON.stringify({
        version: 1,
        task_count: 2,
        tasks: [
          { n: 1, title: 'T1' },
          { n: 2, title: 'T2' },
        ],
      });
      const result = validatePlanTaskList(plan, manifestJson);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('manifest tasks missing from plan.md prose: Task 2');
      }
    });

    it('manifest/prose count mismatch (extra in prose)', () => {
      const plan = `
## Task 1: T1
## Task 2: T2
## Task 3: T3
`;
      const manifestJson = JSON.stringify({
        version: 1,
        task_count: 2,
        tasks: [
          { n: 1, title: 'T1' },
          { n: 2, title: 'T2' },
        ],
      });
      const result = validatePlanTaskList(plan, manifestJson);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('prose tasks not in manifest: Task 3');
      }
    });

    it('manifest duplicate titles', () => {
      const plan = `
## Task 1: T1
## Task 2: T2
`;
      const manifestJson = JSON.stringify({
        version: 1,
        task_count: 2,
        tasks: [
          { n: 1, title: 'T1' },
          { n: 2, title: 't1' },
        ],
      });
      const result = validatePlanTaskList(plan, manifestJson);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('duplicate task titles detected');
      }
    });

    it('no manifest validation: contiguous and sequential', () => {
      const plan = `
## Task 1: T1
## Task 2: T2
`;
      const result = validatePlanTaskList(plan);
      expect(result.success).toBe(true);
    });

    it('no manifest validation: contiguous and sequential with H3 headings', () => {
      const plan = `
### Task 1: T1
### Task 2: T2
`;
      const result = validatePlanTaskList(plan);
      expect(result.success).toBe(true);
    });

    it('no manifest validation: non-contiguous task numbers', () => {
      const plan = `
## Task 1: T1
## Task 3: T3
`;
      const result = validatePlanTaskList(plan);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('task numbers are not sequential');
      }
    });

    it('no manifest validation: duplicate titles', () => {
      const plan = `
## Task 1: T1
## Task 2: t1
`;
      const result = validatePlanTaskList(plan);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('duplicate task titles detected');
      }
    });

    it('manifest validation: prose task numbers are non-sequential', () => {
      const plan = `
## Task 1: T1
## Task 3: T2
`;
      const manifestJson = JSON.stringify({
        version: 1,
        task_count: 2,
        tasks: [
          { n: 1, title: 'T1' },
          { n: 2, title: 'T2' },
        ],
      });
      const result = validatePlanTaskList(plan, manifestJson);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('task numbers are not sequential');
      }
    });

    it('manifest validation: prose task titles are duplicate', () => {
      const plan = `
## Task 1: T1
## Task 2: t1
`;
      const manifestJson = JSON.stringify({
        version: 1,
        task_count: 2,
        tasks: [
          { n: 1, title: 'T1' },
          { n: 2, title: 'T2' },
        ],
      });
      const result = validatePlanTaskList(plan, manifestJson);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('duplicate task titles detected');
      }
    });

    it('H3 task heading extraction does not stop at H3 subheading', () => {
      const plan = `
### Task 1: H3 heading
Body line 1.
### Subheading
Subheading body.

### Task 2: Next task
Next task body.
`;
      const result = extractTaskBody(plan, { taskNumber: 1 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.body.trim()).toContain('### Subheading');
        expect(result.body.trim()).toContain('Subheading body.');
        expect(result.body.trim()).not.toContain('### Task 2:');
      }
    });

    it('manifest validation: warns on fixture-like task titles', () => {
      const plan = `
## Task 1: Clean heading
## Task 2: Some task
`;
      const manifestJson = JSON.stringify({
        version: 1,
        task_count: 2,
        tasks: [
          { n: 1, title: 'Clean heading' },
          { n: 2, title: 'Some task' },
        ],
      });
      const mockEvents = {
        publish: vi.fn(),
        subscribe: vi.fn(),
      };
      const ctx = {
        runId: 'test-run-id',
        runUuid: 'test-run-uuid',
        events: mockEvents,
        now: () => new Date('2026-06-28T12:00:00.000Z'),
      };
      const result = validatePlanTaskList(plan, manifestJson, ctx, 'plan-write');
      expect(result.success).toBe(true);
      expect(mockEvents.publish).toHaveBeenCalledWith('test-run-uuid', {
        runId: 'test-run-id',
        phase: 'plan-write',
        level: 'warn',
        type: 'sanity_check.fixture_title',
        message:
          "fixture-like task titles detected: title 'Some task' matches fixture pattern 'Some task'; ",
        timestamp: '2026-06-28T12:00:00.000Z',
        metadata: {},
      });
    });

    it('no manifest validation: warns on fixture-like task titles', () => {
      const plan = `
## Task 1: Clean heading
## Task 2: Some task
`;
      const mockEvents = {
        publish: vi.fn(),
        subscribe: vi.fn(),
      };
      const ctx = {
        runId: 'test-run-id',
        runUuid: 'test-run-uuid',
        events: mockEvents,
        now: () => new Date('2026-06-28T12:00:00.000Z'),
      };
      const result = validatePlanTaskList(plan, undefined, ctx, 'implement');
      expect(result.success).toBe(true);
      expect(mockEvents.publish).toHaveBeenCalledWith('test-run-uuid', {
        runId: 'test-run-id',
        phase: 'implement',
        level: 'warn',
        type: 'sanity_check.fixture_title',
        message:
          "fixture-like task titles detected: title 'Some task' matches fixture pattern 'Some task'; ",
        timestamp: '2026-06-28T12:00:00.000Z',
        metadata: {},
      });
    });
  });

  describe('derivePlanTasks', () => {
    it('derives from manifest when manifest is present', () => {
      const manifest = {
        version: 1,
        task_count: 2,
        tasks: [
          { n: 1, title: 'T1' },
          { n: 2, title: 'T2' },
        ],
      };
      const result = derivePlanTasks('', manifest);
      expect(result).toEqual([
        { index: 1, title: 'Task 1: T1' },
        { index: 2, title: 'Task 2: T2' },
      ]);
    });

    it('derives from markdown when manifest is absent', () => {
      const plan = `
## Task 1: Prose T1
## Task 2: Prose T2
`;
      const result = derivePlanTasks(plan);
      expect(result).toEqual([
        { index: 1, title: 'Task 1: Prose T1' },
        { index: 2, title: 'Task 2: Prose T2' },
      ]);
    });

    it('derives from markdown with H3 headings when manifest is absent', () => {
      const plan = `
### Task 1: Prose T1
### Task 2: Prose T2
`;
      const result = derivePlanTasks(plan);
      expect(result).toEqual([
        { index: 1, title: 'Task 1: Prose T1' },
        { index: 2, title: 'Task 2: Prose T2' },
      ]);
    });
  });
});
