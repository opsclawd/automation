import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFilesystemArtifactStore } from '@ai-sdlc/infrastructure';
import {
  FIX_RESULT_ARTIFACT,
  QUALITY_REVIEW_RESULT_ARTIFACT,
  SPEC_REVIEW_RESULT_ARTIFACT,
  readArbiterExcerpts,
  readImplementStepFinalReviewExcerpts,
} from '../arbiter-excerpts.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function makeStore() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'arbiter-excerpts-'));
  tempDirs.push(root);
  const durableRoot = path.join(root, 'phase-artifacts');
  const worktreeRoot = path.join(root, 'worktree');
  mkdirSync(durableRoot, { recursive: true });
  mkdirSync(worktreeRoot, { recursive: true });
  return { store: createFilesystemArtifactStore({ durableRoot, worktreeRoot }), durableRoot };
}

describe('readArbiterExcerpts', () => {
  it('reads spec-review, quality-review and fix results from distinct phase-segregated paths', async () => {
    const { store, durableRoot } = makeStore();
    writeFileSync(
      path.join(durableRoot, SPEC_REVIEW_RESULT_ARTIFACT),
      '{"result":"fail","finding":"artifact overwrite"}',
    );
    writeFileSync(
      path.join(durableRoot, QUALITY_REVIEW_RESULT_ARTIFACT),
      '{"result":"fail","finding":"style issue"}',
    );
    writeFileSync(
      path.join(durableRoot, FIX_RESULT_ARTIFACT),
      '{"result":"done_no_fixes_needed","rebuttal":"no findings found"}',
    );
    // A stale shared result.json must not leak into either excerpt
    writeFileSync(path.join(durableRoot, 'result.json'), '{"result":"pass"}');

    const { specExcerpt, qualityExcerpt, fixExcerpt } = await readArbiterExcerpts(store, 'run-1');

    expect(specExcerpt).toBe('{"result":"fail","finding":"artifact overwrite"}');
    expect(qualityExcerpt).toBe('{"result":"fail","finding":"style issue"}');
    expect(fixExcerpt).toBe('{"result":"done_no_fixes_needed","rebuttal":"no findings found"}');
    expect(specExcerpt).not.toBe(qualityExcerpt);
    expect(specExcerpt).not.toBe(fixExcerpt);
    expect(qualityExcerpt).not.toBe(fixExcerpt);
  });

  it('returns empty excerpts when the artifacts are missing', async () => {
    const { store } = makeStore();
    const { specExcerpt, qualityExcerpt, fixExcerpt } = await readArbiterExcerpts(store, 'run-1');
    expect(specExcerpt).toBe('');
    expect(qualityExcerpt).toBe('');
    expect(fixExcerpt).toBe('');
  });

  it('round-trips a finding-bearing spec-review result.json through readArbiterExcerpts', async () => {
    const { store, durableRoot } = makeStore();
    const findingJson = JSON.stringify({
      result: 'fail',
      findings: [
        {
          severity: 'P0',
          summary: 'Wrong schema for readFixVerdict',
          file: 'src/foo.ts',
          suggested_fix: 'Use the new spec-review schema',
        },
      ],
    });
    writeFileSync(path.join(durableRoot, SPEC_REVIEW_RESULT_ARTIFACT), findingJson);

    const { specExcerpt } = await readArbiterExcerpts(store, 'run-1');

    expect(specExcerpt).toBe(findingJson);
    expect(specExcerpt).toContain('Wrong schema for readFixVerdict');
    expect(specExcerpt).toContain('src/foo.ts');
  });

  it('truncates each excerpt to 4000 characters', async () => {
    const { store, durableRoot } = makeStore();
    writeFileSync(path.join(durableRoot, SPEC_REVIEW_RESULT_ARTIFACT), 'a'.repeat(5000));
    writeFileSync(path.join(durableRoot, QUALITY_REVIEW_RESULT_ARTIFACT), 'c'.repeat(5000));
    writeFileSync(path.join(durableRoot, FIX_RESULT_ARTIFACT), 'b'.repeat(5000));

    const { specExcerpt, qualityExcerpt, fixExcerpt } = await readArbiterExcerpts(store, 'run-1');

    expect(specExcerpt).toBe('a'.repeat(4000));
    expect(qualityExcerpt).toBe('c'.repeat(4000));
    expect(fixExcerpt).toBe('b'.repeat(4000));
  });
});

describe('readImplementStepFinalReviewExcerpts', () => {
  it('reads spec-review and quality-review results, omitting fix', async () => {
    const { store, durableRoot } = makeStore();
    writeFileSync(
      path.join(durableRoot, SPEC_REVIEW_RESULT_ARTIFACT),
      '{"result":"fail","finding":"trailing spec finding"}',
    );
    writeFileSync(
      path.join(durableRoot, QUALITY_REVIEW_RESULT_ARTIFACT),
      '{"result":"fail","finding":"trailing quality finding"}',
    );
    writeFileSync(
      path.join(durableRoot, FIX_RESULT_ARTIFACT),
      '{"result":"done_no_fixes_needed","rebuttal":"should not be read"}',
    );

    const result = await readImplementStepFinalReviewExcerpts(store, 'run-1');

    expect(result.specExcerpt).toBe('{"result":"fail","finding":"trailing spec finding"}');
    expect(result.qualityExcerpt).toBe('{"result":"fail","finding":"trailing quality finding"}');
    expect('fixExcerpt' in result).toBe(false);
  });

  it('returns empty excerpts when the artifacts are missing', async () => {
    const { store } = makeStore();
    const result = await readImplementStepFinalReviewExcerpts(store, 'run-1');
    expect(result.specExcerpt).toBe('');
    expect(result.qualityExcerpt).toBe('');
  });

  it('truncates each excerpt to 4000 characters', async () => {
    const { store, durableRoot } = makeStore();
    writeFileSync(path.join(durableRoot, SPEC_REVIEW_RESULT_ARTIFACT), 'a'.repeat(5000));
    writeFileSync(path.join(durableRoot, QUALITY_REVIEW_RESULT_ARTIFACT), 'b'.repeat(5000));

    const result = await readImplementStepFinalReviewExcerpts(store, 'run-1');

    expect(result.specExcerpt).toBe('a'.repeat(4000));
    expect(result.qualityExcerpt).toBe('b'.repeat(4000));
  });
});
