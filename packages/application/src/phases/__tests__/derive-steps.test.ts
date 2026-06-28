import { describe, it, expect } from 'vitest';
import { deriveSteps } from '../derive-steps.js';

const m8PlanFixture = `# Plan

Intro prose.

## Task 1: Add the widget
do stuff

## Task 2: Wire it up
more stuff

## Notes
not a task
`;

const caseInsensitiveFixture = `# Plan

## task 1: lowercase title
some content

## TASK 2: uppercase title
more content

## Task 3: mixed Case title
final content
`;

const mixedHeadingLevelsFixture = `# Top-level (ignored)

## Task 1: Second-level (captured)

### Task 2: Third-level (captured)

#### Task 3: Fourth-level (ignored)

## Notes (ignored — no word boundary match)

## Taskforce (ignored — no word boundary)
`;

const bareTaskFixture = `# Plan

## Task
no title, bare heading

## Task 1: With title
content
`;

const singleTaskFixture = `# Plan

Intro prose.

## Task 1: The only task
body
`;

const whitespaceEdgeCaseFixture = `# Plan

##    Task 1: Extra whitespace after ##

## Task 2: Normal

## Task 3: Trailing space   
`;

const nonEnglishFixture = `# Plan

## Task 1: 添加组件

## Task 2: Verdrahtung

## Task 3: Utilisez cette fonction
`;

describe('deriveSteps', () => {
  it('returns empty array for empty string', () => {
    expect(deriveSteps('')).toEqual([]);
  });

  it('returns empty array for markup with no task headings', () => {
    expect(deriveSteps('# Plan\n\njust prose\n\n## Notes\nnot a task')).toEqual([]);
    expect(deriveSteps('# Plan\n\nIntro\n')).toEqual([]);
  });

  it('extracts one ordered Step per "## Task" heading (M8-04 fixture)', () => {
    const steps = deriveSteps(m8PlanFixture);
    expect(steps).toHaveLength(2);
    expect(steps.map((s) => s.index)).toEqual([1, 2]);
    expect(steps[0]).toMatchObject({ index: 1, title: 'Task 1: Add the widget' });
    expect(steps[1]!.title).toBe('Task 2: Wire it up');
  });

  it('matches case-insensitively (## task, ## TASK, ## Task)', () => {
    const steps = deriveSteps(caseInsensitiveFixture);
    expect(steps).toHaveLength(3);
    expect(steps[0]!.title).toBe('task 1: lowercase title');
    expect(steps[1]!.title).toBe('TASK 2: uppercase title');
    expect(steps[2]!.title).toBe('Task 3: mixed Case title');
  });

  it('matches second and third-level headings (ignores ####, #)', () => {
    const steps = deriveSteps(mixedHeadingLevelsFixture);
    expect(steps).toHaveLength(2);
    expect(steps[0]!.title).toBe('Task 1: Second-level (captured)');
    expect(steps[1]!.title).toBe('Task 2: Third-level (captured)');
  });

  it('requires word boundary after "Task" (excludes Taskforce, Tasks, etc.)', () => {
    const plan = '## Taskforce\nstuff\n\n## Tasks overview\nmore\n\n## Task 1: Real task';
    const steps = deriveSteps(plan);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.title).toBe('Task 1: Real task');
  });

  it('matches bare "## Task" without colon or title', () => {
    const steps = deriveSteps(bareTaskFixture);
    expect(steps).toHaveLength(2);
    expect(steps[0]!.title).toBe('Task');
    expect(steps[1]!.title).toBe('Task 1: With title');
  });

  it('returns single-element array for a single task heading', () => {
    const steps = deriveSteps(singleTaskFixture);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toEqual({ index: 1, title: 'Task 1: The only task' });
  });

  it('assigns indices as 1-based document order', () => {
    const plan = '## Task B: second\n\n## Task A: first in document';
    const steps = deriveSteps(plan);
    expect(steps.map((s) => s.index)).toEqual([1, 2]);
    expect(steps[0]!.title).toBe('Task B: second');
    expect(steps[1]!.title).toBe('Task A: first in document');
  });

  it('handles duplicate heading numbers (no deduplication)', () => {
    const plan = '## Task 1: first\n\n## Task 1: duplicate number';
    const steps = deriveSteps(plan);
    expect(steps).toHaveLength(2);
    expect(steps[0]!.index).toBe(1);
    expect(steps[1]!.index).toBe(2);
    expect(steps[0]!.title).toBe('Task 1: first');
    expect(steps[1]!.title).toBe('Task 1: duplicate number');
  });

  it('trims extra whitespace around heading text', () => {
    const steps = deriveSteps(whitespaceEdgeCaseFixture);
    expect(steps).toHaveLength(3);
    expect(steps[0]!.title).toBe('Task 1: Extra whitespace after ##');
    expect(steps[1]!.title).toBe('Task 2: Normal');
    expect(steps[2]!.title).toBe('Task 3: Trailing space');
  });

  it('handles non-English task titles', () => {
    const steps = deriveSteps(nonEnglishFixture);
    expect(steps).toHaveLength(3);
    expect(steps[0]!.title).toBe('Task 1: 添加组件');
    expect(steps[1]!.title).toBe('Task 2: Verdrahtung');
    expect(steps[2]!.title).toBe('Task 3: Utilisez cette fonction');
  });

  it('produces a DerivedStep with correct shape', () => {
    const steps = deriveSteps('## Task 1: Shape test');
    expect(steps[0]).toHaveProperty('index');
    expect(steps[0]).toHaveProperty('title');
    expect(typeof steps[0]!.index).toBe('number');
    expect(typeof steps[0]!.title).toBe('string');
  });

  it('does NOT match "## Tasks" (plural — no word boundary after Task)', () => {
    expect(deriveSteps('## Tasks\nbody')).toEqual([]);
  });
});
