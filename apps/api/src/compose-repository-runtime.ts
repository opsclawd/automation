import type { LoadedConfig } from '@ai-sdlc/shared';
import type { RunStatus } from '@ai-sdlc/domain';
import type { RepositoryRuntimePaths } from './repository-runtime-paths.js';
import type {
  RepositoryExecutionRuntime,
  RepositoryOperationalRuntime,
} from './repository-runtime-factory.js';
import type { RunRepositoryUpdatePatch } from '@ai-sdlc/application/ports';
import { composeRepositoryOperationalRuntime } from './compose-repository-operational-runtime.js';
import type { ComposeRepositoryOperationalRuntimeInput } from './compose-repository-operational-runtime.js';

export interface ComposeRepositoryRuntimeInput extends Omit<
  ComposeRepositoryOperationalRuntimeInput,
  'paths'
> {
  paths: RepositoryRuntimePaths;
  loadedConfig: LoadedConfig;
  operationalRuntime?: RepositoryOperationalRuntime;
}

export async function composeRepositoryRuntime(
  input: ComposeRepositoryRuntimeInput,
): Promise<RepositoryExecutionRuntime> {
  const {
    repository,
    paths,
    loadedConfig,
    controlPlaneDb,
    listEnabledRepositories,
    operationalRuntime: existingOperationalRuntime,
  } = input;

  const operationalRuntime =
    existingOperationalRuntime ??
    (await composeRepositoryOperationalRuntime({
      automationRoot: input.automationRoot,
      stateRoot: input.stateRoot,
      repository,
      paths,
      controlPlaneDb,
      listEnabledRepositories,
    }));

  const originalRunRepository = operationalRuntime.runRepository;
  const wrappedRunRepository = Object.create(originalRunRepository);
  wrappedRunRepository.update = (uuid: string, patch: RunRepositoryUpdatePatch) => {
    const existing = originalRunRepository.findByUuid(uuid);
    if (!existing) return;
    const currentFingerprint = (existing as { configFingerprint?: string }).configFingerprint ?? '';
    const currentSources = (existing as { configSourcesJson?: string }).configSourcesJson ?? '';
    originalRunRepository.update(uuid, {
      ...patch,
      configFingerprint:
        currentFingerprint !== loadedConfig.fingerprint
          ? loadedConfig.fingerprint
          : currentFingerprint,
      configSourcesJson:
        currentSources !== JSON.stringify(loadedConfig.sources)
          ? JSON.stringify(loadedConfig.sources)
          : currentSources,
    });
  };
  wrappedRunRepository.atomicUpdateByUuid = (
    uuid: string,
    patch: RunRepositoryUpdatePatch,
    expectedStatus: RunStatus,
  ) => {
    const existing = originalRunRepository.findByUuid(uuid);
    if (!existing) return false;
    const currentFingerprint = (existing as { configFingerprint?: string }).configFingerprint ?? '';
    const currentSources = (existing as { configSourcesJson?: string }).configSourcesJson ?? '';
    return originalRunRepository.atomicUpdateByUuid(
      uuid,
      {
        ...patch,
        configFingerprint:
          currentFingerprint !== loadedConfig.fingerprint
            ? loadedConfig.fingerprint
            : currentFingerprint,
        configSourcesJson:
          currentSources !== JSON.stringify(loadedConfig.sources)
            ? JSON.stringify(loadedConfig.sources)
            : currentSources,
      },
      expectedStatus,
    );
  };

  const executionRuntime: RepositoryExecutionRuntime = {
    ...operationalRuntime,
    runRepository: wrappedRunRepository,
    configFingerprint: loadedConfig.fingerprint,
    defaultBranch: repository.defaultBranch,
    fullName: repository.fullName,
    close: () => {
      // no-op: execution runtime does not own the lifecycle of shared operational resources
    },
  };

  return executionRuntime;
}
