import { describe, it, expect } from 'vitest';
import { renderPrompt } from '../prompts/render-prompt.js';
import { TemplateError } from '../prompts/errors.js';
import type { ArtifactStore } from '../ports/artifact-store.js';

const fakeArtifacts = (map: Record<string, string>): ArtifactStore => ({
  async read(_runId: string, relativePath: string) {
    if (!(relativePath in map)) throw new Error('not found');
    return map[relativePath];
  },
  async write() {
    throw new Error('not in scope');
  },
  async list() {
    return [];
  },
});

describe('renderPrompt', () => {
  it('substitutes vars', async () => {
    const out = await renderPrompt('hello {{var:name}}, the answer is {{var:n}}', {
      runId: 'run-1',
      vars: { name: 'world', n: '42' },
      artifacts: fakeArtifacts({}),
    });
    expect(out).toBe('hello world, the answer is 42');
  });

  it('substitutes artifacts by path', async () => {
    const out = await renderPrompt('plan:\n{{artifact:plan.md}}', {
      runId: 'run-1',
      vars: {},
      artifacts: fakeArtifacts({ 'plan.md': 'PLAN BODY' }),
    });
    expect(out).toBe('plan:\nPLAN BODY');
  });

  it('throws TemplateError on unknown var', async () => {
    try {
      await renderPrompt('{{var:missing}}', {
        runId: 'run-1',
        vars: {},
        artifacts: fakeArtifacts({}),
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TemplateError);
      expect((err as TemplateError).placeholder).toBe('missing');
      expect((err as TemplateError).message).toMatch(/missing/);
    }
  });

  it('throws TemplateError on missing artifact', async () => {
    try {
      await renderPrompt('{{artifact:nope.md}}', {
        runId: 'run-1',
        vars: {},
        artifacts: fakeArtifacts({}),
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TemplateError);
      expect((err as TemplateError).placeholder).toBe('nope.md');
      expect((err as TemplateError).message).toMatch(/nope\.md/);
      expect(err as TemplateError).toHaveProperty('cause');
    }
  });
});
