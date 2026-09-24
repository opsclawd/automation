import type {
  CleanReviewFixtureStorePort,
  CleanReviewFixtureStoreInput,
  CleanReviewFixtureStoreResult,
} from '../ports/clean-review-fixture-store-port.js';

export interface FakeCleanReviewFixtureStore extends CleanReviewFixtureStorePort {
  calls: CleanReviewFixtureStoreInput[];
  shouldFail: boolean;
  failureError: Error;
  cleanedDirectories: string[];
  restoredFiles: string[];
  removedFiles: string[];
}

export function createFakeCleanReviewFixtureStore(): FakeCleanReviewFixtureStore {
  const calls: CleanReviewFixtureStoreInput[] = [];

  const fn = (async (
    input: CleanReviewFixtureStoreInput,
  ): Promise<CleanReviewFixtureStoreResult> => {
    calls.push(input);
    if (fn.shouldFail) {
      throw fn.failureError;
    }
    return {
      cleanedDirectories: [...fn.cleanedDirectories],
      restoredFiles: [...fn.restoredFiles],
      removedFiles: [...fn.removedFiles],
    };
  }) as FakeCleanReviewFixtureStore;

  fn.calls = calls;
  fn.shouldFail = false;
  fn.failureError = new Error('simulated review fixture-store cleanup failure');
  fn.cleanedDirectories = [];
  fn.restoredFiles = [];
  fn.removedFiles = [];

  return fn;
}
