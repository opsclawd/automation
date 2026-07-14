import { ArtifactNotFoundError } from '../ports/artifact-store.js';
import type { ArtifactStore, WriteArtifactInput, Artifact } from '../ports/artifact-store.js';

export class FakeArtifactStore implements ArtifactStore {
  private files = new Map<string, { artifact: Artifact; contents: string }>();
  private worktree = new Map<string, string>();
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
    this.worktree.set(key, input.contents);
    return artifact;
  }

  async read(runId: string, relativePath: string): Promise<string> {
    const key = `${runId}/${relativePath}`;
    const entry = this.files.get(key);
    if (entry) return entry.contents;
    const wt = this.worktree.get(key);
    if (wt !== undefined) return wt;
    throw new ArtifactNotFoundError(runId, relativePath);
  }

  async list(runId: string): Promise<Artifact[]> {
    return [...this.files.values()]
      .filter((e) => e.artifact.runId === runId)
      .map((e) => e.artifact);
  }

  async hydrateWorktree(runId: string): Promise<void> {
    for (const [key, entry] of this.files.entries()) {
      if (key.startsWith(`${runId}/`)) {
        this.worktree.set(key, entry.contents);
      }
    }
  }

  // Test helpers
  deleteFromWorktree(runId: string, relativePath: string): void {
    this.worktree.delete(`${runId}/${relativePath}`);
  }

  existsInWorktree(runId: string, relativePath: string): boolean {
    return this.worktree.has(`${runId}/${relativePath}`);
  }
}
