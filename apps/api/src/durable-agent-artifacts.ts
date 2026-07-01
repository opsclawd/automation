import { join } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import type {
  AgentInvocationRequest,
  AgentInvocationResult,
  AgentPort,
  ArtifactStore,
} from '@ai-sdlc/application';

export interface ArtifactCapturingAgentOptions {
  agent: AgentPort;
  artifactStoreForRequest: (request: AgentInvocationRequest) => ArtifactStore;
  phaseOutputs?: Record<string, string[]>;
  optionalArtifacts?: string[];
}

function isBestEffortMissingArtifactError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = Reflect.get(err, 'code');
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR';
}

async function captureArtifact(
  store: ArtifactStore,
  request: AgentInvocationRequest,
  relativePath: string,
): Promise<void> {
  const absolutePath = join(request.cwd, relativePath);
  try {
    const fileStat = await stat(absolutePath);
    if (!fileStat.isFile()) {
      return;
    }
    const contents = await readFile(absolutePath, 'utf-8');
    await store.write({
      runId: request.runId,
      phaseId: request.phaseId,
      relativePath,
      contents,
    });
  } catch (err) {
    if (isBestEffortMissingArtifactError(err)) {
      return;
    }
    throw err;
  }
}

export function createArtifactCapturingAgent({
  agent,
  artifactStoreForRequest,
  phaseOutputs = {},
  optionalArtifacts = [],
}: ArtifactCapturingAgentOptions): AgentPort {
  return {
    async invoke(request: AgentInvocationRequest): Promise<AgentInvocationResult> {
      const result = await agent.invoke(request);
      const store = artifactStoreForRequest(request);
      const capturePaths = new Set<string>();

      for (const relativePath of request.expectedArtifacts) {
        capturePaths.add(relativePath);
      }
      for (const relativePath of phaseOutputs[request.phaseId] ?? []) {
        capturePaths.add(relativePath);
      }
      for (const relativePath of optionalArtifacts) {
        capturePaths.add(relativePath);
      }

      await Promise.all(
        Array.from(capturePaths).map((relativePath) =>
          captureArtifact(store, request, relativePath),
        ),
      );

      return result;
    },
  };
}
