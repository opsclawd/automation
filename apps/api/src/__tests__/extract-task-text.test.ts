import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { extractTaskText } from '../compose.js';

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop()!;
    rmSync(d, { recursive: true, force: true });
  }
});

function makePlan(content: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'extract-task-text-'));
  tempDirs.push(dir);
  const planPath = path.join(dir, 'plan.md');
  writeFileSync(planPath, content, 'utf-8');
  return planPath;
}

describe('extractTaskText', () => {
  it('extracts the body of the matching Task heading', () => {
    const planPath = makePlan(
      '# Plan\n\n## Task 1: First\n\nBody of task one.\n\n## Task 2: Second\n\nBody of task two.\n',
    );
    expect(extractTaskText(planPath, 1)).toBe('Body of task one.');
  });

  it('extracts the correct task when multiple tasks exist', () => {
    const planPath = makePlan(
      '## Task 1: Alpha\n\nAlpha body.\n\n## Task 2: Beta\n\nBeta body.\n\n## Task 3: Gamma\n\nGamma body.\n',
    );
    expect(extractTaskText(planPath, 2)).toBe('Beta body.');
  });

  it('handles "### Task N:" heading variant', () => {
    const planPath = makePlan(
      '### Task 3: Do something\n\nTask body here.\n\n### Task 4: Next\n\nOther.\n',
    );
    expect(extractTaskText(planPath, 3)).toBe('Task body here.');
  });

  it('is case-insensitive for the Task keyword', () => {
    const planPath = makePlan('## TASK 2: Upper\n\nUpper body.\n');
    expect(extractTaskText(planPath, 2)).toBe('Upper body.');
  });

  it('includes sub-headings (h3+) in the extracted body', () => {
    const planPath = makePlan(
      '## Task 1: With sub\n\n### Sub-heading\n\nSub content.\n\n## Task 2: Next\n\nOther.\n',
    );
    expect(extractTaskText(planPath, 1)).toContain('### Sub-heading');
    expect(extractTaskText(planPath, 1)).toContain('Sub content.');
  });

  it('stops at the next Task heading', () => {
    const planPath = makePlan(
      '## Task 1: First\n\nTask body.\n\n## Task 2: Second\n\nValidation content.\n',
    );
    expect(extractTaskText(planPath, 1)).toBe('Task body.');
    expect(extractTaskText(planPath, 1)).not.toContain('Validation content.');
  });

  it('preserves non-task headings in the body', () => {
    const planPath = makePlan(
      '## Task 1: First\n\nTask body.\n\n## Verification\n\nSome verification.\n',
    );
    expect(extractTaskText(planPath, 1)).toBe(
      'Task body.\n\n## Verification\n\nSome verification.',
    );
  });

  it('returns empty string when plan file does not exist', () => {
    expect(extractTaskText('/nonexistent/path/plan.md', 1)).toBe('');
  });

  it('returns empty string when task index is not found', () => {
    const planPath = makePlan('## Task 1: Only\n\nOnly task.\n');
    expect(extractTaskText(planPath, 99)).toBe('');
  });

  it('trims leading and trailing whitespace from the extracted body', () => {
    const planPath = makePlan('## Task 2: Padded\n\n\n  Content here.  \n\n\n## Task 3: Next\n\n');
    const result = extractTaskText(planPath, 2);
    expect(result).toBe('Content here.');
  });

  it('does not return a heading body from inside a balanced fence', () => {
    const planPath = makePlan(
      '```\n## Task 1: Inside Fence\nBody inside fence.\n```\n## Task 1: Outside Fence\nBody outside fence.',
    );
    expect(extractTaskText(planPath, 1)).toBe('Body outside fence.');
  });

  it('falls back to the first heading (even inside fence) when fences are unbalanced', () => {
    const planPath = makePlan('```\n## Task 1: Inside Fence\nBody inside fence.\n');
    expect(extractTaskText(planPath, 1)).toBe('Body inside fence.');
  });
});
