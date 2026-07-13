import { describe, it, expect } from 'vitest';
import { FakeArtifactStore } from '../../test-doubles/fake-artifact-store.js';
import { appendRebuttalToCodeReview } from '../append-rebuttal.js';

describe('appendRebuttalToCodeReview', () => {
  it('appends a rebuttal section when code-review.md does not exist yet', async () => {
    const store = new FakeArtifactStore();
    const result = await appendRebuttalToCodeReview(store, {
      runId: 'run-1',
      phaseId: 'review-fix',
      iterationIndex: 3,
      rebuttal: 'The reviewer cited execAsync, but the file uses execa.',
      unfoundedFindings: [
        {
          severity: 'critical',
          summary: 'command injection in fix-diff-inspector.ts',
          evidence: {
            path: 'fix-diff-inspector.ts',
            line: 42,
            snippet: 'execAsync(args.join(" "))',
          },
        },
      ],
    });
    expect(result.written).toBe(true);
    const written = await store.read('run-1', 'code-review.md');
    expect(written).toContain('## Accepted Rebuttal (iteration 3)');
    expect(written).toContain('The reviewer cited execAsync');
    expect(written).toContain('**[critical]** command injection in fix-diff-inspector.ts');
    expect(written).toContain('fix-diff-inspector.ts:42');
  });

  it('appends without clobbering existing content', async () => {
    const store = new FakeArtifactStore();
    await store.write({
      runId: 'run-1',
      relativePath: 'code-review.md',
      contents: '# Code Review\n\n## Findings\n\n- finding 1',
    });
    const result = await appendRebuttalToCodeReview(store, {
      runId: 'run-1',
      phaseId: 'review-fix',
      iterationIndex: 2,
      rebuttal: 'finding 1 is fabricated',
      unfoundedFindings: [{ severity: 'high', summary: 'finding 1', evidence: { path: 'a.ts' } }],
    });
    expect(result.written).toBe(true);
    const written = await store.read('run-1', 'code-review.md');
    expect(written).toContain('# Code Review');
    expect(written).toContain('## Findings');
    expect(written).toContain('- finding 1');
    expect(written).toContain('## Accepted Rebuttal (iteration 2)');
    expect(written).toContain('finding 1 is fabricated');
  });

  it('returns written: false with a reason when write fails', async () => {
    const store = new FakeArtifactStore();
    const origWrite = store.write.bind(store);
    store.write = async () => {
      throw new Error('disk full');
    };
    const result = await appendRebuttalToCodeReview(store, {
      runId: 'run-1',
      phaseId: 'review-fix',
      iterationIndex: 1,
      rebuttal: 'x',
      unfoundedFindings: [],
    });
    expect(result.written).toBe(false);
    expect(result.reason).toContain('disk full');
    // Restore so teardown doesn't fail
    store.write = origWrite;
  });

  it('renders the unfounded-findings list with one bullet per finding', async () => {
    const store = new FakeArtifactStore();
    await appendRebuttalToCodeReview(store, {
      runId: 'run-1',
      phaseId: 'review-fix',
      iterationIndex: 4,
      rebuttal: 'all three are fabricated',
      unfoundedFindings: [
        { severity: 'critical', summary: 'a', evidence: { path: 'p/a.ts', line: 1 } },
        { severity: 'high', summary: 'b', evidence: { path: 'p/b.ts' } },
        { severity: 'medium', summary: 'c' },
      ],
    });
    const written = await store.read('run-1', 'code-review.md');
    expect(written).toContain('- **[critical]** a — evidence: `p/a.ts:1`');
    expect(written).toContain('- **[high]** b — evidence: `p/b.ts`');
    expect(written).toContain('- **[medium]** c — evidence: `(no evidence extracted)`');
  });
});
