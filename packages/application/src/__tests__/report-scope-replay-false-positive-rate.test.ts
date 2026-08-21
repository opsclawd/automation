import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  computeFalsePositiveRate,
  type FixtureEntry,
} from '../../../../scripts/report-scope-replay-false-positive-rate.js';

function loadFixture(): FixtureEntry[] {
  const path = join(__dirname, '../__fixtures__/scope-replay-corpus.json');
  return JSON.parse(readFileSync(path, 'utf8')) as FixtureEntry[];
}

describe('computeFalsePositiveRate', () => {
  it('excludes unrecoverable entries from the classifiable count', () => {
    const entries: FixtureEntry[] = [
      {
        runId: 'a',
        path: 'x',
        label: 'true_positive',
        taskManifestSource: 'reconstructed_from_merged_pr',
      },
      { runId: 'b', path: null, label: 'true_positive', taskManifestSource: 'unrecoverable' },
    ];
    const report = computeFalsePositiveRate(entries);
    expect(report.totalEntries).toBe(2);
    expect(report.excludedUnrecoverable).toBe(1);
    expect(report.classifiableEntries).toBe(1);
  });

  it('computes the rate as false_positive / classifiable', () => {
    const entries: FixtureEntry[] = [
      {
        runId: 'a',
        path: 'x',
        label: 'false_positive',
        taskManifestSource: 'reconstructed_from_merged_pr',
      },
      {
        runId: 'b',
        path: 'y',
        label: 'true_positive',
        taskManifestSource: 'reconstructed_from_merged_pr',
      },
      {
        runId: 'c',
        path: 'z',
        label: 'true_positive',
        taskManifestSource: 'not_applicable_untracked',
      },
      { runId: 'd', path: null, label: 'true_positive', taskManifestSource: 'unrecoverable' },
    ];
    const report = computeFalsePositiveRate(entries);
    expect(report.classifiableEntries).toBe(3);
    expect(report.falsePositiveCount).toBe(1);
    expect(report.truePositiveCount).toBe(2);
    expect(report.falsePositiveRatePercent).toBeCloseTo((1 / 3) * 100, 5);
  });

  it('does not divide by zero when every entry is unrecoverable', () => {
    const entries: FixtureEntry[] = [
      { runId: 'a', path: null, label: 'true_positive', taskManifestSource: 'unrecoverable' },
    ];
    const report = computeFalsePositiveRate(entries);
    expect(report.classifiableEntries).toBe(0);
    expect(report.falsePositiveRatePercent).toBe(0);
  });

  it('reports the real scope-replay-corpus.json rate for regression tracking', () => {
    // Not a correctness assertion about the classifier (that's covered by
    // scope-replay-corpus-fixture.test.ts) -- this pins the current corpus's
    // measured rate so a silent change to the fixture doesn't drift the
    // number recorded against ADR-0010's 75%+ baseline without review.
    const report = computeFalsePositiveRate(loadFixture());
    expect(report.totalEntries).toBe(49);
    expect(report.excludedUnrecoverable).toBe(6);
    expect(report.classifiableEntries).toBe(43);
    expect(report.falsePositiveCount).toBe(2);
    expect(report.falsePositiveRatePercent).toBeCloseTo((2 / 43) * 100, 5);
  });
});
