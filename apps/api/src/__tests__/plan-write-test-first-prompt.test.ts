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
    expect(prompt).toContain('prefix the validation command with `! `');
    expect(prompt).toContain(
      'For additive feature work, unit tests MUST be delivered in the same task as their corresponding implementation code',
    );
    expect(prompt).toContain('DEFERRED SIGNATURE CHANGES IN RED TASKS');
    expect(prompt).toContain('explicitly-typed local variable or interface');
    // Both compiler-trap directions must be covered, not just excess-property-on-literal:
    // reading a not-yet-existent field off the actual value is a different error
    // (Property does not exist) from constructing an expected literal with extra fields
    // (excess-property check), and needs a different fix (cast the actual value).
    expect(prompt).toContain('Property does not exist');
    expect(prompt).toContain('cast the value through');
  });

  it('preserves test-first task separation during plan repair', () => {
    const repairPrompt = readPrompt('plan-write-repair.md');
    expect(repairPrompt).toContain('TEST-FIRST COMMIT ORDER');
    expect(repairPrompt).toContain(
      'Do not merge a regression-proof task into its implementation task',
    );
    expect(repairPrompt).toContain(
      'For additive feature work,\n  preserve unit tests co-located within the same task as their implementation code',
    );
    expect(repairPrompt).toContain('DEFERRED SIGNATURE CHANGES IN RED TASKS');
    expect(repairPrompt).toContain('explicitly-typed local variable or interface');
    expect(repairPrompt).toContain('Property does not exist');
    expect(repairPrompt).toContain('cast the value through');
  });
});
