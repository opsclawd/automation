import { describe, expect, it } from 'vitest';
import { renderDeclaredFilesRetryPrompt } from '../implement-retry-scope.js';

describe('renderDeclaredFilesRetryPrompt recovery guidance', () => {
  it('tells a retry to preserve and commit existing uncommitted declared-file work', () => {
    const prompt = renderDeclaredFilesRetryPrompt(['src/collector.ts', 'src/parser.ts']).join('\n');

    expect(prompt).toContain('uncommitted work is still in your working tree');
    expect(prompt).toContain('git status');
    expect(prompt).toContain('review and stage');
    expect(prompt).toContain('do not reimplement it');
    expect(prompt).toContain('- src/collector.ts');
    expect(prompt).toContain('- src/parser.ts');
    expect(prompt.match(/- src\/collector\.ts/g)).toHaveLength(1);
    expect(prompt.match(/- src\/parser\.ts/g)).toHaveLength(1);
    expect(prompt.indexOf('- src/collector.ts')).toBeLessThan(prompt.indexOf('- src/parser.ts'));
    expect(prompt).toContain('commit');
  });

  it('tells a retry to implement a declared file when the work is absent', () => {
    const prompt = renderDeclaredFilesRetryPrompt(['src/new-parser.ts']).join('\n');

    expect(prompt).toContain('If a listed file is absent');
    expect(prompt).toContain('implement the required behavior');
    expect(prompt).toContain('validate and commit');
  });

  it('omits retry recovery guidance without missed declared files', () => {
    expect(renderDeclaredFilesRetryPrompt()).toEqual([]);
    expect(renderDeclaredFilesRetryPrompt([])).toEqual([]);
  });
});
