import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildProgram } from '../cli.js';
import { ReleaseBatchId, JobId } from '@ai-sdlc/domain';

vi.setConfig({ testTimeout: 30000 });

describe('CLI release-batch command', () => {
  let stdoutOutput: string[] = [];
  let stderrOutput: string[] = [];
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutOutput = [];
    stderrOutput = [];
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((
      chunk: string | Uint8Array,
      encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
      cb?: (err?: Error | null) => void,
    ) => {
      stdoutOutput.push(String(chunk));
      const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
      if (callback) callback();
      return true;
    }) as never);
    stderrSpy = vi.spyOn(console, 'error').mockImplementation(((msg: string) => {
      stderrOutput.push(String(msg));
    }) as never);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('registers release-batch start command', () => {
    const program = buildProgram({ isCliTestSuite: true });
    const batchCmd = program.commands.find((c) => c.name() === 'release-batch');
    expect(batchCmd).toBeDefined();
    const startCmd = batchCmd?.commands.find((c) => c.name() === 'start');
    expect(startCmd).toBeDefined();
  });

  it('invokes startReleaseBatch with parsed options and writes formatted output', async () => {
    const mockBatch = {
      id: ReleaseBatchId('batch-2026-09-11-101-102'),
      repoId: 'owner/repo',
      sourceBranch: 'main',
      sourceStartSha: 'sha-12345',
      releaseBranch: 'release/2026-09-11-batch-101-102',
      status: 'building',
      currentPosition: 1,
      createdAt: new Date(),
      items: [
        { position: 1, issueNumber: 101, status: 'active', runUuid: 'uuid-101' },
        { position: 2, issueNumber: 102, status: 'pending' },
      ],
    };

    const mockStartReleaseBatch = {
      execute: vi.fn().mockResolvedValue({
        batchId: ReleaseBatchId('batch-2026-09-11-101-102'),
        releaseBranch: 'release/2026-09-11-batch-101-102',
        sourceBranch: 'main',
        sourceStartSha: 'sha-12345',
        runUuid: 'uuid-101',
        runDisplayId: 'issue-101-run',
        jobId: JobId('job-101'),
        batch: mockBatch,
      }),
    };

    const program = buildProgram({
      isCliTestSuite: true,
      composeOverrides: {
        repoFullName: 'owner/repo',
        startReleaseBatch:
          mockStartReleaseBatch as unknown as import('@ai-sdlc/application').StartReleaseBatch,
      },
    });

    const batchCmd = program.commands.find((c) => c.name() === 'release-batch')!;
    batchCmd.exitOverride();

    await batchCmd.parseAsync(
      [
        'start',
        '--issues',
        '101,102',
        '--source-branch',
        'main',
        '--release-branch',
        'release/test-101',
      ],
      { from: 'user' },
    );

    expect(mockStartReleaseBatch.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        issueNumbers: [101, 102],
        sourceBranch: 'main',
        releaseBranch: 'release/test-101',
      }),
    );

    const fullStdout = stdoutOutput.join('');
    expect(fullStdout).toContain('Release batch batch-2026-09-11-101-102 created successfully');
    expect(fullStdout).toContain('Release Branch: release/2026-09-11-batch-101-102');
    expect(fullStdout).toContain('Source Branch:  main (sha-12345)');
    expect(fullStdout).toContain('Issues (2):    #101, #102');
    expect(fullStdout).toContain('Admitted Item:  #101 (Run UUID: uuid-101)');
    expect(fullStdout).toContain('Initial Job ID: job-101');
  });

  it('prints error and exits with code 1 on missing issues', async () => {
    const program = buildProgram({
      isCliTestSuite: true,
      composeOverrides: {
        repoFullName: 'owner/repo',
      },
    });

    const batchCmd = program.commands.find((c) => c.name() === 'release-batch')!;
    batchCmd.exitOverride();

    await batchCmd.parseAsync(['start'], { from: 'user' });

    expect(exitSpy).toHaveBeenCalledWith(1);
    const fullStderr = stderrOutput.join('');
    expect(fullStderr).toContain('Error: --issues is required');
  });
});
