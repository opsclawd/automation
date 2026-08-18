export type ReadWorktreeFilePort = (
  cwd: string,
  relativePath: string,
) => Promise<string | undefined>;
