import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { maybeRetryTransientRevalidationFlake } from '../compose.js';
import type {
  TaskManifest,
  ValidationCommand,
  ValidationRunCommandItem,
  RunValidation,
  ValidationPort,
  EventBusPort,
} from '@ai-sdlc/application';
import type { OrchestratorConfig } from '@ai-sdlc/shared';

describe('maybeRetryTransientRevalidationFlake', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'reval-flake-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const mockConfig = {
    validation: {
      commands: ['pnpm -r test'],
      timeout: 60,
    },
  } as unknown as OrchestratorConfig;

  const mockManifest: TaskManifest = {
    version: 1,
    task_count: 1,
    tasks: [
      {
        n: 1,
        title: 'Task 1',
        expected_files: ['packages/feature/src/feature.ts'],
      },
    ],
  };

  const mockTaskValidationCommands: ValidationCommand[] = ['pnpm --filter @ai-sdlc/feature test'];

  it('retries revalidation when failing test is out-of-scope and passes in isolation', async () => {
    const publishedEvents: Record<string, unknown>[] = [];
    const mockEventBus: EventBusPort = {
      publish: (_runId: string, event: unknown) => {
        publishedEvents.push(event as Record<string, unknown>);
      },
      subscribe: () => () => {},
    };

    const stdoutFile = join(tempDir, 'stdout.log');
    const stderrFile = join(tempDir, 'stderr.log');
    const vitestOutput = `
 ❯ packages/other/src/__tests__/out-of-scope.test.ts (1 test | 1 failed)
   × out-of-scope test failed

 Test Files  1 failed (1)
`;
    writeFileSync(stdoutFile, vitestOutput, 'utf-8');
    writeFileSync(stderrFile, '', 'utf-8');

    const failingCommands: ValidationRunCommandItem[] = [
      {
        command: 'pnpm -r test',
        outcome: 'failed',
        kind: 'test',
        stdoutPath: stdoutFile,
        stderrPath: stderrFile,
      },
    ];

    // Mock validationAdapter.run (for isolation check)
    const mockValidationAdapter = {
      run: vi.fn().mockResolvedValue([
        {
          command: 'pnpm --filter @ai-sdlc/other test -- out-of-scope.test.ts',
          outcome: 'passed',
        },
      ]),
    } as unknown as ValidationPort;

    // Mock runValidation.execute (for full revalidation retry)
    const mockRunValidation = {
      execute: vi.fn().mockResolvedValue({
        validationRun: {
          id: 'vrun-2',
          commands: [{ command: 'pnpm -r test', outcome: 'passed', exitCode: 0 }],
        },
      }),
    } as unknown as RunValidation;

    const result = await maybeRetryTransientRevalidationFlake({
      runId: 'test-run-123',
      stepIndex: 1,
      manifest: mockManifest,
      taskValidationCommands: mockTaskValidationCommands,
      failingCommands,
      revalidateLogDir: tempDir,
      cwd: '/app',
      repoId: 'owner/repo',
      config: mockConfig,
      runValidation: mockRunValidation,
      validationAdapter: mockValidationAdapter,
      eventBus: mockEventBus,
    });

    expect(result.retried).toBe(true);
    expect(result.passed).toBe(true);

    // Verify isolation check was called with targeted test command
    expect(mockValidationAdapter.run).toHaveBeenCalledTimes(1);

    // Verify revalidation retry was run
    expect(mockRunValidation.execute).toHaveBeenCalledTimes(1);

    // Verify transient flake retry event was published
    expect(publishedEvents).toHaveLength(1);
    expect(publishedEvents[0].type).toBe('revalidation.transient_flake_retry');
    expect(publishedEvents[0].metadata.failedTestFiles).toEqual([
      'packages/other/src/__tests__/out-of-scope.test.ts',
    ]);
  });

  it('does NOT retry when failing test file is in-scope for the task', async () => {
    const stdoutFile = join(tempDir, 'stdout.log');
    const stderrFile = join(tempDir, 'stderr.log');
    writeFileSync(
      stdoutFile,
      `
 ❯ packages/other/src/__tests__/out-of-scope.test.ts (1 test | 1 failed)
   × out-of-scope test failed

 Test Files  1 failed (1)
`,
      'utf-8',
    );
    writeFileSync(stderrFile, '', 'utf-8');

    const inScopeManifest: TaskManifest = {
      version: 1,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'Task 1',
          expected_files: ['packages/other/src/__tests__/out-of-scope.test.ts'],
        },
      ],
    };

    const failingCommands: ValidationRunCommandItem[] = [
      {
        command: 'pnpm -r test',
        outcome: 'failed',
        kind: 'test',
        stdoutPath: stdoutFile,
        stderrPath: stderrFile,
      },
    ];

    const mockValidationAdapter = {
      run: vi.fn(),
    } as unknown as ValidationPort;

    const mockRunValidation = {
      execute: vi.fn(),
    } as unknown as RunValidation;

    const result = await maybeRetryTransientRevalidationFlake({
      runId: 'test-run-123',
      stepIndex: 1,
      manifest: inScopeManifest,
      taskValidationCommands: mockTaskValidationCommands,
      failingCommands,
      revalidateLogDir: tempDir,
      cwd: '/app',
      repoId: 'owner/repo',
      config: mockConfig,
      runValidation: mockRunValidation,
      validationAdapter: mockValidationAdapter,
    });

    expect(result.retried).toBe(false);
    expect(mockValidationAdapter.run).not.toHaveBeenCalled();
    expect(mockRunValidation.execute).not.toHaveBeenCalled();
  });

  it('does NOT retry when the failing test file also fails in isolation', async () => {
    const stdoutFile = join(tempDir, 'stdout.log');
    const stderrFile = join(tempDir, 'stderr.log');
    writeFileSync(
      stdoutFile,
      `
 ❯ packages/other/src/__tests__/out-of-scope.test.ts (1 test | 1 failed)
   × out-of-scope test failed

 Test Files  1 failed (1)
`,
      'utf-8',
    );
    writeFileSync(stderrFile, '', 'utf-8');

    const failingCommands: ValidationRunCommandItem[] = [
      {
        command: 'pnpm -r test',
        outcome: 'failed',
        kind: 'test',
        stdoutPath: stdoutFile,
        stderrPath: stderrFile,
      },
    ];

    // Mock isolation check returning failure
    const mockValidationAdapter = {
      run: vi.fn().mockResolvedValue([
        {
          command: 'pnpm --filter @ai-sdlc/other test -- out-of-scope.test.ts',
          outcome: 'failed',
        },
      ]),
    } as unknown as ValidationPort;

    const mockRunValidation = {
      execute: vi.fn(),
    } as unknown as RunValidation;

    const result = await maybeRetryTransientRevalidationFlake({
      runId: 'test-run-123',
      stepIndex: 1,
      manifest: mockManifest,
      taskValidationCommands: mockTaskValidationCommands,
      failingCommands,
      revalidateLogDir: tempDir,
      cwd: '/app',
      repoId: 'owner/repo',
      config: mockConfig,
      runValidation: mockRunValidation,
      validationAdapter: mockValidationAdapter,
    });

    expect(result.retried).toBe(false);
    expect(result.passed).toBe(false);
    expect(mockValidationAdapter.run).toHaveBeenCalledTimes(1);
    expect(mockRunValidation.execute).not.toHaveBeenCalled();
  });

  it('transient flake retry reuses the failed pass effective plan', async () => {
    const stdoutFile = join(tempDir, 'stdout.log');
    const stderrFile = join(tempDir, 'stderr.log');
    const vitestOutput = `
 ❯ packages/other/src/__tests__/out-of-scope.test.ts (1 test | 1 failed)
   × out-of-scope test failed

 Test Files  1 failed (1)
`;
    writeFileSync(stdoutFile, vitestOutput, 'utf-8');
    writeFileSync(stderrFile, '', 'utf-8');

    const failingCommands: ValidationRunCommandItem[] = [
      {
        command: 'pnpm --filter @ai-sdlc/api... test',
        outcome: 'failed',
        kind: 'test',
        stdoutPath: stdoutFile,
        stderrPath: stderrFile,
      },
    ];

    const mockValidationAdapter = {
      run: vi.fn().mockResolvedValue([
        {
          command: 'pnpm --filter @ai-sdlc/other test -- out-of-scope.test.ts',
          outcome: 'passed',
        },
      ]),
    } as unknown as ValidationPort;

    const mockRunValidation = {
      execute: vi.fn().mockResolvedValue({
        validationRun: {
          id: 'vrun-retry-1',
          commands: [
            { command: 'pnpm --filter @ai-sdlc/api... test', outcome: 'passed', exitCode: 0 },
            { command: 'pnpm --filter @ai-sdlc/feature test', outcome: 'passed', exitCode: 0 },
          ],
        },
      }),
    } as unknown as RunValidation;

    const effectiveCommands = [
      'pnpm --filter @ai-sdlc/api... build',
      'pnpm --filter @ai-sdlc/api... test',
    ];
    const effectiveTiers = [
      ['pnpm --filter @ai-sdlc/api... build'],
      ['pnpm --filter @ai-sdlc/api... test'],
    ];
    const validationScope = {
      validationMode: 'narrow' as const,
      narrowedPackages: ['@ai-sdlc/api', '@ai-sdlc/cli'],
    };

    const result = await maybeRetryTransientRevalidationFlake({
      runId: 'test-run-456',
      stepIndex: 1,
      manifest: mockManifest,
      taskValidationCommands: mockTaskValidationCommands,
      failingCommands,
      revalidateLogDir: tempDir,
      cwd: '/app',
      repoId: 'owner/repo',
      config: mockConfig,
      runValidation: mockRunValidation,
      validationAdapter: mockValidationAdapter,
      effectiveCommands,
      effectiveTiers,
      validationScope,
    });

    expect(result.retried).toBe(true);
    expect(result.passed).toBe(true);

    expect(mockRunValidation.execute).toHaveBeenCalledTimes(1);
    expect(mockRunValidation.execute).toHaveBeenCalledWith({
      runId: expect.anything(),
      phaseId: expect.anything(),
      cwd: '/app',
      logDir: join(tempDir, 'flake-retry'),
      commands: [
        'pnpm --filter @ai-sdlc/api... build',
        'pnpm --filter @ai-sdlc/api... test',
        'pnpm --filter @ai-sdlc/feature test',
      ],
      tiers: effectiveTiers,
      timeoutSeconds: 60,
      env: { GITHUB_REPOSITORY: 'owner/repo' },
      validationScope,
    });
  });

  it('isolated flake probes remain targeted and do not claim narrow telemetry', async () => {
    const stdoutFile = join(tempDir, 'stdout.log');
    const stderrFile = join(tempDir, 'stderr.log');
    const vitestOutput = `
 ❯ packages/other/src/__tests__/out-of-scope.test.ts (1 test | 1 failed)
   × out-of-scope test failed

 Test Files  1 failed (1)
`;
    writeFileSync(stdoutFile, vitestOutput, 'utf-8');
    writeFileSync(stderrFile, '', 'utf-8');

    const failingCommands: ValidationRunCommandItem[] = [
      {
        command: 'pnpm --filter @ai-sdlc/api... test',
        outcome: 'failed',
        kind: 'test',
        stdoutPath: stdoutFile,
        stderrPath: stderrFile,
      },
    ];

    const mockValidationAdapter = {
      run: vi.fn().mockResolvedValue([
        {
          command: 'pnpm --filter @ai-sdlc/other test -- out-of-scope.test.ts',
          outcome: 'passed',
        },
      ]),
    } as unknown as ValidationPort;

    const mockRunValidation = {
      execute: vi.fn().mockResolvedValue({
        validationRun: {
          id: 'vrun-retry-2',
          commands: [{ command: 'pnpm -r test', outcome: 'passed', exitCode: 0 }],
        },
      }),
    } as unknown as RunValidation;

    const validationScope = {
      validationMode: 'narrow' as const,
      narrowedPackages: ['@ai-sdlc/api'],
    };

    await maybeRetryTransientRevalidationFlake({
      runId: 'test-run-789',
      stepIndex: 1,
      manifest: mockManifest,
      taskValidationCommands: mockTaskValidationCommands,
      failingCommands,
      revalidateLogDir: tempDir,
      cwd: '/app',
      repoId: 'owner/repo',
      config: mockConfig,
      runValidation: mockRunValidation,
      validationAdapter: mockValidationAdapter,
      validationScope,
    });

    expect(mockValidationAdapter.run).toHaveBeenCalledTimes(1);
    expect(mockValidationAdapter.run).toHaveBeenCalledWith({
      cwd: '/app',
      logDir: join(tempDir, 'isolation-check'),
      commands: [
        "pnpm vitest run 'packages/other/src/__tests__/out-of-scope.test.ts' --passWithNoTests=false",
      ],
      timeoutSeconds: 60,
      env: { GITHUB_REPOSITORY: 'owner/repo' },
    });
    // Ensure validationScope was NOT passed to the isolation adapter probe
    const isolationInput = vi.mocked(mockValidationAdapter.run).mock.calls[0][0];
    expect(isolationInput.validationScope).toBeUndefined();
  });
});
