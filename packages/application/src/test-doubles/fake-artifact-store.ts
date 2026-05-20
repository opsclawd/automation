import type { ArtifactStore, WriteArtifactInput, Artifact } from '../ports/artifact-store.js';

export class FakeArtifactStore implements ArtifactStore {
  private files = new Map<string, { artifact: Artifact; contents: string | Uint8Array }>();

  async write(input: WriteArtifactInput): Promise<Artifact> {
    const key = `${input.runId}/${input.relativePath}`;
    const bytes =
      typeof input.contents === 'string'
        ? Buffer.byteLength(input.contents)
        : input.contents.byteLength;
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
    return typeof entry.contents === 'string'
      ? entry.contents
      : Buffer.from(entry.contents).toString('utf8');
  }

  async list(_runId: string): Promise<Artifact[]> {
    return [...this.files.values()].map((e) => e.artifact);
  }
}
