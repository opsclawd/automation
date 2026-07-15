import type { LoadedConfig } from '@ai-sdlc/shared';
import type { RepositoryRuntimePaths } from './repository-runtime-paths.js';
import type { RepositoryExecutionRuntime } from './repository-runtime-factory.js';
import type { RunRepositoryUpdatePatch } from '@ai-sdlc/application/ports';
import { composeRepositoryOperationalRuntime } from './compose-repository-operational-runtime.js';
import type { ComposeRepositoryOperationalRuntimeInput } from './compose-repository-operational-runtime.js';

export interface ComposeRepositoryRuntimeInput extends Omit<
  ComposeRepositoryOperationalRuntimeInput,
  'paths'
> {
  paths: RepositoryRuntimePaths;
  loadedConfig: LoadedConfig;
}

export async function composeRepositoryRuntime(
  input: ComposeRepositoryRuntimeInput,
): Promise<RepositoryExecutionRuntime> {
  const { repository, paths, loadedConfig, controlPlaneDb, listEnabledRepositories } = input;

  const operationalRuntime = await composeRepositoryOperationalRuntime({
    automationRoot: input.automationRoot,
    stateRoot: input.stateRoot,
    repository,
    paths,
    controlPlaneDb,
    listEnabledRepositories,
  });

  const runRepository = operationalRuntime.runRepository;
  const originalUpdate = runRepository.update.bind(runRepository);
  runRepository.update = (uuid: string, patch: RunRepositoryUpdatePatch) => {
    const existing = runRepository.findByUuid(uuid);
    if (!existing) return;
    const currentFingerprint = (existing as { configFingerprint?: string }).configFingerprint ?? '';
    const currentSources = (existing as { configSourcesJson?: string }).configSourcesJson ?? '';
    originalUpdate(uuid, {
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

  const executionRuntime: RepositoryExecutionRuntime = {
    ...operationalRuntime,
    configFingerprint: loadedConfig.fingerprint,
    defaultBranch: repository.defaultBranch,
    fullName: repository.fullName,
  };

  return executionRuntime;
}
