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
import {
  recordValidationEvidence,
  computeWorktreeSourceFingerprint,
} from '../../phases/validation-evidence.js';

class MockPhaseHandler implements PhaseHandler {
  public runCalls: PhaseHandlerContext[] = [];
  constructor(
    public readonly phase: ReturnType<typeof PhaseName>,
    public handlerFn?: (ctx: PhaseHandlerContext) => Promise<PhaseResult>,
  ) {}

  async run(ctx: PhaseHandlerContext): Promise<PhaseResult> {
    this.runCalls.push(ctx);
    if (this.handlerFn) {
      return this.handlerFn(ctx);
    }
    return { outcome: 'passed' };
  }
}

describe('Validation Guarded Review (Issue #1109 Invariants)', () => {
  const setupExecutor = (policy: 'standard' | 'strict' = 'standard') => {
    const runRepo = new FakeRunRepository();
    const phaseRepo = new FakePhaseRepository();
    const failureRepo = new FakeFailureRepository();
    const registry = new PhaseHandlerRegistry();
    const artifacts = new FakeArtifactStore();
    const github = new FakeGitHubPort();
    const git = new FakeGitPort();
    const agent = new FakeAgentPort();

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

    registerHandler('read_issue', async (ctx) => {
      await artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'issue.md',
        contents: '# Issue 1109\nGoal: Require deterministic validation before review',
      });
      return { outcome: 'passed' };
    });

    registerHandler('plan-design', async (ctx) => {
      await artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'design.md',
        contents: '# Design',
      });
      await artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'plan.md',
        contents: '# Plan',
      });
      return { outcome: 'passed' };
    });

    registerHandler('implement', async (ctx) => {
      await artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'implementation-log.md',
        contents: '# Implementation Log',
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

    registerHandler('fix-review');
    registerHandler('follow-up-review');
    registerHandler('create-pr', async (ctx) => {
      await artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'pr-url.txt',
        contents: 'https://github.com/owner/repo/pull/1109',
      });
      return { outcome: 'passed' };
    });
    registerHandler('wait-merge', async () => ({ outcome: 'passed' }));

    const run: Run = {
      uuid: 'run-1109',
      displayId: '1109-1',
      jobId: 'job-1',
      repositoryId: 'repo-1',
      issueNumber: 1109,
      branch: 'ai/issue-1109',
      executionPolicy: policy,
      status: 'pending',
      completedPhases: [],
      skippedPhases: [],
      attempt: 1,
    };
    runRepo.addRun(run as never);

    git.currentBranchByCwd.set('/tmp/worktree', 'ai/issue-1109');
    git.headByCwd.set('/tmp/worktree', 'a'.repeat(40));

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
          repoFullName: 'owner/repo',
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

    return { run, runRepo, phaseRepo, failureRepo, artifacts, handlers, executor, git, agent };
  };

  it('computes worktree source fingerprint ignoring orchestrator artifacts', async () => {
    const git = new FakeGitPort();
    git.headByCwd.set('/tmp/worktree', 'a'.repeat(40));
    git.statusByCwd.set(
      '/tmp/worktree',
      ' M src/index.ts\n?? validation.result\n?? review-fix-plan.json\n?? pr-summary.md\n',
    );

    const fp1 = await computeWorktreeSourceFingerprint({ git, cwd: '/tmp/worktree' });

    // Adding more orchestrator artifacts should NOT change the fingerprint
    git.statusByCwd.set(
      '/tmp/worktree',
      ' M src/index.ts\n?? validation.result\n?? review-fix-plan.json\n?? pr-summary.md\n?? code-review.md\n',
    );
    const fp2 = await computeWorktreeSourceFingerprint({ git, cwd: '/tmp/worktree' });
    expect(fp2).toBe(fp1);

    // Mutating a source file MUST change the fingerprint
    git.statusByCwd.set(
      '/tmp/worktree',
      ' M src/index.ts\n M src/feature.ts\n?? validation.result\n',
    );
    const fp3 = await computeWorktreeSourceFingerprint({ git, cwd: '/tmp/worktree' });
    expect(fp3).not.toBe(fp1);
  });

  it('routes through fix-validate and revalidation when initial validation defers before initial-review', async () => {
    const { run, handlers, executor } = setupExecutor('standard');

    let validateAttempts = 0;
    handlers['validate']!.handlerFn = async (ctx) => {
      validateAttempts++;
      if (validateAttempts === 1) {
        return { outcome: 'deferred' };
      }
      await recordValidationEvidence(ctx, 'validate');
      return { outcome: 'passed' };
    };

    handlers['fix-validate']!.handlerFn = async () => ({ outcome: 'passed' });

    const result = await executor.execute({
      run,
      skip: [],
      presentArtifacts: [],
    });

    expect(result.run.status).toBe('passed');
    expect(handlers['validate']?.runCalls).toHaveLength(2); // initial validate + revalidation
    expect(handlers['fix-validate']?.runCalls).toHaveLength(1);
    expect(handlers['initial-review']?.runCalls).toHaveLength(1);
  });

  it('escalates to needs_human_review and does NOT invoke reviewer when initial validation repair fails', async () => {
    const { run, handlers, executor } = setupExecutor('standard');

    handlers['validate']!.handlerFn = async () => ({ outcome: 'deferred' });
    handlers['fix-validate']!.handlerFn = async (ctx) => ({
      outcome: 'needs_human_review',
      failure: {
        runUuid: ctx.runUuid,
        phase: 'fix-validate',
        kind: 'needs_human_review',
        message: 'fix-validate repair failed',
        canRetry: false,
        suggestedAction: 'Inspect logs',
        artifacts: [],
        detectedAt: ctx.now(),
      },
    });

    const result = await executor.execute({
      run,
      skip: [],
      presentArtifacts: [],
    });

    expect(result.run.status).toBe('needs_human_review');
    expect(handlers['validate']?.runCalls).toHaveLength(1);
    expect(handlers['fix-validate']?.runCalls).toHaveLength(1);
    expect(handlers['initial-review']?.runCalls).toHaveLength(0); // Reviewer never called!
  });

  it('invalidates prior validation evidence on fix-review and runs deterministic validation before follow-up review', async () => {
    const { run, handlers, artifacts, executor } = setupExecutor('standard');

    handlers['initial-review']!.handlerFn = async (ctx) => {
      await artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'whole-change-review.json',
        contents: JSON.stringify({ verdict: 'REQUEST_CHANGES' }),
      });
      const ledger = createFindingLedger([
        {
          severity: 'high',
          files: ['src/index.ts'],
          evidence: 'Missing check',
          rationale: 'NPE risk',
          minimal_correction: 'Add check',
        },
      ]);
      await artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'finding-ledger.json',
        contents: JSON.stringify(ledger),
      });
      return { outcome: 'passed' };
    };

    handlers['fix-review']!.handlerFn = async () => {
      // Fix-review finishes
      return { outcome: 'passed' };
    };

    let validationCallCount = 0;
    handlers['validate']!.handlerFn = async (ctx) => {
      validationCallCount++;
      await recordValidationEvidence(ctx, 'validate');
      return { outcome: 'passed' };
    };

    handlers['follow-up-review']!.handlerFn = async (ctx) => {
      // Follow-up review approves
      await artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'follow-up-review.json',
        contents: JSON.stringify({ verdict: 'APPROVE', evaluations: [], new_findings: [] }),
      });
      const resolvedLedger = createFindingLedger([
        {
          severity: 'high',
          files: ['src/index.ts'],
          evidence: 'Missing check',
          rationale: 'NPE risk',
          minimal_correction: 'Add check',
        },
      ]);
      resolvedLedger.entries[0]!.status = 'resolved';
      await artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'finding-ledger.json',
        contents: JSON.stringify(resolvedLedger),
      });
      return { outcome: 'passed' };
    };

    const result = await executor.execute({
      run,
      skip: [],
      presentArtifacts: [],
    });

    expect(result.run.status).toBe('passed');
    // Validate ran twice: once before initial-review, once after fix-review before follow-up-review
    expect(validationCallCount).toBe(2);
    expect(handlers['fix-review']?.runCalls).toHaveLength(1);
    expect(handlers['follow-up-review']?.runCalls).toHaveLength(1);
    expect(handlers['create-pr']?.runCalls).toHaveLength(1);
  });

  it('routes to fix-validate when validation fails after fix-review and resumes follow-up review after repair', async () => {
    const { run, handlers, artifacts, executor } = setupExecutor('standard');

    handlers['initial-review']!.handlerFn = async (ctx) => {
      await artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'whole-change-review.json',
        contents: JSON.stringify({ verdict: 'REQUEST_CHANGES' }),
      });
      const ledger = createFindingLedger([
        {
          severity: 'high',
          files: ['src/index.ts'],
          evidence: 'Error handling bug',
          rationale: 'Crash',
          minimal_correction: 'Add try-catch',
        },
      ]);
      await artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'finding-ledger.json',
        contents: JSON.stringify(ledger),
      });
      return { outcome: 'passed' };
    };

    let validationCallCount = 0;
    handlers['validate']!.handlerFn = async (ctx) => {
      validationCallCount++;
      if (validationCallCount === 1) {
        // Initial validation passes
        await recordValidationEvidence(ctx, 'validate');
        return { outcome: 'passed' };
      }
      if (validationCallCount === 2) {
        // Post-fix-review validation fails
        return { outcome: 'deferred' };
      }
      // Revalidation after fix-validate passes
      await recordValidationEvidence(ctx, 'validate');
      return { outcome: 'passed' };
    };

    handlers['fix-validate']!.handlerFn = async () => ({ outcome: 'passed' });

    handlers['follow-up-review']!.handlerFn = async (ctx) => {
      await artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'follow-up-review.json',
        contents: JSON.stringify({ verdict: 'APPROVE', evaluations: [], new_findings: [] }),
      });
      const ledgerRaw = await artifacts.read(ctx.runUuid, 'finding-ledger.json');
      const ledger = JSON.parse(ledgerRaw);
      // Finding ledger history is still intact!
      expect(ledger.entries).toHaveLength(1);
      ledger.entries[0].status = 'resolved';
      await artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'finding-ledger.json',
        contents: JSON.stringify(ledger),
      });
      return { outcome: 'passed' };
    };

    const result = await executor.execute({
      run,
      skip: [],
      presentArtifacts: [],
    });

    expect(result.run.status).toBe('passed');
    expect(validationCallCount).toBe(3); // Initial + Post-fix-fail + Revalidation
    expect(handlers['fix-validate']?.runCalls).toHaveLength(1);
    expect(handlers['follow-up-review']?.runCalls).toHaveLength(1);
    expect(handlers['create-pr']?.runCalls).toHaveLength(1);
  });

  it('escalates to needs_human_review when persistent validation failure occurs after review fix without invoking follow-up reviewer', async () => {
    const { run, handlers, artifacts, executor } = setupExecutor('standard');

    handlers['initial-review']!.handlerFn = async (ctx) => {
      await artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'whole-change-review.json',
        contents: JSON.stringify({ verdict: 'REQUEST_CHANGES' }),
      });
      const ledger = createFindingLedger([
        {
          severity: 'high',
          files: ['src/index.ts'],
          evidence: 'Bug',
          rationale: 'Risk',
          minimal_correction: 'Fix',
        },
      ]);
      await artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'finding-ledger.json',
        contents: JSON.stringify(ledger),
      });
      return { outcome: 'passed' };
    };

    let validationCallCount = 0;
    handlers['validate']!.handlerFn = async (ctx) => {
      validationCallCount++;
      if (validationCallCount === 1) {
        // Initial validation passes
        await recordValidationEvidence(ctx, 'validate');
        return { outcome: 'passed' };
      }
      // Post-fix-review validation and revalidation fail
      return { outcome: 'deferred' };
    };

    handlers['fix-validate']!.handlerFn = async () => ({ outcome: 'passed' });

    const result = await executor.execute({
      run,
      skip: [],
      presentArtifacts: [],
    });

    expect(result.run.status).toBe('needs_human_review');
    expect(handlers['follow-up-review']?.runCalls).toHaveLength(0); // Reviewer NEVER invoked!
  });
});
