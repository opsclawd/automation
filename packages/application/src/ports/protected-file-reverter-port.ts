export interface RevertProtectedFilesInput {
  readonly cwd: string;
  readonly baseline: string;
  readonly protectedFiles: readonly string[];
}

export interface RevertProtectedFilesResult {
  readonly revertedProtectedFiles: string[];
  readonly removedNewlyIgnoredFiles: string[];
  readonly amendedHeadSha: string;
}

export type RevertProtectedFilesPort = (
  input: RevertProtectedFilesInput,
) => Promise<RevertProtectedFilesResult>;
