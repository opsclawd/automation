import { describe, it, expect, vi } from 'vitest';
import { createDeterministicPlanCheck } from '../deterministic-plan-check.js';
import type { PlanReviewContext } from '@ai-sdlc/application';
import type { SignatureReferenceAnalyzerPort } from '@ai-sdlc/application';

describe('deterministic plan review forbidden artifact checks', () => {
  const dummyCtx: PlanReviewContext = {
    loopId: 'loop-123',
    runId: 'run-123',
    phaseId: 'plan-review',
    repoId: 'repo-123',
    cwd: '/dummy/cwd',
    iterationIndex: 1,
  };

  function makeCheck(options: {
    forbiddenArtifactPaths?: string[];
    tasks?: Array<Record<string, unknown>>;
    structuralError?: string | null;
  }) {
    const tasks = options.tasks ?? [
      {
        n: 1,
        title: 'Task 1',
        expected_files: ['src/index.ts'],
      },
    ];

    const manifest = {
      version: 2,
      task_count: tasks.length,
      tasks,
    };

    const readPlanMd = vi.fn().mockResolvedValue('# Plan\n\n- Task 1');
    const readManifest = vi.fn().mockResolvedValue(JSON.stringify(manifest));
    const validatePlanTaskList = vi
      .fn()
      .mockReturnValue(
        options.structuralError
          ? { success: false, error: options.structuralError }
          : { success: true },
      );
    const signatureAnalyzer: SignatureReferenceAnalyzerPort = {
      analyze: vi.fn().mockResolvedValue([]),
    };

    return createDeterministicPlanCheck({
      readPlanMd,
      readManifest,
      validatePlanTaskList,
      signatureAnalyzer,
      forbiddenArtifactPaths: options.forbiddenArtifactPaths,
    } as unknown as Parameters<typeof createDeterministicPlanCheck>[0]);
  }

  it('rejects a task whose expected_files contain a forbidden artifact descendant', async () => {
    const check = makeCheck({
      forbiddenArtifactPaths: ['certification/'],
      tasks: [
        {
          n: 1,
          title: 'Run physical soak',
          expected_files: ['certification/transition-soak/result.json'],
        },
      ],
    });

    await expect(check(dummyCtx)).resolves.toMatchObject({
      diagnostic: expect.stringContaining(
        'forbidden path: certification/transition-soak/result.json',
      ),
    });
  });

  it('rejects a legacy files declaration under a forbidden artifact path', async () => {
    const check = makeCheck({
      forbiddenArtifactPaths: ['certification/'],
      tasks: [
        {
          n: 1,
          title: 'Run legacy soak',
          files: ['certification/legacy-run/output.log'],
        },
      ],
    });

    await expect(check(dummyCtx)).resolves.toMatchObject({
      diagnostic: expect.stringContaining('forbidden path: certification/legacy-run/output.log'),
    });
  });

  it('normalizes path separators without matching sibling prefixes', async () => {
    const siblingCheck = makeCheck({
      forbiddenArtifactPaths: ['certification/'],
      tasks: [
        {
          n: 1,
          title: 'Build certification tools',
          expected_files: ['certification-tools/build.ts'],
        },
      ],
    });

    await expect(siblingCheck(dummyCtx)).resolves.toMatchObject({
      diagnostic: null,
    });

    const backslashCheck = makeCheck({
      forbiddenArtifactPaths: ['certification/'],
      tasks: [
        {
          n: 1,
          title: 'Run backslash soak',
          expected_files: ['./certification\\transition-soak\\result.json'],
        },
      ],
    });

    await expect(backslashCheck(dummyCtx)).resolves.toMatchObject({
      diagnostic: expect.stringContaining('forbidden path:'),
    });
  });

  it('allows a harness-only task outside forbidden artifact paths', async () => {
    const check = makeCheck({
      forbiddenArtifactPaths: ['certification/'],
      tasks: [
        {
          n: 1,
          title: 'Build test harness',
          expected_files: ['scripts/run-transition-soak.ts'],
        },
      ],
    });

    await expect(check(dummyCtx)).resolves.toMatchObject({
      diagnostic: null,
    });
  });

  it('combines forbidden artifact diagnostics with existing deterministic diagnostics', async () => {
    const check = makeCheck({
      forbiddenArtifactPaths: ['certification/'],
      structuralError: 'task count mismatch between plan and manifest',
      tasks: [
        {
          n: 1,
          title: 'Run physical soak',
          expected_files: ['certification/transition-soak/result.json'],
        },
      ],
    });

    const result = await check(dummyCtx);
    expect(result.diagnostic).toContain('task count mismatch between plan and manifest');
    expect(result.diagnostic).toContain(
      'forbidden path: certification/transition-soak/result.json',
    );
  });
});
