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

  it('registers all release-batch subcommands', () => {
    const program = buildProgram({ isCliTestSuite: true });
    const batchCmd = program.commands.find((c) => c.name() === 'release-batch');
    expect(batchCmd).toBeDefined();
    const subcommands = batchCmd?.commands.map((c) => c.name());
    expect(subcommands).toContain('start');
    expect(subcommands).toContain('approve');
    expect(subcommands).toContain('reject');
    expect(subcommands).toContain('remediate');
    expect(subcommands).toContain('promote');
    expect(subcommands).toContain('integrate-source');
  });

  it('invokes approveReleaseBatchCandidate with parsed options and writes formatted output', async () => {
    const mockApprove = {
      execute: vi.fn().mockResolvedValue({
        id: ReleaseBatchId('batch-001'),
        candidateSha: 'sha-candidate-abc',
        status: 'approved',
      }),
    };

    const program = buildProgram({
      isCliTestSuite: true,
      composeOverrides: {
        repoFullName: 'owner/repo',
        approveReleaseBatchCandidate:
          mockApprove as unknown as import('@ai-sdlc/application').ApproveReleaseBatchCandidate,
      },
    });

    const batchCmd = program.commands.find((c) => c.name() === 'release-batch')!;
    batchCmd.exitOverride();

    await batchCmd.parseAsync(
      [
        'approve',
        '--batch-id',
        'batch-001',
        '--candidate-sha',
        'sha-candidate-abc',
        '--operator',
        'alice',
      ],
      { from: 'user' },
    );

    expect(mockApprove.execute).toHaveBeenCalledWith({
      batchId: ReleaseBatchId('batch-001'),
      candidateSha: 'sha-candidate-abc',
      operator: 'alice',
    });

    const fullStdout = stdoutOutput.join('');
    expect(fullStdout).toContain(
      'Release batch batch-001 candidate sha-candidate-abc approved successfully',
    );
    expect(fullStdout).toContain('Status:   approved');
    expect(fullStdout).toContain('Operator: alice');
  });

  it('invokes rejectReleaseBatchCandidate with parsed options and writes formatted output', async () => {
    const mockReject = {
      execute: vi.fn().mockResolvedValue({
        id: ReleaseBatchId('batch-001'),
        candidateSha: 'sha-candidate-abc',
        status: 'test_failed',
        blockedReason: 'Manual exploratory testing found regressions',
      }),
    };

    const program = buildProgram({
      isCliTestSuite: true,
      composeOverrides: {
        repoFullName: 'owner/repo',
        rejectReleaseBatchCandidate:
          mockReject as unknown as import('@ai-sdlc/application').RejectReleaseBatchCandidate,
      },
    });

    const batchCmd = program.commands.find((c) => c.name() === 'release-batch')!;
    batchCmd.exitOverride();

    await batchCmd.parseAsync(
      [
        'reject',
        '--batch-id',
        'batch-001',
        '--candidate-sha',
        'sha-candidate-abc',
        '--reason',
        'Manual exploratory testing found regressions',
      ],
      { from: 'user' },
    );

    expect(mockReject.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        batchId: ReleaseBatchId('batch-001'),
        candidateSha: 'sha-candidate-abc',
        reason: 'Manual exploratory testing found regressions',
      }),
    );

    const fullStdout = stdoutOutput.join('');
    expect(fullStdout).toContain('Release batch batch-001 candidate sha-candidate-abc rejected');
    expect(fullStdout).toContain('Status: test_failed');
    expect(fullStdout).toContain('Reason: Manual exploratory testing found regressions');
  });

  it('invokes appendRemediationIssues with parsed issue numbers and writes formatted output', async () => {
    const mockRemediate = {
      execute: vi.fn().mockResolvedValue({
        id: ReleaseBatchId('batch-001'),
        status: 'building',
        items: [
          { position: 1, issueNumber: 101 },
          { position: 2, issueNumber: 104 },
          { position: 3, issueNumber: 105 },
        ],
      }),
    };

    const program = buildProgram({
      isCliTestSuite: true,
      composeOverrides: {
        repoFullName: 'owner/repo',
        appendRemediationIssues:
          mockRemediate as unknown as import('@ai-sdlc/application').AppendRemediationIssues,
      },
    });

    const batchCmd = program.commands.find((c) => c.name() === 'release-batch')!;
    batchCmd.exitOverride();

    await batchCmd.parseAsync(['remediate', '--batch-id', 'batch-001', '--issues', '104, 105'], {
      from: 'user',
    });

    expect(mockRemediate.execute).toHaveBeenCalledWith({
      batchId: ReleaseBatchId('batch-001'),
      issueNumbers: [104, 105],
    });

    const fullStdout = stdoutOutput.join('');
    expect(fullStdout).toContain('Remediation issues appended to release batch batch-001:');
    expect(fullStdout).toContain('Status:     building');
    expect(fullStdout).toContain('Items (3):  #101, #104, #105');
  });

  it('invokes promoteReleaseBatch with parsed options and writes formatted output', async () => {
    const mockPromote = {
      execute: vi.fn().mockResolvedValue({
        batch: {
          id: ReleaseBatchId('batch-001'),
          status: 'promoting',
          approvedCandidateSha: 'sha-approved-xyz',
        },
        prNumber: 99,
      }),
    };

    const program = buildProgram({
      isCliTestSuite: true,
      composeOverrides: {
        repoFullName: 'owner/repo',
        promoteReleaseBatch:
          mockPromote as unknown as import('@ai-sdlc/application').PromoteReleaseBatch,
      },
    });

    const batchCmd = program.commands.find((c) => c.name() === 'release-batch')!;
    batchCmd.exitOverride();

    await batchCmd.parseAsync(['promote', '--batch-id', 'batch-001'], { from: 'user' });

    expect(mockPromote.execute).toHaveBeenCalledWith({
      batchId: ReleaseBatchId('batch-001'),
      autoMerge: true,
    });

    const fullStdout = stdoutOutput.join('');
    expect(fullStdout).toContain('Release batch batch-001 promotion initiated:');
    expect(fullStdout).toContain('Status:               promoting');
    expect(fullStdout).toContain('Promotion PR:         #99');
    expect(fullStdout).toContain('Approved Candidate:   sha-approved-xyz');
    expect(fullStdout).toContain('Auto-merge Requested: yes');
  });

  it('invokes integrateSourceBranch on coordinator and writes formatted output', async () => {
    const mockCoordinator = {
      integrateSourceBranch: vi.fn().mockResolvedValue({
        success: true,
        newReleaseSha: 'sha-integrated-head',
      }),
    };

    const program = buildProgram({
      isCliTestSuite: true,
      composeOverrides: {
        repoFullName: 'owner/repo',
        releaseBatchCoordinator:
          mockCoordinator as unknown as import('@ai-sdlc/application').ReleaseBatchCoordinator,
      },
    });

    const batchCmd = program.commands.find((c) => c.name() === 'release-batch')!;
    batchCmd.exitOverride();

    await batchCmd.parseAsync(['integrate-source', '--batch-id', 'batch-001'], { from: 'user' });

    expect(mockCoordinator.integrateSourceBranch).toHaveBeenCalledWith(ReleaseBatchId('batch-001'));

    const fullStdout = stdoutOutput.join('');
    expect(fullStdout).toContain('Source branch integrated into release batch batch-001:');
    expect(fullStdout).toContain('New Release Head: sha-integrated-head');
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
