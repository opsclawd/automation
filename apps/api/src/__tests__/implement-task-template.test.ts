import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const prompt = readFileSync(
  new URL('../../../../prompts/implement/task.md', import.meta.url),
  'utf-8',
);

describe('implement task template commit contract', () => {
  it('implement task template makes commit coverage the gate before artifact writes', () => {
    const commitHeading = '## MANDATORY COMMIT (Step N+1)';
    const logHeading = '## FINAL ACTION (Step N+2)';
    const resultHeading = '## MANDATORY RESULT FILE (Step N+3)';

    expect(prompt).toContain(commitHeading);
    expect(prompt).toContain('Skipping this step fails the orchestrator');
    expect(prompt).toContain('commit coverage');
    expect(prompt.indexOf(commitHeading)).toBeLessThan(prompt.indexOf(logHeading));
    expect(prompt.indexOf(logHeading)).toBeLessThan(prompt.indexOf(resultHeading));
  });
});
