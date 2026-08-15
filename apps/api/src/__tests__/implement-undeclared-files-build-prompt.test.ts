import { describe, expect, it } from 'vitest';
import { renderDeclaredFilesRetryPrompt } from '../implement-retry-scope.js';
import { buildImplementPrompt } from '../compose.js';

describe('renderDeclaredFilesRetryPrompt undeclared files guidance', () => {
  it('renders distinct safe recovery guidance for both undeclared categories', () => {
    const prompt = renderDeclaredFilesRetryPrompt(
      undefined,
      ['src/unrelated-b.ts', 'src/unrelated-a.ts', 'src/unrelated-b.ts'],
      ['src/ref-2.ts', 'src/ref-1.ts', 'src/ref-2.ts'],
    ).join('\n');

    // Separate headings
    expect(prompt).toContain(
      '## MODIFIED READ-ONLY REFERENCE FILES — REMOVE FROM THIS TASK COMMIT',
    );
    expect(prompt).toContain('## COMMITTED FILES OUTSIDE THIS TASK — REMOVE FROM THIS TASK COMMIT');

    // Sorted, deduplicated path bullets
    expect(prompt).toContain('- src/ref-1.ts');
    expect(prompt).toContain('- src/ref-2.ts');
    expect(prompt.match(/- src\/ref-1\.ts/g)).toHaveLength(1);
    expect(prompt.match(/- src\/ref-2\.ts/g)).toHaveLength(1);
    expect(prompt.indexOf('- src/ref-1.ts')).toBeLessThan(prompt.indexOf('- src/ref-2.ts'));

    expect(prompt).toContain('- src/unrelated-a.ts');
    expect(prompt).toContain('- src/unrelated-b.ts');
    expect(prompt.match(/- src\/unrelated-a\.ts/g)).toHaveLength(1);
    expect(prompt.match(/- src\/unrelated-b\.ts/g)).toHaveLength(1);
    expect(prompt.indexOf('- src/unrelated-a.ts')).toBeLessThan(
      prompt.indexOf('- src/unrelated-b.ts'),
    );

    // Safe recovery commands & guidance
    expect(prompt).toContain('git reset HEAD~1 --soft');
    expect(prompt).toContain('git restore --source=HEAD --staged --worktree -- <path>');
    expect(prompt).toContain('expected_files');
    expect(prompt).toContain('git log');

    // Manifest prohibition
    expect(prompt).toContain('The manifest cannot be broadened');
    expect(prompt).toContain('later-task work is not authorized');
  });

  it('omits undeclared recovery guidance when both lists are empty', () => {
    expect(renderDeclaredFilesRetryPrompt(undefined, [], [])).toEqual([]);
    expect(renderDeclaredFilesRetryPrompt(undefined, undefined, undefined)).toEqual([]);

    const fullPrompt = buildImplementPrompt(
      { stepIndex: 1, stepTitle: 'Task 1: do work', cwd: '/tmp/wt', repoId: 'acme/widgets' },
      '## Task context',
      'ai/issue-890',
    );

    expect(fullPrompt).not.toContain('## MODIFIED READ-ONLY REFERENCE FILES');
    expect(fullPrompt).not.toContain('## COMMITTED FILES OUTSIDE THIS TASK');
    expect(fullPrompt).not.toContain('## DECLARED FILES MISSED BY THE PREVIOUS ATTEMPT');
  });
});
