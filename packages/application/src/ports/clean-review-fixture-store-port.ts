export const REVIEW_FIXTURE_STORE_DIRNAME = '.review-fixture-store';

/**
 * Returns whether a normalized repository path belongs to target-repository
 * review fixture state, which is ambient test noise rather than a validation
 * fix candidate or committed source.
 */
export function isReviewFixtureStorePath(path: string): boolean {
  return /(^|\/)\.review-fixture-store(?:\/|$)/.test(path);
}

export interface CleanReviewFixtureStoreInput {
  readonly cwd: string;
  readonly targetDirectories?: readonly string[] | undefined;
}

export interface CleanReviewFixtureStoreResult {
  readonly cleanedDirectories: string[];
  readonly restoredFiles: string[];
  readonly removedFiles: string[];
}

export type CleanReviewFixtureStorePort = (
  input: CleanReviewFixtureStoreInput,
) => Promise<CleanReviewFixtureStoreResult>;

export type ReviewFixtureStoreCleanupInput = CleanReviewFixtureStoreInput;
export type ReviewFixtureStoreCleanupResult = CleanReviewFixtureStoreResult;
export type ReviewFixtureStoreCleanupPort = CleanReviewFixtureStorePort;
