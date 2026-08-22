export interface RevertScopeFilesInput {
  readonly cwd: string;
  readonly baseline: string;
  readonly expectedHeadSha: string;
  readonly rewriteSafety: 'unpublished';
  readonly scopeFiles: readonly string[];
}

export interface RevertScopeFilesResult {
  readonly revertedScopeFiles: string[];
  readonly removedNewlyIgnoredFiles: string[];
  readonly amendedHeadSha: string;
}

export type RevertScopeFilesPort = (
  input: RevertScopeFilesInput,
) => Promise<RevertScopeFilesResult>;
