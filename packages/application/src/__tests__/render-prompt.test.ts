import { describe, it, expect } from 'vitest';
import { renderPrompt } from '../prompts/render-prompt.js';
import { TemplateError } from '../prompts/errors.js';
import { WORKSPACE_CONSTRAINTS } from '../prompts/constants.js';
import { ArtifactNotFoundError } from '../ports/artifact-store.js';
import type { ArtifactStore } from '../ports/artifact-store.js';

const fakeArtifacts = (map: Record<string, string>): ArtifactStore => ({
  async read(_runId: string, relativePath: string) {
    if (!(relativePath in map)) throw new ArtifactNotFoundError(_runId, relativePath);
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

  it('substitutes WORKSPACE_CONSTRAINTS automatically', async () => {
    const out = await renderPrompt('constraints:\n{{var:WORKSPACE_CONSTRAINTS}}', {
      runId: 'run-1',
      vars: {},
      artifacts: fakeArtifacts({}),
    });
    expect(out).toBe(`constraints:\n${WORKSPACE_CONSTRAINTS}`);
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

  it('resolves optional artifact placeholder to content when present', async () => {
    const out = await renderPrompt('findings:\n{{artifact?:findings.md}}', {
      runId: 'run-1',
      vars: {},
      artifacts: fakeArtifacts({ 'findings.md': 'FINDINGS BODY' }),
    });
    expect(out).toBe('findings:\nFINDINGS BODY');
  });

  it('resolves optional artifact placeholder to empty string instead of throwing when missing', async () => {
    const out = await renderPrompt('findings:\n{{artifact?:findings.md}}end', {
      runId: 'run-1',
      vars: {},
      artifacts: fakeArtifacts({}),
    });
    expect(out).toBe('findings:\nend');
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
      expect((err as TemplateError).cause).toBeInstanceOf(ArtifactNotFoundError);
    }
  });

  it('recognizes cross-package ArtifactNotFoundError by name', async () => {
    const crossPackageStore: ArtifactStore = {
      async read() {
        const err = new Error('artifact not found: x.md in run run-1');
        err.name = 'ArtifactNotFoundError';
        throw err;
      },
      async write() {
        throw new Error('not in scope');
      },
      async list() {
        return [];
      },
    };
    try {
      await renderPrompt('{{artifact:x.md}}', {
        runId: 'run-1',
        vars: {},
        artifacts: crossPackageStore,
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TemplateError);
      expect((err as TemplateError).placeholder).toBe('x.md');
    }
  });

  it('re-throws non-ArtifactNotFoundError from artifacts.read', async () => {
    const brokenStore: ArtifactStore = {
      async read() {
        throw new Error('permission denied');
      },
      async write() {
        throw new Error('not in scope');
      },
      async list() {
        return [];
      },
    };
    try {
      await renderPrompt('{{artifact:x.md}}', {
        runId: 'run-1',
        vars: {},
        artifacts: brokenStore,
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).not.toBeInstanceOf(TemplateError);
      expect((err as Error).message).toBe('permission denied');
    }
  });
});
