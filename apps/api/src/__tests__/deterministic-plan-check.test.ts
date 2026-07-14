import { describe, it, expect, vi } from 'vitest';
import { createDeterministicPlanCheck } from '../deterministic-plan-check.js';
import type { PlanReviewContext } from '@ai-sdlc/application';
import type {
  SignatureReferenceAnalyzerPort,
  SignatureReferenceAnalysis,
} from '@ai-sdlc/application';

describe('createDeterministicPlanCheck', () => {
  const dummyCtx: PlanReviewContext = {
    loopId: 'loop-123',
    runId: 'run-123',
    phaseId: 'plan-review',
    repoId: 'repo-123',
    cwd: '/dummy/cwd',
    iterationIndex: 1,
  };

  it('handles absent manifest (returns null diagnostic)', async () => {
    const readPlanMd = vi.fn().mockResolvedValue('some plan markdown');
    const readManifest = vi.fn().mockResolvedValue(null);
    const validatePlanTaskList = vi.fn().mockReturnValue({ success: true });
    const signatureAnalyzer: SignatureReferenceAnalyzerPort = {
      analyze: vi.fn(),
    };

    const check = createDeterministicPlanCheck({
      readPlanMd,
      readManifest,
      validatePlanTaskList,
      signatureAnalyzer,
    });

    const result = await check(dummyCtx);
    expect(result).toEqual({
      diagnostic: null,
      signatureBlastRadiusFailures: [],
    });
    expect(signatureAnalyzer.analyze).not.toHaveBeenCalled();
  });

  it('handles absent planMd (returns null diagnostic)', async () => {
    const readPlanMd = vi.fn().mockRejectedValue(new Error('not found'));
    const readManifest = vi.fn().mockResolvedValue(
      JSON.stringify({
        version: 2,
        task_count: 1,
        tasks: [{ n: 1, title: 'task 1', files: [] }],
      }),
    );
    const validatePlanTaskList = vi.fn();
    const signatureAnalyzer: SignatureReferenceAnalyzerPort = {
      analyze: vi.fn(),
    };

    const check = createDeterministicPlanCheck({
      readPlanMd,
      readManifest,
      validatePlanTaskList,
      signatureAnalyzer,
    });

    const result = await check(dummyCtx);
    expect(result).toEqual({
      diagnostic: null,
      signatureBlastRadiusFailures: [],
    });
  });

  it('fails closed for malformed manifest', async () => {
    const readPlanMd = vi.fn().mockResolvedValue('some plan markdown');
    const readManifest = vi.fn().mockResolvedValue('invalid json');
    const validatePlanTaskList = vi.fn();
    const signatureAnalyzer: SignatureReferenceAnalyzerPort = {
      analyze: vi.fn(),
    };

    const check = createDeterministicPlanCheck({
      readPlanMd,
      readManifest,
      validatePlanTaskList,
      signatureAnalyzer,
    });

    const result = await check(dummyCtx);
    expect(result.diagnostic).toContain('task-manifest.json parse failure');
    expect(result.signatureBlastRadiusFailures).toEqual([]);
    expect(signatureAnalyzer.analyze).not.toHaveBeenCalled();
  });

  it('reports structural mismatch when validatePlanTaskList returns error', async () => {
    const readPlanMd = vi.fn().mockResolvedValue('some plan markdown');
    const readManifest = vi.fn().mockResolvedValue(
      JSON.stringify({
        version: 2,
        task_count: 0,
        tasks: [],
      }),
    );
    const validatePlanTaskList = vi.fn().mockReturnValue({
      success: false,
      error: 'structural mismatch error',
    });
    const signatureAnalyzer: SignatureReferenceAnalyzerPort = {
      analyze: vi.fn(),
    };

    const check = createDeterministicPlanCheck({
      readPlanMd,
      readManifest,
      validatePlanTaskList,
      signatureAnalyzer,
    });

    const result = await check(dummyCtx);
    expect(result.diagnostic).toBe('structural mismatch error');
    expect(result.signatureBlastRadiusFailures).toEqual([]);
    expect(signatureAnalyzer.analyze).not.toHaveBeenCalled();
  });

  it('skips analyzer I/O if there are no declared changes', async () => {
    const readPlanMd = vi.fn().mockResolvedValue('some plan markdown');
    // version 2 but no signature changes
    const manifest = {
      version: 2,
      task_count: 1,
      tasks: [{ n: 1, title: 'task 1', files: ['src/a.ts'] }],
    };
    const readManifest = vi.fn().mockResolvedValue(JSON.stringify(manifest));
    const validatePlanTaskList = vi.fn().mockReturnValue({ success: true });
    const signatureAnalyzer: SignatureReferenceAnalyzerPort = {
      analyze: vi.fn(),
    };

    const check = createDeterministicPlanCheck({
      readPlanMd,
      readManifest,
      validatePlanTaskList,
      signatureAnalyzer,
    });

    const result = await check(dummyCtx);
    expect(result).toEqual({
      diagnostic: null,
      signatureBlastRadiusFailures: [],
    });
    expect(signatureAnalyzer.analyze).not.toHaveBeenCalled();
  });

  it('asserts the analyzer receives ctx.cwd and only manifest-declared changes', async () => {
    const readPlanMd = vi.fn().mockResolvedValue('some plan markdown');
    const manifest = {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'task 1',
          files: ['src/a.ts'],
          signature_changes: [{ declaration_file: 'src/a.ts', symbol: 'foo' }],
        },
      ],
    };
    const readManifest = vi.fn().mockResolvedValue(JSON.stringify(manifest));
    const validatePlanTaskList = vi.fn().mockReturnValue({ success: true });
    const analyzeMock = vi.fn().mockResolvedValue([]);
    const signatureAnalyzer: SignatureReferenceAnalyzerPort = {
      analyze: analyzeMock,
    };

    const check = createDeterministicPlanCheck({
      readPlanMd,
      readManifest,
      validatePlanTaskList,
      signatureAnalyzer,
    });

    await check(dummyCtx);

    expect(analyzeMock).toHaveBeenCalledWith({
      worktreeRoot: dummyCtx.cwd,
      changes: [{ declarationFile: 'src/a.ts', symbol: 'foo', n: 1 }],
    });
  });

  it('handles unresolved declarations and uncovered references stably sorted', async () => {
    const readPlanMd = vi.fn().mockResolvedValue('some plan markdown');
    const manifest = {
      version: 2,
      task_count: 2,
      tasks: [
        {
          n: 1,
          title: 'task 1',
          expected_files: ['src/foo.ts'],
          signature_changes: [
            { declaration_file: 'src/foo.ts', symbol: 'fooFunc' },
            { declaration_file: 'src/foo.ts', symbol: 'barFunc' },
          ],
        },
        {
          n: 2,
          title: 'task 2',
          expected_files: ['src/baz.ts'],
        },
      ],
    };
    const readManifest = vi.fn().mockResolvedValue(JSON.stringify(manifest));
    const validatePlanTaskList = vi.fn().mockReturnValue({ success: true });

    const mockAnalyses: SignatureReferenceAnalysis[] = [
      {
        change: { declarationFile: 'src/foo.ts', symbol: 'barFunc' },
        references: [
          { file: 'src/external.ts', line: 12, column: 1, kind: 'call' }, // Not owned by task 1 or 2 -> uncovered!
        ],
      },
      {
        change: { declarationFile: 'src/foo.ts', symbol: 'fooFunc' },
        unresolvedDiagnostic: 'Could not create TypeScript program',
        references: [],
      },
    ];

    const signatureAnalyzer: SignatureReferenceAnalyzerPort = {
      analyze: vi.fn().mockResolvedValue(mockAnalyses),
    };

    const check = createDeterministicPlanCheck({
      readPlanMd,
      readManifest,
      validatePlanTaskList,
      signatureAnalyzer,
    });

    const result = await check(dummyCtx);

    expect(result.signatureBlastRadiusFailures).toHaveLength(2);
    // Verified stable sorting by symbol/task/file
    expect(result.signatureBlastRadiusFailures[0]?.symbol).toBe('barFunc');
    expect(result.signatureBlastRadiusFailures[1]?.symbol).toBe('fooFunc');

    expect(result.diagnostic).toContain('Task 1 changes barFunc');
    expect(result.diagnostic).toContain('src/external.ts:12:1');
    expect(result.diagnostic).toContain('unresolved: Could not create TypeScript program');
  });

  it('combines structural and blast-radius diagnostics stably', async () => {
    const readPlanMd = vi.fn().mockResolvedValue('some plan markdown');
    const manifest = {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'task 1',
          expected_files: ['src/foo.ts'],
          // fooFunc's declaration file is NOT in any task's expected_files,
          // so its unresolved diagnostic stays a genuine failure under the
          // ownership-based exemption (see the other test in this file).
          signature_changes: [{ declaration_file: 'src/foo.ts', symbol: 'fooFunc' }],
        },
      ],
    };
    const readManifest = vi.fn().mockResolvedValue(JSON.stringify(manifest));
    const validatePlanTaskList = vi.fn().mockReturnValue({
      success: false,
      error: 'structural mismatch error',
    });

    const mockAnalyses: SignatureReferenceAnalysis[] = [
      {
        change: { declarationFile: 'src/foo.ts', symbol: 'fooFunc' },
        unresolvedDiagnostic: 'Could not create TypeScript program',
        references: [],
      },
    ];

    const signatureAnalyzer: SignatureReferenceAnalyzerPort = {
      analyze: vi.fn().mockResolvedValue(mockAnalyses),
    };

    const check = createDeterministicPlanCheck({
      readPlanMd,
      readManifest,
      validatePlanTaskList,
      signatureAnalyzer,
    });

    const result = await check(dummyCtx);
    expect(result.diagnostic).toBe(
      'structural mismatch error\n\nTask 1 changes fooFunc, but these reference files are not declared by Task 1 or a later task:\n  (unresolved: Could not create TypeScript program)',
    );
  });
});
