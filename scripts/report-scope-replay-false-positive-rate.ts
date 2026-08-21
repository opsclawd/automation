#!/usr/bin/env tsx

/**
 * report-scope-replay-false-positive-rate.ts — Computes and prints the aggregate
 * false-positive rate for the scope-replay corpus (packages/application/src/__fixtures__/
 * scope-replay-corpus.json), for comparison against the 75%+ false-positive baseline
 * cited in ADR-0010.
 *
 * Per-entry correctness (does each entry's label actually match what the real
 * classifyTaskChanges produces) is already asserted as a regression test in
 * packages/application/src/__tests__/scope-replay-corpus-fixture.test.ts. This
 * script does not re-verify that; it reports what the already-verified corpus's
 * label distribution says about the false-positive rate.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface FixtureEntry {
  runId: string;
  path: string | null;
  label: 'false_positive' | 'true_positive';
  taskManifestSource: 'reconstructed_from_merged_pr' | 'not_applicable_untracked' | 'unrecoverable';
}

export interface FalsePositiveRateReport {
  totalEntries: number;
  excludedUnrecoverable: number;
  classifiableEntries: number;
  falsePositiveCount: number;
  truePositiveCount: number;
  falsePositiveRatePercent: number;
  falsePositives: FixtureEntry[];
}

export function computeFalsePositiveRate(entries: FixtureEntry[]): FalsePositiveRateReport {
  const excluded = entries.filter((e) => e.taskManifestSource === 'unrecoverable');
  const classifiable = entries.filter((e) => e.taskManifestSource !== 'unrecoverable');
  const falsePositives = classifiable.filter((e) => e.label === 'false_positive');
  const truePositives = classifiable.filter((e) => e.label === 'true_positive');
  const rate = classifiable.length > 0 ? (falsePositives.length / classifiable.length) * 100 : 0;

  return {
    totalEntries: entries.length,
    excludedUnrecoverable: excluded.length,
    classifiableEntries: classifiable.length,
    falsePositiveCount: falsePositives.length,
    truePositiveCount: truePositives.length,
    falsePositiveRatePercent: rate,
    falsePositives,
  };
}

function loadEntries(): FixtureEntry[] {
  const path = join(__dirname, '../packages/application/src/__fixtures__/scope-replay-corpus.json');
  return JSON.parse(readFileSync(path, 'utf8')) as FixtureEntry[];
}

function main(): void {
  const entries = loadEntries();
  const report = computeFalsePositiveRate(entries);
  const {
    totalEntries,
    excludedUnrecoverable,
    classifiableEntries,
    falsePositiveCount,
    truePositiveCount,
    falsePositiveRatePercent,
    falsePositives,
  } = report;

  console.log('Scope-replay corpus false-positive rate');
  console.log('========================================');
  console.log(`Total corpus entries:        ${totalEntries}`);
  console.log(
    `Excluded (no manifest to classify against, taskManifestSource=unrecoverable): ${excludedUnrecoverable}`,
  );
  console.log(`Classifiable entries:         ${classifiableEntries}`);
  console.log(`  false_positive:             ${falsePositiveCount}`);
  console.log(`  true_positive:               ${truePositiveCount}`);
  console.log(`False-positive rate:          ${falsePositiveRatePercent.toFixed(2)}%`);
  console.log('');
  console.log(
    'ADR-0010 baseline: 75%+ of file-exact-classifier boundary halts were false positives.',
  );
  console.log(
    "This corpus is six illustrative runs picked for #936's issue bodies (distinct failure",
  );
  console.log(
    'shapes), not a random sample of that baseline population -- see ADR-0010 and #997/#998',
  );
  console.log('for why this number should not be read as validating or refuting the 75%+ figure.');

  if (falsePositives.length > 0) {
    console.log('');
    console.log('false_positive entries:');
    for (const e of falsePositives) {
      console.log(`  ${e.runId.slice(0, 8)}  ${e.path}`);
    }
  }
}

if (process.argv[1] && process.argv[1].endsWith('report-scope-replay-false-positive-rate.ts')) {
  main();
}
