export interface WriteArtifactInput {
  runId: string;
  phaseId?: string;
  relativePath: string;
  contents: string;
}

export interface Artifact {
  runId: string;
  phaseId?: string;
  relativePath: string;
  absolutePath: string;
  bytes: number;
  createdAt: Date;
}

export class ArtifactNotFoundError extends Error {
  constructor(
    public readonly runId: string,
    public readonly relativePath: string,
  ) {
    super(`artifact not found: ${relativePath} in run ${runId}`);
    this.name = 'ArtifactNotFoundError';
  }
}

export interface ArtifactStore {
  write(input: WriteArtifactInput): Promise<Artifact>;
  read(runId: string, relativePath: string): Promise<string>;
  list(runId: string): Promise<Artifact[]>;
  /**
   * Re-materialize artifacts from the durable store into the worktree.
   * Useful during resume if the worktree was cleaned or artifacts were lost.
   */
  hydrateWorktree(runId: string): Promise<void>;
}
