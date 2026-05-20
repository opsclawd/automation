import type { ArtifactStore, WriteArtifactInput, Artifact } from '../ports/artifact-store.js';

export class FakeArtifactStore implements ArtifactStore {
  private files = new Map<string, { artifact: Artifact; contents: string }>();

  async write(input: WriteArtifactInput): Promise<Artifact> {
    const key = `${input.runId}/${input.relativePath}`;
    const bytes = Buffer.byteLength(input.contents);
    const artifact: Artifact = {
      runId: input.runId,
      ...(input.phaseId ? { phaseId: input.phaseId } : {}),
      relativePath: input.relativePath,
      absolutePath: `mem://${key}`,
      bytes,
      createdAt: new Date(),
    };
    this.files.set(key, { artifact, contents: input.contents });
    return artifact;
  }

  async read(runId: string, relativePath: string): Promise<string> {
    const entry = this.files.get(`${runId}/${relativePath}`);
    if (!entry) throw new Error(`no artifact ${runId}/${relativePath}`);
    return entry.contents;
  }

  async list(runId: string): Promise<Artifact[]> {
    return [...this.files.values()]
      .filter((e) => e.artifact.runId === runId)
      .map((e) => e.artifact);
  }
}
