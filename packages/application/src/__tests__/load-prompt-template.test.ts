import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPromptTemplate, TemplateNotFoundError } from '../prompts/index.js';

describe('loadPromptTemplate', () => {
  it('reads prompts/<phase>/<step>.md', () => {
    const root = mkdtempSync(join(tmpdir(), 'prompts-'));
    mkdirSync(join(root, 'plan-design'), { recursive: true });
    writeFileSync(join(root, 'plan-design', 'plan-design.md'), 'TEMPLATE');
    expect(loadPromptTemplate('plan-design', 'plan-design', { promptsRoot: root })).toBe(
      'TEMPLATE',
    );
  });

  it('throws TemplateNotFoundError if missing', () => {
    expect(() => loadPromptTemplate('x', 'y', { promptsRoot: '/nonexistent' })).toThrow(
      TemplateNotFoundError,
    );
  });

  it('includes file path in error message', () => {
    try {
      loadPromptTemplate('x', 'y', { promptsRoot: '/nonexistent' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TemplateNotFoundError);
      expect((err as TemplateNotFoundError).message).toContain('/nonexistent/x/y.md');
    }
  });

  it('throws TypeError for path traversal in phase', () => {
    expect(() => loadPromptTemplate('../etc', 'step', { promptsRoot: '/tmp' })).toThrow(TypeError);
  });

  it('throws TypeError for path traversal in step', () => {
    expect(() => loadPromptTemplate('phase', 'a/b', { promptsRoot: '/tmp' })).toThrow(TypeError);
  });
});
