import { describe, expect, it } from 'vitest';
import { buildArchitectPrompt } from '../architect-prompt.js';

describe('buildArchitectPrompt', () => {
  it('references the working directory', () => {
    const prompt = buildArchitectPrompt(
      { cwd: '/tmp/worktree-x', repoId: 'owner/repo' },
      { manifest: '{"tasks":[]}', reviewMd: '', triageMd: '' },
    );
    expect(prompt).toContain('/tmp/worktree-x');
    expect(prompt).toContain('## WORKSPACE CONSTRAINTS');
  });

  it('includes the manifest JSON in the prompt', () => {
    const prompt = buildArchitectPrompt(
      { cwd: '/tmp', repoId: 'r' },
      { manifest: '{"tasks":[{"id":"C1","action":"fix"}]}', reviewMd: '', triageMd: '' },
    );
    expect(prompt).toContain('"id": "C1"');
    expect(prompt).toContain('"action": "fix"');
  });

  it('declares the read-only phase constraint', () => {
    const prompt = buildArchitectPrompt(
      { cwd: '/tmp', repoId: 'r' },
      { manifest: '{}', reviewMd: '', triageMd: '' },
    );
    expect(prompt).toContain('READ-ONLY');
  });

  it('lists every action=fix task_id the fixer expects', () => {
    const prompt = buildArchitectPrompt(
      { cwd: '/tmp', repoId: 'r' },
      {
        manifest: '{"tasks":[{"id":"C1","action":"fix"},{"id":"H2","action":"defer"}]}',
        reviewMd: '',
        triageMd: '',
      },
    );
    expect(prompt).toContain('C1');
    expect(prompt).not.toContain('H2');
  });

  it('handles root-level array manifest structure', () => {
    const prompt = buildArchitectPrompt(
      { cwd: '/tmp', repoId: 'r' },
      {
        manifest: '[{"id":"C1","action":"fix"},{"id":"H2","action":"defer"}]',
        reviewMd: '',
        triageMd: '',
      },
    );
    expect(prompt).toContain('C1');
    expect(prompt).not.toContain('H2');
  });

  it('enforces the review-fix-plan.json output schema', () => {
    const prompt = buildArchitectPrompt(
      { cwd: '/tmp', repoId: 'r' },
      { manifest: '{}', reviewMd: '', triageMd: '' },
    );
    expect(prompt).toContain('review-fix-plan.json');
    expect(prompt).toContain('"version": 1');
    expect(prompt).toContain('"task_id"');
    expect(prompt).toContain('"approach"');
    expect(prompt).toContain('"conflicts_resolved"');
    expect(prompt).toContain('"constraints"');
    expect(prompt).toContain('"depends_on"');
  });

  it('ends with a STOP RULE', () => {
    const prompt = buildArchitectPrompt(
      { cwd: '/tmp', repoId: 'r' },
      { manifest: '{}', reviewMd: '', triageMd: '' },
    );
    expect(prompt).toMatch(/STOP RULE[\s\S]*$/i);
  });
});
