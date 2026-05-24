import { describe, it, expect } from 'vitest';
import { renderPrompt } from '../prompts/render-prompt.js';
import type { ArtifactStore } from '../ports/artifact-store.js';

const fakeArtifacts = (map: Record<string, string>): ArtifactStore => ({
  async read(path) {
    if (!(path in map)) throw new Error('not found');
    return map[path];
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
      vars: { name: 'world', n: '42' },
      artifacts: fakeArtifacts({}),
    });
    expect(out).toBe('hello world, the answer is 42');
  });

  it('substitutes artifacts by path', async () => {
    const out = await renderPrompt('plan:\n{{artifact:plan.md}}', {
      vars: {},
      artifacts: fakeArtifacts({ 'plan.md': 'PLAN BODY' }),
    });
    expect(out).toBe('plan:\nPLAN BODY');
  });

  it('throws TemplateError on unknown var', async () => {
    await expect(
      renderPrompt('{{var:missing}}', { vars: {}, artifacts: fakeArtifacts({}) }),
    ).rejects.toThrow('unknown var');
  });

  it('throws TemplateNotFoundError on missing artifact', async () => {
    await expect(
      renderPrompt('{{artifact:nope.md}}', { vars: {}, artifacts: fakeArtifacts({}) }),
    ).rejects.toThrow('missing artifact');
  });
});
