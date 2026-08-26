import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { composeRoot, type ComposeOptions } from '../compose.js';
import type {
  ValidationPort,
  RunValidationInput,
  ValidationCommandResult,
  TaskManifest,
  StepLoopContext,
  CreatePrHandler,
  ValidateHandler,
} from '@ai-sdlc/application';
import { RunId, PhaseName, RepositoryId } from '@ai-sdlc/domain';

class RecordingValidationAdapter implements ValidationPort {
  readonly inputs: RunValidationInput[] = [];

  async run(input: RunValidationInput): Promise<ValidationCommandResult[]> {
    this.inputs.push(input);
    return input.commands.map((cmd) => {
      const commandStr = Array.isArray(cmd) ? cmd.join(' ') : cmd;
      return {
        command: commandStr,
        exitCode: 0,
        durationMs: 5,
        stdout: '',
        stderr: '',
        stdoutPath: '',
        stderrPath: '',
        outcome: 'passed',
      };
    });
  }
}

const FAKE_METADATA_RESOLVER: ComposeOptions['metadataResolver'] = {
  resolve: (p) => ({
    rootPath: p,
    nameWithOwner: 'owner/repo',
    defaultBranch: 'main',
    remoteUrl: 'https://github.com/owner/repo.git',
  }),
};

function fakeScript(exitCode: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'ai-orch-test-script-'));
  const scriptPath = join(dir, 'run.sh');
  writeFileSync(scriptPath, `#!/usr/bin/env bash\nexit ${exitCode}\n`);
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function setupStandardWorkspace(root: string): void {
  writeFileSync(
    join(root, 'pnpm-workspace.yaml'),
    `packages:
  - 'packages/*'
  - 'apps/*'
`,
  );

  const orchestratorConfig = {
    validation: {
      commands: [
        'pnpm boundaries',
        'pnpm -r build',
        'pnpm -r typecheck',
        'pnpm lint',
        'pnpm -r test',
        'pnpm test:bash',
      ],
      tiers: [
        ['pnpm boundaries'],
        ['pnpm -r build', 'pnpm -r typecheck'],
        ['pnpm lint', 'pnpm -r test', 'pnpm test:bash'],
      ],
      timeout: 60,
    },
    phases: {
      skip: [],
      reviewFix: { maxIterations: 3 },
      implement: { maxIterations: 3 },
    },
    timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
    agent: {
      defaultProfile: 'test',
      profiles: {
        test: { runtime: 'opencode', provider: 'test', model: 'test', timeoutMinutes: 1 },
      },
      phaseProfiles: {
        'whole-pr-review': { profile: 'test' },
        'fix-review': { profile: 'test' },
      },
    },
  };
  writeFileSync(join(root, '.ai-orchestrator.json'), JSON.stringify(orchestratorConfig, null, 2));

  // Create package manifests
  const pkgs = [
    { dir: 'packages/shared', name: '@ai-sdlc/shared', deps: {} },
    { dir: 'packages/domain', name: '@ai-sdlc/domain', deps: { '@ai-sdlc/shared': 'workspace:*' } },
    {
      dir: 'packages/application',
      name: '@ai-sdlc/application',
      deps: { '@ai-sdlc/domain': 'workspace:*', '@ai-sdlc/shared': 'workspace:*' },
    },
    {
      dir: 'packages/infrastructure',
      name: '@ai-sdlc/infrastructure',
      deps: {
        '@ai-sdlc/application': 'workspace:*',
        '@ai-sdlc/domain': 'workspace:*',
        '@ai-sdlc/shared': 'workspace:*',
      },
    },
    {
      dir: 'apps/api',
      name: '@ai-sdlc/api',
      deps: {
        '@ai-sdlc/application': 'workspace:*',
        '@ai-sdlc/infrastructure': 'workspace:*',
        '@ai-sdlc/domain': 'workspace:*',
        '@ai-sdlc/shared': 'workspace:*',
      },
    },
    {
      dir: 'apps/cli',
      name: '@ai-sdlc/cli',
      deps: {
        '@ai-sdlc/api': 'workspace:*',
        '@ai-sdlc/application': 'workspace:*',
        '@ai-sdlc/infrastructure': 'workspace:*',
        '@ai-sdlc/domain': 'workspace:*',
        '@ai-sdlc/shared': 'workspace:*',
      },
    },
    { dir: 'apps/web', name: '@ai-sdlc/web', deps: { '@ai-sdlc/shared': 'workspace:*' } },
  ];

  for (const pkg of pkgs) {
    const fullDir = join(root, pkg.dir);
    mkdirSync(fullDir, { recursive: true });
    writeFileSync(
      join(fullDir, 'package.json'),
      JSON.stringify(
        {
          name: pkg.name,
          version: '1.0.0',
          dependencies: pkg.deps,
        },
        null,
        2,
      ),
    );
  }
}

let issueSequence = 1;

describe('Compose Narrow Revalidation Integration', () => {
  let rootDir: string;
  let scriptPath: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'compose-narrow-reval-'));
    scriptPath = fakeScript(0);
    setupStandardWorkspace(rootDir);
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  const mockManifest: TaskManifest = {
    version: 1,
    task_count: 1,
    tasks: [
      {
        n: 1,
        title: 'Task 1',
        expected_files: ['packages/application/src/revalidation-plan.ts'],
      },
    ],
  };

  function createTestRun(
    container: ReturnType<typeof composeRoot>,
    runUuid: string,
    issueNum: number = issueSequence++,
  ): void {
    container.runRepository.insertIfNoActive({
      uuid: runUuid,
      displayId: runUuid,
      type: 'issue_to_pr',
      issueNumber: issueNum,
      repoId: RepositoryId('owner/repo'),
      phaseId: PhaseName('implement'),
      status: 'in_progress',
      startedAt: new Date(),
      completedPhases: [],
    });
  }

  it('mid-implement application change executes the application dependent closure', async () => {
    const recordingValidation = new RecordingValidationAdapter();
    const container = composeRoot({
      repoRoot: rootDir,
      scriptPath,
      metadataResolver: FAKE_METADATA_RESOLVER,
      validationPort: recordingValidation,
    });

    const runId = 'test-run-app';
    createTestRun(container, runId);

    vi.spyOn(container.git, 'headCommitSha').mockResolvedValue('head-commit-sha');
    vi.spyOn(container.git, 'changedFiles').mockResolvedValue([
      'packages/application/src/revalidation-plan.ts',
    ]);
    vi.spyOn(container.git, 'status').mockResolvedValue(
      '?? packages/application/src/new-helper.ts\n',
    );

    writeFileSync(join(rootDir, 'task-manifest.json'), JSON.stringify(mockManifest));

    const ctx: StepLoopContext = {
      loopId: 'loop-1',
      runId: RunId(runId),
      phaseId: PhaseName('implement'),
      repoId: 'owner/repo',
      cwd: rootDir,
      stepIndex: 1,
      stepTitle: 'Task 1',
      iterationIndex: 2,
      manifest: mockManifest,
      planMd: '# Plan',
      initialPreStepHead: 'baseline-sha',
    };

    const revalResult = await container.implementStepLoop!.deps.runRevalidation!(ctx);
    expect(revalResult.passed).toBe(true);

    expect(recordingValidation.inputs).toHaveLength(1);
    const input = recordingValidation.inputs[0];

    // Narrow scope metadata
    expect(input.validationScope).toEqual({
      validationMode: 'narrow',
      narrowedPackages: [
        '@ai-sdlc/application',
        '@ai-sdlc/infrastructure',
        '@ai-sdlc/api',
        '@ai-sdlc/cli',
      ],
    });

    // Narrowed commands
    expect(input.commands).toContain('pnpm boundaries');
    expect(input.commands).toContain('pnpm --filter ...@ai-sdlc/application build');
    expect(input.commands).toContain('pnpm --filter ...@ai-sdlc/application typecheck');
    expect(input.commands).toContain(
      'pnpm exec eslint packages/application packages/infrastructure apps/api apps/cli --max-warnings=0',
    );
    expect(input.commands).toContain('pnpm --filter ...@ai-sdlc/application test');
    expect(input.commands).not.toContain('pnpm test:bash');

    // Matching rewritten tiers
    expect(input.tiers).toEqual([
      ['pnpm boundaries'],
      [
        'pnpm --filter ...@ai-sdlc/application build',
        'pnpm --filter ...@ai-sdlc/application typecheck',
      ],
      [
        'pnpm exec eslint packages/application packages/infrastructure apps/api apps/cli --max-warnings=0',
        'pnpm --filter ...@ai-sdlc/application test',
      ],
    ]);
  });

  it('mid-implement infrastructure api cli and web changes use their specified closures', async () => {
    const cases = [
      {
        file: 'packages/infrastructure/src/index.ts',
        expectedScope: ['@ai-sdlc/infrastructure', '@ai-sdlc/api', '@ai-sdlc/cli'],
        filter: '...@ai-sdlc/infrastructure',
        lintDirs: 'packages/infrastructure apps/api apps/cli',
      },
      {
        file: 'apps/api/src/compose.ts',
        expectedScope: ['@ai-sdlc/api', '@ai-sdlc/cli'],
        filter: '...@ai-sdlc/api',
        lintDirs: 'apps/api apps/cli',
      },
      {
        file: 'apps/cli/src/cli.ts',
        expectedScope: ['@ai-sdlc/cli'],
        filter: '@ai-sdlc/cli',
        lintDirs: 'apps/cli',
      },
      {
        file: 'apps/web/src/app.tsx',
        expectedScope: ['@ai-sdlc/web'],
        filter: '@ai-sdlc/web',
        lintDirs: 'apps/web',
      },
    ];

    for (let i = 0; i < cases.length; i++) {
      const c = cases[i];
      const recordingValidation = new RecordingValidationAdapter();
      const container = composeRoot({
        repoRoot: rootDir,
        scriptPath,
        metadataResolver: FAKE_METADATA_RESOLVER,
        validationPort: recordingValidation,
      });

      const runId = `run-${c.filter.replace(/[^a-zA-Z0-9]/g, '-')}-${i}`;
      createTestRun(container, runId);

      vi.spyOn(container.git, 'headCommitSha').mockResolvedValue('head-commit-sha');
      vi.spyOn(container.git, 'changedFiles').mockResolvedValue([c.file]);
      vi.spyOn(container.git, 'status').mockResolvedValue('');

      const ctx: StepLoopContext = {
        loopId: `loop-${c.filter}-${i}`,
        runId: RunId(runId),
        phaseId: PhaseName('implement'),
        repoId: 'owner/repo',
        cwd: rootDir,
        stepIndex: 1,
        stepTitle: 'Task 1',
        iterationIndex: 2,
        manifest: mockManifest,
        planMd: '# Plan',
        initialPreStepHead: 'baseline-sha',
      };

      await container.implementStepLoop!.deps.runRevalidation!(ctx);

      expect(recordingValidation.inputs).toHaveLength(1);
      const input = recordingValidation.inputs[0];

      expect(input.validationScope).toEqual({
        validationMode: 'narrow',
        narrowedPackages: c.expectedScope,
      });
      expect(input.commands).toContain(`pnpm --filter ${c.filter} build`);
      expect(input.commands).toContain(`pnpm --filter ${c.filter} typecheck`);
      expect(input.commands).toContain(`pnpm --filter ${c.filter} test`);
      expect(input.commands).toContain(`pnpm exec eslint ${c.lintDirs} --max-warnings=0`);
    }
  });

  it('first iteration missing baseline empty multi-package upstream root and discovery failures execute full configuration', async () => {
    const fallbackScenarios = [
      {
        name: 'first iteration',
        iterationIndex: 1,
        initialPreStepHead: 'baseline-sha',
        changedFiles: ['packages/application/src/index.ts'],
        status: '',
      },
      {
        name: 'missing baseline',
        iterationIndex: 2,
        initialPreStepHead: undefined,
        changedFiles: ['packages/application/src/index.ts'],
        status: '',
      },
      {
        name: 'empty changed files',
        iterationIndex: 2,
        initialPreStepHead: 'baseline-sha',
        changedFiles: [],
        status: '',
      },
      {
        name: 'multi-package changed files',
        iterationIndex: 2,
        initialPreStepHead: 'baseline-sha',
        changedFiles: ['packages/application/src/index.ts', 'packages/infrastructure/src/index.ts'],
        status: '',
      },
      {
        name: 'upstream package changed (shared)',
        iterationIndex: 2,
        initialPreStepHead: 'baseline-sha',
        changedFiles: ['packages/shared/src/index.ts'],
        status: '',
      },
      {
        name: 'upstream package changed (domain)',
        iterationIndex: 2,
        initialPreStepHead: 'baseline-sha',
        changedFiles: ['packages/domain/src/index.ts'],
        status: '',
      },
      {
        name: 'root file changed',
        iterationIndex: 2,
        initialPreStepHead: 'baseline-sha',
        changedFiles: ['pnpm-lock.yaml'],
        status: '',
      },
    ];

    for (let i = 0; i < fallbackScenarios.length; i++) {
      const scenario = fallbackScenarios[i];
      const recordingValidation = new RecordingValidationAdapter();
      const container = composeRoot({
        repoRoot: rootDir,
        scriptPath,
        metadataResolver: FAKE_METADATA_RESOLVER,
        validationPort: recordingValidation,
      });

      const runId = `run-${scenario.name.replace(/[^a-zA-Z0-9]/g, '-')}-${i}`;
      createTestRun(container, runId);

      vi.spyOn(container.git, 'headCommitSha').mockResolvedValue('head-commit-sha');
      vi.spyOn(container.git, 'changedFiles').mockResolvedValue(scenario.changedFiles);
      vi.spyOn(container.git, 'status').mockResolvedValue(scenario.status);

      const ctx: StepLoopContext = {
        loopId: `loop-${scenario.name}-${i}`,
        runId: RunId(runId),
        phaseId: PhaseName('implement'),
        repoId: 'owner/repo',
        cwd: rootDir,
        stepIndex: 1,
        stepTitle: 'Task 1',
        iterationIndex: scenario.iterationIndex,
        manifest: mockManifest,
        planMd: '# Plan',
        initialPreStepHead: scenario.initialPreStepHead,
      };

      await container.implementStepLoop!.deps.runRevalidation!(ctx);

      expect(recordingValidation.inputs).toHaveLength(1);
      const input = recordingValidation.inputs[0];

      expect(input.validationScope).toEqual({ validationMode: 'full' });
      expect(input.commands).toEqual([
        'pnpm boundaries',
        'pnpm -r build',
        'pnpm -r typecheck',
        'pnpm lint',
        'pnpm -r test',
        'pnpm test:bash',
      ]);
      expect(input.tiers).toEqual([
        ['pnpm boundaries'],
        ['pnpm -r build', 'pnpm -r typecheck'],
        ['pnpm lint', 'pnpm -r test', 'pnpm test:bash'],
      ]);
    }
  });

  it('boundaries is always global and narrow tiers cannot leak full commands', async () => {
    const recordingValidation = new RecordingValidationAdapter();
    const container = composeRoot({
      repoRoot: rootDir,
      scriptPath,
      metadataResolver: FAKE_METADATA_RESOLVER,
      validationPort: recordingValidation,
    });

    const runId = 'run-boundaries';
    createTestRun(container, runId);

    vi.spyOn(container.git, 'headCommitSha').mockResolvedValue('head-commit-sha');
    vi.spyOn(container.git, 'changedFiles').mockResolvedValue(['apps/api/src/compose.ts']);
    vi.spyOn(container.git, 'status').mockResolvedValue('');

    const ctx: StepLoopContext = {
      loopId: 'loop-boundaries',
      runId: RunId(runId),
      phaseId: PhaseName('implement'),
      repoId: 'owner/repo',
      cwd: rootDir,
      stepIndex: 1,
      stepTitle: 'Task 1',
      iterationIndex: 2,
      manifest: mockManifest,
      planMd: '# Plan',
      initialPreStepHead: 'baseline-sha',
    };

    await container.implementStepLoop!.deps.runRevalidation!(ctx);

    const input = recordingValidation.inputs[0];
    expect(input.commands).toContain('pnpm boundaries');
    expect(input.commands).not.toContain('pnpm -r build');
    expect(input.commands).not.toContain('pnpm -r typecheck');
    expect(input.commands).not.toContain('pnpm lint');
    expect(input.commands).not.toContain('pnpm -r test');

    // Ensure no full commands in tiers
    const allTierCommands = (input.tiers ?? []).flat();
    expect(allTierCommands).toContain('pnpm boundaries');
    expect(allTierCommands).not.toContain('pnpm -r build');
    expect(allTierCommands).not.toContain('pnpm -r typecheck');
    expect(allTierCommands).not.toContain('pnpm lint');
    expect(allTierCommands).not.toContain('pnpm -r test');
  });

  it('newly discovered task tests and inverted task commands remain appended', async () => {
    const recordingValidation = new RecordingValidationAdapter();
    const container = composeRoot({
      repoRoot: rootDir,
      scriptPath,
      metadataResolver: FAKE_METADATA_RESOLVER,
      validationPort: recordingValidation,
    });

    const runId = 'test-run-task-appended';
    createTestRun(container, runId);

    // Create a new task test file on disk
    mkdirSync(join(rootDir, 'apps/api/src/__tests__'), { recursive: true });
    writeFileSync(join(rootDir, 'apps/api/src/__tests__/task-new.test.ts'), '// test');

    const manifestWithTaskCmd: TaskManifest = {
      version: 1,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'Task 1',
          expected_files: ['apps/api/src/compose.ts'],
          validation: ['! pnpm vitest run apps/api/src/__tests__/invert.test.ts'],
        },
      ],
    };

    writeFileSync(join(rootDir, 'task-manifest.json'), JSON.stringify(manifestWithTaskCmd));

    vi.spyOn(container.git, 'headCommitSha').mockResolvedValue('head-commit-sha');
    vi.spyOn(container.git, 'changedFiles').mockResolvedValue([
      'apps/api/src/compose.ts',
      'apps/api/src/__tests__/task-new.test.ts',
    ]);
    vi.spyOn(container.git, 'status').mockResolvedValue('');

    const ctx: StepLoopContext = {
      loopId: 'loop-task-append',
      runId: RunId(runId),
      phaseId: PhaseName('implement'),
      repoId: 'owner/repo',
      cwd: rootDir,
      stepIndex: 1,
      stepTitle: 'Task 1',
      iterationIndex: 2,
      manifest: manifestWithTaskCmd,
      planMd: '# Plan',
      initialPreStepHead: 'baseline-sha',
    };

    await container.implementStepLoop!.deps.runRevalidation!(ctx);

    const input = recordingValidation.inputs[0];
    // Global narrowed commands first, then task commands
    expect(input.commands).toEqual([
      'pnpm boundaries',
      'pnpm --filter ...@ai-sdlc/api build',
      'pnpm --filter ...@ai-sdlc/api typecheck',
      'pnpm exec eslint apps/api apps/cli --max-warnings=0',
      'pnpm --filter ...@ai-sdlc/api test',
      '! pnpm vitest run apps/api/src/__tests__/invert.test.ts',
      "pnpm vitest run 'apps/api/src/__tests__/task-new.test.ts' --passWithNoTests=false",
    ]);
  });

  it('create-pr and other validation gates remain full', async () => {
    const recordingValidation = new RecordingValidationAdapter();
    const container = composeRoot({
      repoRoot: rootDir,
      scriptPath,
      metadataResolver: FAKE_METADATA_RESOLVER,
      validationPort: recordingValidation,
    });

    const createPrHandler = container.phaseRegistry.get('create-pr') as CreatePrHandler & {
      opts: { revalidate?: { commands: string[]; tiers?: string[][] } };
    };
    expect(createPrHandler).toBeDefined();
    expect(createPrHandler.opts.revalidate?.commands).toEqual([
      'pnpm boundaries',
      'pnpm -r build',
      'pnpm -r typecheck',
      'pnpm lint',
      'pnpm -r test',
      'pnpm test:bash',
    ]);

    const validateHandler = container.phaseRegistry.get('validate') as ValidateHandler & {
      opts: { commands: string[]; tiers?: string[][] };
    };
    expect(validateHandler).toBeDefined();
    expect(validateHandler.opts.commands).toEqual([
      'pnpm boundaries',
      'pnpm -r build',
      'pnpm -r typecheck',
      'pnpm lint',
      'pnpm -r test',
      'pnpm test:bash',
    ]);
    expect(validateHandler.opts.tiers).toEqual([
      ['pnpm boundaries'],
      ['pnpm -r build', 'pnpm -r typecheck'],
      ['pnpm lint', 'pnpm -r test', 'pnpm test:bash'],
    ]);
  });

  it('disabling validation.narrowByChangedFiles forces full validation plan', async () => {
    const customConfig = {
      validation: {
        commands: [
          'pnpm boundaries',
          'pnpm -r build',
          'pnpm -r typecheck',
          'pnpm lint',
          'pnpm -r test',
          'pnpm test:bash',
        ],
        tiers: [
          ['pnpm boundaries'],
          ['pnpm -r build', 'pnpm -r typecheck'],
          ['pnpm lint', 'pnpm -r test', 'pnpm test:bash'],
        ],
        timeout: 60,
        narrowByChangedFiles: false,
      },
      phases: {
        skip: [],
        reviewFix: { maxIterations: 3 },
        implement: { maxIterations: 3 },
      },
      timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
      agent: {
        defaultProfile: 'test',
        profiles: {
          test: { runtime: 'opencode', provider: 'test', model: 'test', timeoutMinutes: 1 },
        },
        phaseProfiles: {
          'whole-pr-review': { profile: 'test' },
          'fix-review': { profile: 'test' },
        },
      },
    };
    writeFileSync(join(rootDir, '.ai-orchestrator.json'), JSON.stringify(customConfig, null, 2));

    const recordingValidation = new RecordingValidationAdapter();
    const container = composeRoot({
      repoRoot: rootDir,
      scriptPath,
      metadataResolver: FAKE_METADATA_RESOLVER,
      validationPort: recordingValidation,
    });

    const runId = 'test-run-narrow-disabled';
    createTestRun(container, runId);

    vi.spyOn(container.git, 'headCommitSha').mockResolvedValue('head-commit-sha');
    vi.spyOn(container.git, 'changedFiles').mockResolvedValue([
      'packages/application/src/revalidation-plan.ts',
    ]);
    vi.spyOn(container.git, 'status').mockResolvedValue('');

    const ctx: StepLoopContext = {
      loopId: 'loop-narrow-disabled',
      runId: RunId(runId),
      phaseId: PhaseName('implement'),
      repoId: 'owner/repo',
      cwd: rootDir,
      stepIndex: 1,
      stepTitle: 'Task 1',
      iterationIndex: 2,
      manifest: mockManifest,
      planMd: '# Plan',
      initialPreStepHead: 'baseline-sha',
    };

    const revalResult = await container.implementStepLoop!.deps.runRevalidation!(ctx);
    expect(revalResult.passed).toBe(true);

    expect(recordingValidation.inputs).toHaveLength(1);
    const input = recordingValidation.inputs[0];

    expect(input.validationScope).toEqual({ validationMode: 'full' });
    expect(input.commands).toEqual([
      'pnpm boundaries',
      'pnpm -r build',
      'pnpm -r typecheck',
      'pnpm lint',
      'pnpm -r test',
      'pnpm test:bash',
    ]);
    expect(input.tiers).toEqual([
      ['pnpm boundaries'],
      ['pnpm -r build', 'pnpm -r typecheck'],
      ['pnpm lint', 'pnpm -r test', 'pnpm test:bash'],
    ]);
  });
});
