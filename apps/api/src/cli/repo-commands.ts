/* eslint-disable no-console */
import { Command } from 'commander';
import { RepositoryId } from '@ai-sdlc/domain';
import type { Container } from '../compose.js';
import { EXIT_USER_ERROR, EXIT_INTERNAL_ERROR } from './exit-codes.js';

const ID_OR_FULLNAME_RE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?$/;

function exitUserError(msg: string): never {
  console.error(`Error: ${msg}`);
  process.exit(EXIT_USER_ERROR);
}

export function registerRepoCommand(
  program: Command,
  getContainer: (targetRepoRoot?: string) => Container,
): void {
  const repo = program.command('repo').description('Manage registered repositories');

  repo
    .command('register')
    .description('Register a repository after validating its path and GitHub identity')
    .requiredOption('--local-path <path>', 'Absolute path to the local checkout')
    .option('--full-name <name>', 'Optional override for owner/name (must match what gh resolves)')
    .option('--config-metadata <json>', 'JSON config metadata blob', '{}')
    .option(
      '--target-repo-root <path>',
      'Target repository root for worktrees and DB (default: orchestrator repo)',
    )
    .action(
      async (opts: {
        localPath: string;
        fullName?: string;
        configMetadata: string;
        targetRepoRoot?: string;
      }) => {
        const c = getContainer(opts.targetRepoRoot);
        try {
          const out = c.registerRepository.execute({
            localPath: opts.localPath,
            configMetadata: opts.configMetadata,
            ...(opts.fullName !== undefined ? { fullName: opts.fullName } : {}),
          });
          console.log(JSON.stringify(out, null, 2));
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          process.exit(EXIT_USER_ERROR);
        }
      },
    );

  repo
    .command('list')
    .description('List registered repositories')
    .option('--all', 'Include disabled repositories')
    .option('--json', 'Emit JSON instead of a human-readable table')
    .option(
      '--target-repo-root <path>',
      'Target repository root for worktrees and DB (default: orchestrator repo)',
    )
    .action(async (opts: { all?: boolean; json?: boolean; targetRepoRoot?: string }) => {
      const c = getContainer(opts.targetRepoRoot);
      const repos = c.listRepositories.execute({ includeDisabled: Boolean(opts.all) });
      if (opts.json) {
        console.log(JSON.stringify(repos, null, 2));
        return;
      }
      for (const r of repos) {
        console.log(
          `${r.enabled ? 'enabled ' : 'disabled'} ${r.id}  ${r.fullName}  ${r.localBasePath}  (${
            r.healthStatus
          })`,
        );
      }
    });

  repo
    .command('inspect')
    .description('Inspect a registered repository')
    .option('--id <id>', 'Repository id (sha256 hex)')
    .option('--full-name <name>', 'owner/name')
    .option('--local-path <path>', 'Absolute local checkout path')
    .option(
      '--target-repo-root <path>',
      'Target repository root for worktrees and DB (default: orchestrator repo)',
    )
    .action(
      async (opts: {
        id?: string;
        fullName?: string;
        localPath?: string;
        targetRepoRoot?: string;
      }) => {
        const c = getContainer(opts.targetRepoRoot);
        const picked = [opts.id, opts.fullName, opts.localPath].filter(Boolean);
        if (picked.length !== 1) {
          exitUserError('specify exactly one of --id, --full-name, --local-path');
        }
        try {
          const repo = opts.id
            ? c.inspectRepository.executeById(RepositoryId(opts.id))
            : opts.fullName
              ? c.inspectRepository.executeByFullName(opts.fullName)
              : c.inspectRepository.executeByLocalPath(opts.localPath!);
          console.log(JSON.stringify(repo, null, 2));
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          process.exit(EXIT_USER_ERROR);
        }
      },
    );

  repo
    .command('update')
    .description('Update mutable repository metadata')
    .requiredOption('--id <id>', 'Repository id (sha256 hex)')
    .option('--default-branch <branch>', 'New default branch')
    .option('--remote-url <url>', 'New remote URL')
    .option('--config-metadata <json>', 'New config metadata blob')
    .option('--enable', 'Re-enable the repository')
    .option('--disable', 'Disable the repository')
    .option(
      '--target-repo-root <path>',
      'Target repository root for worktrees and DB (default: orchestrator repo)',
    )
    .action(
      async (opts: {
        id: string;
        defaultBranch?: string;
        remoteUrl?: string;
        configMetadata?: string;
        enable?: boolean;
        disable?: boolean;
        targetRepoRoot?: string;
      }) => {
        if (!ID_OR_FULLNAME_RE.test(opts.id)) {
          exitUserError(`invalid --id "${opts.id}"`);
        }
        const c = getContainer(opts.targetRepoRoot);
        try {
          if (opts.enable && opts.disable) {
            exitUserError('--enable and --disable are mutually exclusive');
          }
          const repoId = opts.id.includes('/')
            ? c.inspectRepository.executeByFullName(opts.id).id
            : opts.id;
          const out = c.updateRepository.execute({
            id: RepositoryId(repoId),
            ...(opts.enable ? { enabled: true } : {}),
            ...(opts.disable ? { enabled: false } : {}),
            ...(opts.defaultBranch !== undefined ? { defaultBranch: opts.defaultBranch } : {}),
            ...(opts.remoteUrl !== undefined ? { remoteUrl: opts.remoteUrl } : {}),
            ...(opts.configMetadata !== undefined ? { configMetadata: opts.configMetadata } : {}),
          });
          console.log(JSON.stringify(out, null, 2));
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          process.exit(EXIT_USER_ERROR);
        }
      },
    );

  repo
    .command('enable')
    .description('Enable a previously disabled repository')
    .requiredOption('--id <id>', 'Repository id')
    .option(
      '--target-repo-root <path>',
      'Target repository root for worktrees and DB (default: orchestrator repo)',
    )
    .action(async (opts: { id: string; targetRepoRoot?: string }) => {
      const c = getContainer(opts.targetRepoRoot);
      try {
        console.log(JSON.stringify(c.enableRepository.execute(RepositoryId(opts.id)), null, 2));
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(EXIT_USER_ERROR);
      }
    });

  repo
    .command('disable')
    .description('Disable a repository (retains history)')
    .requiredOption('--id <id>', 'Repository id')
    .option(
      '--target-repo-root <path>',
      'Target repository root for worktrees and DB (default: orchestrator repo)',
    )
    .action(async (opts: { id: string; targetRepoRoot?: string }) => {
      const c = getContainer(opts.targetRepoRoot);
      try {
        console.log(JSON.stringify(c.disableRepository.execute(RepositoryId(opts.id)), null, 2));
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(EXIT_USER_ERROR);
      }
    });

  repo
    .command('refresh')
    .description('Re-resolve repository metadata from gh/git and update health status')
    .requiredOption('--id <id>', 'Repository id')
    .option(
      '--target-repo-root <path>',
      'Target repository root for worktrees and DB (default: orchestrator repo)',
    )
    .action(async (opts: { id: string; targetRepoRoot?: string }) => {
      const c = getContainer(opts.targetRepoRoot);
      try {
        console.log(JSON.stringify(c.refreshRepository.execute(RepositoryId(opts.id)), null, 2));
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(EXIT_INTERNAL_ERROR);
      }
    });

  repo
    .command('remove')
    .description('Remove a registered repository (rejected while active runs exist)')
    .requiredOption('--id <id>', 'Repository id')
    .option(
      '--target-repo-root <path>',
      'Target repository root for worktrees and DB (default: orchestrator repo)',
    )
    .action(async (opts: { id: string; targetRepoRoot?: string }) => {
      const c = getContainer(opts.targetRepoRoot);
      try {
        c.removeRepository.execute(RepositoryId(opts.id));
        console.log(`removed ${opts.id}`);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(EXIT_USER_ERROR);
      }
    });
}
