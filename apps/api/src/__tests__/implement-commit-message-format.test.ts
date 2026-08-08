import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildImplementPrompt } from '../compose.js';

const template = readFileSync(
  new URL('../../../../prompts/implement/task.md', import.meta.url),
  'utf-8',
);

describe('implement commit message formatting', () => {
  it('implement commit instructions use a quoted stdin message with real line breaks', () => {
    const generated = buildImplementPrompt(
      { stepIndex: 1, stepTitle: 'Prove formatting', cwd: '/worktree', repoId: 'org/repo' },
      'Write the regression proof.',
      'ai/issue-871',
    );

    for (const instructions of [generated, template]) {
      expect(instructions).toContain("\ngit commit -F - <<'COMMIT_MESSAGE'\n");
      expect(instructions).toContain('\nCOMMIT_MESSAGE\n');
      expect(instructions).toContain(
        "\ngit commit -F - <<'COMMIT_MESSAGE'\ntype: concise subject\n\nOptional body with list items:\n- first detail\n- second detail\nCOMMIT_MESSAGE\n",
      );
      expect(instructions).toContain('Do not encode line breaks as literal `\\n`');
    }

    expect(generated).not.toContain("git commit -m '<descriptive commit message>'");
  });
});
