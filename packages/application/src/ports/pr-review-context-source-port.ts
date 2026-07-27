export interface PrReviewContextSnapshot {
  readonly base: string;
  readonly head: string;
  readonly fullDiff: string;
  readonly diffStat: string;
  readonly changedFiles: readonly string[];
  readonly trackedFiles: readonly string[];
  readonly fileContents: Readonly<Record<string, string>>;
}

export type PrReviewContextSourcePort = (input: {
  cwd: string;
  base: string;
  head: string;
  seedPaths: readonly string[];
}) => Promise<PrReviewContextSnapshot>;
