import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readPrompt(name: 'plan-write.md' | 'plan-write-repair.md'): string {
  return readFileSync(new URL(`../../../../prompts/plan-write/${name}`, import.meta.url), 'utf-8');
}

describe('plan-write test-first task ordering', () => {
  it('requires a separate regression-proof task before bug-fix implementation', () => {
    const prompt = readPrompt('plan-write.md');
    expect(prompt).toContain('TEST-FIRST COMMIT ORDER');
    expect(prompt).toContain('earlier numbered task');
    expect(prompt).toContain('must not include the implementation source change');
    expect(prompt).toContain('later implementation task');
  });

  it('preserves test-first task separation during plan repair', () => {
    const repairPrompt = readPrompt('plan-write-repair.md');
    expect(repairPrompt).toContain('TEST-FIRST COMMIT ORDER');
    expect(repairPrompt).toContain(
      'Do not merge a regression-proof task into its implementation task',
    );
  });
});
