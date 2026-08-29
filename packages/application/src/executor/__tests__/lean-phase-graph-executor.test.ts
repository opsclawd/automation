import { describe, it, expect, vi } from 'vitest';
import { PhaseName, type Run } from '@ai-sdlc/domain';
import { RunExecutor } from '../run-executor.js';
import { PhaseHandlerRegistry } from '../phase-handler-registry.js';
import {
  FakeRunRepository,
  FakePhaseRepository,
  FakeFailureRepository,
  FakeArtifactStore,
  FakeGitHubPort,
  FakeGitPort,
  FakeAgentPort,
} from '../../test-doubles/index.js';
import type { PhaseHandler, PhaseHandlerContext, PhaseResult } from '../../phases/handler.js';
import { createFindingLedger } from '../../review-fix/finding-ledger.js';
import { recordValidationEvidence } from '../../phases/validation-evidence.js';

class MockPhaseHandler implements PhaseHandler {
  public runCalls: PhaseHandlerContext[] = [];

  constructor(
    readonly phase: PhaseName,
    public handlerFn: (ctx: PhaseHandlerContext) => Promise<PhaseResult> = async () => ({
      outcome: 'passed',
    }),
  ) {}

  async run(ctx: PhaseHandlerContext): Promise<PhaseResult> {
    this.runCalls.push(ctx);
    return this.handlerFn(ctx);
  }
}

describe('Lean Phase Graph in RunExecutor (Issue #1106)', () => {
  const setupExecutor = (policy: 'standard' | 'strict' | 'legacy' = 'standard') => {
    const runRepo = new FakeRunRepository();
    const phaseRepo = new FakePhaseRepository();
    const failureRepo = new FakeFailureRepository();
    const artifacts = new FakeArtifactStore();
    const github = new FakeGitHubPort();
    const git = new FakeGitPort();
    const agent = new FakeAgentPort();
    const registry = new PhaseHandlerRegistry();

    const handlers: Record<string, MockPhaseHandler> = {};
    const registerHandler = (
      name: string,
      fn?: (ctx: PhaseHandlerContext) => Promise<PhaseResult>,
    ) => {
      const handler = new MockPhaseHandler(PhaseName(name), fn);
      handlers[name] = handler;
      registry.register(handler);
      return handler;
    };

    // Register all lean & legacy handlers
    registerHandler('read_issue', async (ctx) => {
      await artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'issue.md',
        contents: '# Issue 1106',
      });
      return { outcome: 'passed' };
    });
    registerHandler('plan-design', async (ctx) => {
      await artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'design.md',
        contents: '# Design',
      });
      await artifacts.write({ runId: ctx.runUuid, relativePath: 'plan.md', contents: '# Plan' });
      return { outcome: 'passed' };
    });
    registerHandler('plan-write');
    registerHandler('plan-review');
    registerHandler('implement', async (ctx) => {
      await artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'implementation-log.md',
        contents: '# Impl',
      });
      return { outcome: 'passed' };
    });
    registerHandler('validate', async (ctx) => {
      await recordValidationEvidence(ctx, 'validate');
      return { outcome: 'passed' };
    });
    registerHandler('fix-validate');
    registerHandler('initial-review', async (ctx) => {
      await artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'whole-change-review.json',
        contents: JSON.stringify({ verdict: 'APPROVE', acceptance_criteria: [], findings: [] }),
      });
      await artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'code-review.md',
        contents: '# Review\nLGTM',
      });
      return { outcome: 'passed' };
    });
    registerHandler('review-fix');
    registerHandler('fix-review');
    registerHandler('follow-up-review');
    registerHandler('compound');
    registerHandler('create-pr', async (ctx) => {
      await artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'pr-url.txt',
        contents: 'https://github.com/o/r/pull/1',
      });
      return { outcome: 'passed' };
    });
    registerHandler('wait-merge', async () => ({ outcome: 'passed' }));
    registerHandler('post-pr-review', async () => ({ outcome: 'passed' }));

    const run: Run = {
      uuid: 'run-1106',
      displayId: '1106-1',
      jobId: 'job-1',
      repositoryId: 'repo-1',
      issueNumber: 1106,
      branch: 'ai/issue-1106',
      executionPolicy: policy,
      status: 'pending',
      completedPhases: [],
      skippedPhases: [],
      attempt: 1,
    };
    runRepo.addRun(run as never);

    const executor = new RunExecutor({
      runRepository: runRepo,
      phaseRepository: phaseRepo,
      failureRepository: failureRepo,
      events: { publish: vi.fn() },
      registry,
      contextFactory: (r) =>
        ({
          runId: r.uuid,
          runUuid: r.uuid,
          issueNumber: r.issueNumber,
          repoFullName: 'o/r',
          cwd: '/tmp/worktree',
          executionPolicy: r.executionPolicy,
          artifacts,
          github,
          git,
          agent,
          events: { publish: vi.fn() },
          now: () => new Date(),
          resolveProfile: () => 'opencode-frontier',
        }) as unknown as PhaseHandlerContext,
    });

    git.headByCwd.set('/tmp/worktree', '0'.repeat(40));

    return { run, runRepo, phaseRepo, artifacts, handlers, executor, git, agent };
  };

  it('fresh standard run executes only lean lifecycle phases', async () => {
    const { run, handlers, executor } = setupExecutor('standard');

    const result = await executor.execute({
      run,
      skip: [],
      presentArtifacts: [],
    });

    expect(result.run.status).toBe('passed');

    // Executed lean phases
    expect(handlers['read_issue']?.runCalls).toHaveLength(1);
    expect(handlers['plan-design']?.runCalls).toHaveLength(1);
    expect(handlers['implement']?.runCalls).toHaveLength(1);
    expect(handlers['validate']?.runCalls).toHaveLength(1);
    expect(handlers['initial-review']?.runCalls).toHaveLength(1);
    expect(handlers['create-pr']?.runCalls).toHaveLength(1);
    expect(handlers['wait-merge']?.runCalls).toHaveLength(1);

    // NEVER executed legacy-only phases
    expect(handlers['plan-write']?.runCalls).toHaveLength(0);
    expect(handlers['plan-review']?.runCalls).toHaveLength(0);
    expect(handlers['compound']?.runCalls).toHaveLength(0);
    expect(handlers['post-pr-review']?.runCalls).toHaveLength(0);
  });

  it('repairs deterministic validation failure with bounded fix-validate attempt', async () => {
    const { run, handlers, artifacts, executor } = setupExecutor('standard');

    let validateAttempts = 0;
    handlers['validate']!.handlerFn = async (ctx) => {
      validateAttempts++;
      if (validateAttempts === 1) {
        await artifacts.write({
          runId: ctx.runUuid,
          relativePath: 'validate/failure.json',
          contents: '{"error": "type error"}',
        });
        return { outcome: 'deferred' };
      }
      await artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'validation.result',
        contents: 'passed',
      });
      return { outcome: 'passed' };
    };

    handlers['fix-validate']!.handlerFn = async () => {
      return { outcome: 'passed' };
    };

    const result = await executor.execute({
      run,
      skip: [],
      presentArtifacts: [],
    });

    expect(result.run.status).toBe('passed');
    expect(validateAttempts).toBe(2); // initial validate + revalidation
    expect(handlers['fix-validate']?.runCalls).toHaveLength(1);
    expect(handlers['initial-review']?.runCalls).toHaveLength(1);
  });

  it('escalates to needs_human_review when revalidation fails after fix-validate', async () => {
    const { run, handlers, artifacts, executor } = setupExecutor('standard');

    handlers['validate']!.handlerFn = async (ctx) => {
      await artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'validate/failure.json',
        contents: '{"error": "persistent type error"}',
      });
      return { outcome: 'deferred' };
    };

    handlers['fix-validate']!.handlerFn = async () => ({ outcome: 'passed' });

    const result = await executor.execute({
      run,
      skip: [],
      presentArtifacts: [],
    });

    expect(result.run.status).toBe('needs_human_review');
    expect(handlers['fix-validate']?.runCalls).toHaveLength(1);
    expect(handlers['initial-review']?.runCalls).toHaveLength(0); // Did not proceed to review
  });

  it('converges review via fix-review and follow-up-review when initial review requests changes', async () => {
    const { run, handlers, artifacts, executor } = setupExecutor('standard');

    // Initial review requests changes
    handlers['initial-review']!.handlerFn = async (ctx) => {
      const ledger = createFindingLedger([
        {
          severity: 'high',
          files: ['src/app.ts'],
          evidence: 'bug',
          rationale: 'risk',
          minimal_correction: 'fix',
        },
      ]);
      await artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'finding-ledger.json',
        contents: JSON.stringify(ledger),
      });
      await artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'whole-change-review.json',
        contents: JSON.stringify({ verdict: 'REQUEST_CHANGES', findings: ledger.entries }),
      });
      await artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'code-review.md',
        contents: '# Review\nChanges requested',
      });
      return { outcome: 'passed' };
    };

    handlers['fix-review']!.handlerFn = async () => ({ outcome: 'passed' });

    // Follow-up review approves
    handlers['follow-up-review']!.handlerFn = async (ctx) => {
      await artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'follow-up-review.json',
        contents: JSON.stringify({ verdict: 'APPROVE', evaluations: [], new_findings: [] }),
      });
      await artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'finding-ledger.json',
        contents: JSON.stringify({ version: 1, iterationCount: 1, entries: [] }),
      });
      return { outcome: 'passed' };
    };

    const result = await executor.execute({
      run,
      skip: [],
      presentArtifacts: [],
    });

    expect(result.run.status).toBe('passed');
    expect(handlers['initial-review']?.runCalls).toHaveLength(1);
    expect(handlers['fix-review']?.runCalls).toHaveLength(1);
    expect(handlers['follow-up-review']?.runCalls).toHaveLength(1);
    expect(handlers['create-pr']?.runCalls).toHaveLength(1);
    expect(handlers['wait-merge']?.runCalls).toHaveLength(1);
  });

  it('resumes correctly from each lean phase boundary', async () => {
    const { run, runRepo, handlers, executor, git, artifacts } = setupExecutor('standard');

    const fakeCtx = {
      runUuid: run.uuid,
      artifacts,
      git,
      cwd: '/tmp/worktree',
    } as unknown as PhaseHandlerContext;
    await recordValidationEvidence(fakeCtx, 'validate');

    // Simulate run that already completed read_issue, plan-design, implement, validate
    run.completedPhases = ['read_issue', 'plan-design', 'implement', 'validate'];
    runRepo.update(run.uuid, { completedPhases: run.completedPhases });

    const result = await executor.execute({
      run,
      skip: [],
      presentArtifacts: [
        'issue.md',
        'design.md',
        'plan.md',
        'implementation-log.md',
        'validation.result',
      ],
    });

    expect(result.run.status).toBe('passed');
    // Skipped prior completed phases
    expect(handlers['read_issue']?.runCalls).toHaveLength(0);
    expect(handlers['plan-design']?.runCalls).toHaveLength(0);
    expect(handlers['implement']?.runCalls).toHaveLength(0);
    expect(handlers['validate']?.runCalls).toHaveLength(0);

    // Ran subsequent lean phases
    expect(handlers['initial-review']?.runCalls).toHaveLength(1);
    expect(handlers['create-pr']?.runCalls).toHaveLength(1);
    expect(handlers['wait-merge']?.runCalls).toHaveLength(1);
  });

  it('resumes review cycle after fix-review without repeating fix-review mutation', async () => {
    const { run, runRepo, handlers, artifacts, executor, git } = setupExecutor('standard');

    const fakeCtx = {
      runUuid: run.uuid,
      artifacts,
      git,
      cwd: '/tmp/worktree',
    } as unknown as PhaseHandlerContext;
    await recordValidationEvidence(fakeCtx, 'validate');

    run.completedPhases = ['read_issue', 'plan-design', 'implement', 'validate', 'initial-review'];
    runRepo.update(run.uuid, { completedPhases: run.completedPhases });

    // Persist review convergence state indicating fix-review completed in iteration 1
    await artifacts.write({
      runId: run.uuid,
      relativePath: 'review-convergence.json',
      contents: JSON.stringify({
        iteration: 1,
        subStep: 'validate',
        verdict: 'REQUEST_CHANGES',
      }),
    });

    handlers['follow-up-review']!.handlerFn = async (ctx) => {
      await artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'follow-up-review.json',
        contents: JSON.stringify({ verdict: 'APPROVE', evaluations: [], new_findings: [] }),
      });
      return { outcome: 'passed' };
    };

    const result = await executor.execute({
      run,
      skip: [],
      presentArtifacts: ['review-convergence.json'],
    });

    expect(result.run.status).toBe('passed');
    // Did NOT rerun initial-review or fix-review!
    expect(handlers['initial-review']?.runCalls).toHaveLength(0);
    expect(handlers['fix-review']?.runCalls).toHaveLength(0);
    // Proceeded to validate, follow-up-review, create-pr, wait-merge
    expect(handlers['validate']?.runCalls).toHaveLength(1);
    expect(handlers['follow-up-review']?.runCalls).toHaveLength(1);
    expect(handlers['create-pr']?.runCalls).toHaveLength(1);
  });

  it('resumes review cycle at follow-up-review after validation completes', async () => {
    const { run, runRepo, handlers, artifacts, executor, git } = setupExecutor('standard');

    const fakeCtx = {
      runUuid: run.uuid,
      artifacts,
      git,
      cwd: '/tmp/worktree',
    } as unknown as PhaseHandlerContext;
    await recordValidationEvidence(fakeCtx, 'validate');

    run.completedPhases = ['read_issue', 'plan-design', 'implement', 'validate', 'initial-review'];
    runRepo.update(run.uuid, { completedPhases: run.completedPhases });

    await artifacts.write({
      runId: run.uuid,
      relativePath: 'review-convergence.json',
      contents: JSON.stringify({
        iteration: 1,
        subStep: 'follow-up-review',
        verdict: 'REQUEST_CHANGES',
      }),
    });

    handlers['follow-up-review']!.handlerFn = async (ctx) => {
      await artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'follow-up-review.json',
        contents: JSON.stringify({ verdict: 'APPROVE', evaluations: [], new_findings: [] }),
      });
      return { outcome: 'passed' };
    };

    const result = await executor.execute({
      run,
      skip: [],
      presentArtifacts: ['review-convergence.json'],
    });

    expect(result.run.status).toBe('passed');
    expect(handlers['initial-review']?.runCalls).toHaveLength(0);
    expect(handlers['fix-review']?.runCalls).toHaveLength(0);
    expect(handlers['validate']?.runCalls).toHaveLength(0);
    expect(handlers['follow-up-review']?.runCalls).toHaveLength(1);
  });

  it('honors configured reviewConvergenceMaxIterations override', async () => {
    const { run, handlers, artifacts, executor } = setupExecutor('standard');

    handlers['initial-review']!.handlerFn = async (ctx) => {
      await artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'whole-change-review.json',
        contents: JSON.stringify({ verdict: 'REQUEST_CHANGES', findings: [{ severity: 'high' }] }),
      });
      return { outcome: 'passed' };
    };

    handlers['fix-review']!.handlerFn = async () => ({ outcome: 'passed' });

    // Follow-up review always requests changes
    handlers['follow-up-review']!.handlerFn = async (ctx) => {
      await artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'follow-up-review.json',
        contents: JSON.stringify({ verdict: 'REQUEST_CHANGES', evaluations: [], new_findings: [] }),
      });
      return { outcome: 'passed' };
    };

    // Override bound to 2 iterations
    const result = await executor.execute({
      run,
      skip: [],
      presentArtifacts: [],
      reviewConvergenceMaxIterations: 2,
    });

    expect(result.run.status).toBe('needs_human_review');
    expect(handlers['fix-review']?.runCalls).toHaveLength(2);
    expect(handlers['follow-up-review']?.runCalls).toHaveLength(2);
  });

  it('escalates to human review and does not default to APPROVE when review artifacts are unreadable', async () => {
    const { run, handlers, executor } = setupExecutor('standard');

    // Handler returns passed but writes invalid/empty review artifacts
    handlers['initial-review']!.handlerFn = async () => ({ outcome: 'passed' });

    const result = await executor.execute({
      run,
      skip: [],
      presentArtifacts: [],
    });

    expect(result.run.status).toBe('needs_human_review');
    expect(handlers['create-pr']?.runCalls).toHaveLength(0);
  });

  it('converges across multiple review/fix iterations before approval', async () => {
    const { run, handlers, artifacts, executor } = setupExecutor('standard');

    // Initial review requests changes
    handlers['initial-review']!.handlerFn = async (ctx) => {
      const ledger = createFindingLedger([
        {
          severity: 'high',
          files: ['src/app.ts'],
          evidence: 'bug 1',
          rationale: 'risk 1',
          minimal_correction: 'fix 1',
        },
        {
          severity: 'high',
          files: ['src/db.ts'],
          evidence: 'bug 2',
          rationale: 'risk 2',
          minimal_correction: 'fix 2',
        },
      ]);
      await artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'finding-ledger.json',
        contents: JSON.stringify(ledger),
      });
      await artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'whole-change-review.json',
        contents: JSON.stringify({ verdict: 'REQUEST_CHANGES', findings: ledger.entries }),
      });
      return { outcome: 'passed' };
    };

    handlers['fix-review']!.handlerFn = async () => ({ outcome: 'passed' });

    let followUpCount = 0;
    handlers['follow-up-review']!.handlerFn = async (ctx) => {
      followUpCount++;
      if (followUpCount === 1) {
        // Iteration 1: Still requests changes
        await artifacts.write({
          runId: ctx.runUuid,
          relativePath: 'follow-up-review.json',
          contents: JSON.stringify({
            verdict: 'REQUEST_CHANGES',
            evaluations: [{ finding_id: 'AC-1', resolved: true, evidence: 'fixed' }],
            new_findings: [],
          }),
        });
        return { outcome: 'passed' };
      }
      // Iteration 2: Approves
      await artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'follow-up-review.json',
        contents: JSON.stringify({ verdict: 'APPROVE', evaluations: [], new_findings: [] }),
      });
      await artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'finding-ledger.json',
        contents: JSON.stringify({ version: 1, iterationCount: 2, entries: [] }),
      });
      return { outcome: 'passed' };
    };

    const result = await executor.execute({
      run,
      skip: [],
      presentArtifacts: [],
    });

    expect(result.run.status).toBe('passed');
    expect(handlers['initial-review']?.runCalls).toHaveLength(1);
    expect(handlers['fix-review']?.runCalls).toHaveLength(2);
    expect(handlers['follow-up-review']?.runCalls).toHaveLength(2);
    expect(handlers['create-pr']?.runCalls).toHaveLength(1);
  });

  it('stops and escalates to needs_human_review immediately when fixer reports cannot_fix', async () => {
    const { run, handlers, artifacts, executor } = setupExecutor('standard');

    handlers['initial-review']!.handlerFn = async (ctx) => {
      await artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'whole-change-review.json',
        contents: JSON.stringify({ verdict: 'REQUEST_CHANGES', findings: [{ severity: 'high' }] }),
      });
      return { outcome: 'passed' };
    };

    handlers['fix-review']!.handlerFn = async () => {
      return {
        outcome: 'needs_human_review',
        failure: {
          runUuid: run.uuid,
          phase: 'fix-review',
          kind: 'needs_human_review',
          message: 'targeted fixer reported it cannot fix the review findings',
          canRetry: true,
          suggestedAction: 'Intervene manually',
          artifacts: [],
          detectedAt: new Date(),
        },
      };
    };

    const result = await executor.execute({
      run,
      skip: [],
      presentArtifacts: [],
    });

    expect(result.run.status).toBe('needs_human_review');
    expect(handlers['fix-review']?.runCalls).toHaveLength(1);
    expect(handlers['follow-up-review']?.runCalls).toHaveLength(0); // Did not proceed to follow-up review!
  });

  it('does not create PR and continues convergence when follow-up review artifact says APPROVE but ledger has unresolved findings', async () => {
    const { run, handlers, artifacts, executor } = setupExecutor('standard');

    // Initial review requests changes
    handlers['initial-review']!.handlerFn = async (ctx) => {
      const ledger = createFindingLedger([
        {
          severity: 'high',
          files: ['src/app.ts'],
          evidence: 'unresolved bug',
          rationale: 'risk',
          minimal_correction: 'fix',
        },
      ]);
      await artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'finding-ledger.json',
        contents: JSON.stringify(ledger),
      });
      await artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'whole-change-review.json',
        contents: JSON.stringify({ verdict: 'REQUEST_CHANGES', findings: ledger.entries }),
      });
      return { outcome: 'passed' };
    };

    handlers['fix-review']!.handlerFn = async () => ({ outcome: 'passed' });

    // Follow-up handler simulates a defect where follow-up-review.json says APPROVE, but finding-ledger.json still has unresolved findings
    handlers['follow-up-review']!.handlerFn = async (ctx) => {
      await artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'follow-up-review.json',
        contents: JSON.stringify({ verdict: 'APPROVE', evaluations: [], new_findings: [] }),
      });
      // finding-ledger.json is NOT resolved
      return { outcome: 'passed' };
    };

    const result = await executor.execute({
      run,
      skip: [],
      presentArtifacts: [],
      reviewConvergenceMaxIterations: 1,
    });

    // Because the ledger was unresolved, RunExecutor overrides APPROVE to REQUEST_CHANGES and hits maxIterations (1) -> needs_human_review
    expect(result.run.status).toBe('needs_human_review');
    expect(handlers['create-pr']?.runCalls).toHaveLength(0);
  });

  it('executes legacy canonical phases when executionPolicy is legacy', async () => {
    const { run, handlers, executor } = setupExecutor('legacy');

    const result = await executor.execute({
      run,
      skip: [],
      presentArtifacts: [],
    });

    expect(result.run.status).toBe('passed');
    // Legacy runs execute canonical phase order
    expect(handlers['plan-write']?.runCalls).toHaveLength(1);
    expect(handlers['plan-review']?.runCalls).toHaveLength(1);
    expect(handlers['compound']?.runCalls).toHaveLength(1);
    expect(handlers['post-pr-review']?.runCalls).toHaveLength(1);
  });
});
