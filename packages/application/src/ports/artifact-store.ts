export interface WriteArtifactInput {
  runId: string;
  phaseId?: string;
  relativePath: string;
  contents: string | Uint8Array;
}

export interface Artifact {
  runId: string;
  phaseId?: string;
  relativePath: string;
  absolutePath: string;
  bytes: number;
  createdAt: Date;
}

export interface ArtifactStore {
  write(input: WriteArtifactInput): Promise<Artifact>;
  read(runId: string, relativePath: string): Promise<string>;
  list(runId: string): Promise<Artifact[]>;
}
