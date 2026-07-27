import type {
  PrReviewContextSnapshot,
  PrReviewContextSourcePort,
} from '../ports/pr-review-context-source-port.js';

export function createFakePrReviewContextSource(
  overrides?: Partial<PrReviewContextSnapshot>,
): PrReviewContextSourcePort {
  return async function fakePrReviewContextSource(input: {
    cwd: string;
    base: string;
    head: string;
    seedPaths: readonly string[];
  }): Promise<PrReviewContextSnapshot> {
    const defaultSnapshot: PrReviewContextSnapshot = {
      base: input.base,
      head: input.head,
      fullDiff: `fake diff for ${input.base}..${input.head}`,
      diffStat: `1 file changed`,
      changedFiles: Object.freeze(['fake-file.txt']),
      trackedFiles: Object.freeze(['README.md']),
      fileContents: Object.freeze({ 'fake-file.txt': 'fake content\n' }),
    };

    return Object.freeze({
      ...defaultSnapshot,
      ...overrides,
    });
  };
}
