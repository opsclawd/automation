import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFilesystemArtifactStore } from '@ai-sdlc/infrastructure';
import { buildImplementStepFixPrompt } from '../compose.js';
import {
  QUALITY_REVIEW_RESULT_ARTIFACT,
  SPEC_REVIEW_RESULT_ARTIFACT,
} from '../arbiter-excerpts.js';

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function makeStore() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'impl-fix-prompt-'));
  tempDirs.push(root);
  const durableRoot = path.join(root, 'phase-artifacts');
  const worktreeRoot = path.join(root, 'worktree');
  mkdirSync(durableRoot, { recursive: true });
  mkdirSync(worktreeRoot, { recursive: true });
  return createFilesystemArtifactStore({ durableRoot, worktreeRoot });
}

const ctx = {
  stepIndex: 5,
  stepTitle: 'Refactor foo',
  cwd: '/worktrees/issue-664',
};

describe('buildImplementStepFixPrompt', () => {
  it('produces a buildable prompt when both archives are missing', async () => {
    const artifacts = makeStore();
    const prompt = await buildImplementStepFixPrompt(artifacts, 'run-1', ctx);
    expect(prompt).toContain('## WHAT THE REVIEWERS FOUND (verbatim)');
    expect(prompt).toContain('"findings": []');
    expect(prompt).toContain('Apply the suggested fixes when you can.');
  });

  it('inlines spec findings verbatim when only the spec archive is present', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'impl-fix-prompt-'));
    tempDirs.push(root);
    const durableRoot = path.join(root, 'phase-artifacts');
    mkdirSync(durableRoot, { recursive: true });
    writeFileSync(
      path.join(durableRoot, SPEC_REVIEW_RESULT_ARTIFACT),
      JSON.stringify({
        result: 'fail',
        findings: [{ severity: 'P0', summary: 'Spec violation in foo()', file: 'src/foo.ts' }],
      }),
    );
    const artifacts = createFilesystemArtifactStore({ durableRoot, worktreeRoot: root });
    const prompt = await buildImplementStepFixPrompt(artifacts, 'run-1', ctx);
    expect(prompt).toContain('Spec violation in foo()');
    expect(prompt).toContain('src/foo.ts');
  });

  it('inlines both spec and quality findings when both archives are present', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'impl-fix-prompt-'));
    tempDirs.push(root);
    const durableRoot = path.join(root, 'phase-artifacts');
    mkdirSync(durableRoot, { recursive: true });
    writeFileSync(
      path.join(durableRoot, SPEC_REVIEW_RESULT_ARTIFACT),
      JSON.stringify({
        result: 'fail',
        findings: [{ severity: 'P1', summary: 'Spec defect', file: 'src/a.ts' }],
      }),
    );
    writeFileSync(
      path.join(durableRoot, QUALITY_REVIEW_RESULT_ARTIFACT),
      JSON.stringify({
        result: 'fail',
        findings: [{ severity: 'P2', summary: 'Quality defect', file: 'src/b.ts' }],
      }),
    );
    const artifacts = createFilesystemArtifactStore({ durableRoot, worktreeRoot: root });
    const prompt = await buildImplementStepFixPrompt(artifacts, 'run-1', ctx);
    expect(prompt).toContain('Spec defect');
    expect(prompt).toContain('Quality defect');
  });

  it('degrades to empty findings on malformed archive JSON', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'impl-fix-prompt-'));
    tempDirs.push(root);
    const durableRoot = path.join(root, 'phase-artifacts');
    mkdirSync(durableRoot, { recursive: true });
    writeFileSync(path.join(durableRoot, SPEC_REVIEW_RESULT_ARTIFACT), '{ not valid json');
    const artifacts = createFilesystemArtifactStore({ durableRoot, worktreeRoot: root });
    const prompt = await buildImplementStepFixPrompt(artifacts, 'run-1', ctx);
    expect(prompt).toContain('"findings": []');
    expect(prompt).toContain('Apply the suggested fixes when you can.');
  });

  it('filters out non-object entries in the findings array', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'impl-fix-prompt-'));
    tempDirs.push(root);
    const durableRoot = path.join(root, 'phase-artifacts');
    mkdirSync(durableRoot, { recursive: true });
    writeFileSync(
      path.join(durableRoot, SPEC_REVIEW_RESULT_ARTIFACT),
      JSON.stringify({
        result: 'fail',
        findings: [
          null,
          'string-not-object',
          { severity: 'P0', summary: 'Kept' },
          { severity: 42, summary: 'wrong severity type' },
          { severity: 'P2' },
        ],
      }),
    );
    const artifacts = createFilesystemArtifactStore({ durableRoot, worktreeRoot: root });
    const prompt = await buildImplementStepFixPrompt(artifacts, 'run-1', ctx);
    expect(prompt).toContain('Kept');
    expect(prompt).not.toContain('wrong severity type');
  });

  it('successfully parses findings exceeding 4000 characters', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'impl-fix-prompt-'));
    tempDirs.push(root);
    const durableRoot = path.join(root, 'phase-artifacts');
    mkdirSync(durableRoot, { recursive: true });

    const largeFindings = Array.from({ length: 100 }).map((_, i) => ({
      severity: 'P1',
      summary: `This is a very long summary meant to pad the JSON out so it exceeds four thousand characters. Finding number ${i}`,
    }));

    const payload = JSON.stringify({
      result: 'fail',
      findings: largeFindings,
    });
    // Ensure payload exceeds 4000 characters
    expect(payload.length).toBeGreaterThan(4000);

    writeFileSync(path.join(durableRoot, SPEC_REVIEW_RESULT_ARTIFACT), payload);
    const artifacts = createFilesystemArtifactStore({ durableRoot, worktreeRoot: root });
    const prompt = await buildImplementStepFixPrompt(artifacts, 'run-1', ctx);

    // We should find the findings array in the prompt and not degraded to []
    expect(prompt).toContain('Finding number 0');
    expect(prompt).toContain('Finding number 99');
  });
});
