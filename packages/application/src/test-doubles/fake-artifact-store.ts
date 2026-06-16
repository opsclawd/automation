import { ArtifactNotFoundError } from '../ports/artifact-store.js';
import type { ArtifactStore, WriteArtifactInput, Artifact } from '../ports/artifact-store.js';

export class FakeArtifactStore implements ArtifactStore {
  private files = new Map<string, { artifact: Artifact; contents: string }>();
  shouldThrowOnWrite = false;

  async write(input: WriteArtifactInput): Promise<Artifact> {
    if (this.shouldThrowOnWrite) {
      throw new Error('write error');
    }
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
    if (!entry) throw new ArtifactNotFoundError(runId, relativePath);
    return entry.contents;
  }

  async list(runId: string): Promise<Artifact[]> {
    return [...this.files.values()]
      .filter((e) => e.artifact.runId === runId)
      .map((e) => e.artifact);
  }
}
