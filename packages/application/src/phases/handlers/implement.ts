import { PhaseName } from '@ai-sdlc/domain';
import type { FailureKind, Failure, Step, RunId } from '@ai-sdlc/domain';
import type { PhaseHandler, PhaseHandlerContext, PhaseResult, EventEmitter } from '../handler.js';
import type { StepRepositoryPort } from '../../ports/step-repository-port.js';
import { createEventEmitter } from '../handler.js';
import { ArtifactNotFoundError } from '../../ports/artifact-store.js';
import {
  uncommittedSourcePaths,
  formatDirtyPaths,
  orchestratorExcludePatterns,
} from '../../artifacts/orchestrator-artifacts.js';
import { normalizeTaskPath } from '../../task-file-boundaries.js';
import { runSingleShotAgentPhase } from './run-single-shot-agent-phase.js';
import { loadPromptTemplate } from '../../prompts/load-prompt-template.js';

export interface ImplementHandlerOpts {
  steps: StepRepositoryPort;
  setup?: (cwd: string) => Promise<{ ok: boolean; error?: string }>;
}

export class ImplementHandler implements PhaseHandler {
  readonly phase = PhaseName('implement');

  constructor(private readonly opts: ImplementHandlerOpts) {}

  async run(ctx: PhaseHandlerContext): Promise<PhaseResult> {
    const emit = createEventEmitter(ctx, this.phase);
    emit('implement.started', 'info', 'implement started');

    const inboundDirty = await this.checkInboundWorktreeCleanliness(ctx, emit);
    if (inboundDirty !== undefined) {
      return inboundDirty;
    }

    const planMd = await this.readPlan(ctx, emit);
    if (typeof planMd !== 'string') return planMd;

    return this.runLean(ctx, emit, planMd);
  }

  private async runLean(
    ctx: PhaseHandlerContext,
    emit: EventEmitter,
    _planMd: string,
  ): Promise<PhaseResult> {
    // 1. Resume / idempotency check
    const existing = this.opts.steps.listForRun(ctx.runUuid as RunId);
    const implementSteps = existing.filter((s) => s.phaseId === 'implement');
    const isAlreadyComplete =
      implementSteps.length > 0 && implementSteps.every((s) => s.status === 'success');
    if (isAlreadyComplete) {
      try {
        const implLog = await ctx.artifacts.read(ctx.runUuid, 'implementation-log.md');
        if (implLog.trim().length > 0) {
          emit(
            'step.skipped',
            'info',
            'step 1/1 already complete (reusing existing implementation)',
            {
              index: 1,
              total: 1,
              policy: ctx.executionPolicy,
            },
          );
          emit(
            'implement.completed',
            'info',
            'implement complete (reusing existing implementation)',
            {
              policy: ctx.executionPolicy,
            },
          );
          return { outcome: 'passed' };
        }
      } catch {
        // If implementation-log.md artifact is missing, proceed with implementation
      }
    }

    // 2. Worktree setup
    if (this.opts.setup) {
      try {
        const result = await this.opts.setup(ctx.cwd);
        if (!result.ok) {
          return this.fail(ctx, emit, 'setup_failed', result.error ?? 'setup failed');
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return this.fail(ctx, emit, 'setup_failed', `setup crashed: ${message}`);
      }
    }

    // 3. Capture baseline pre-implementation commit SHA
    let preStepHead: string;
    try {
      if (!ctx.git?.headCommitSha) {
        throw new Error('ctx.git.headCommitSha is not available');
      }
      preStepHead = await ctx.git.headCommitSha(ctx.cwd);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return this.fail(ctx, emit, 'unknown', `failed baseline commit query: ${message}`);
    }

    // 4. Initialize step in step repository
    const startedAt = ctx.now();
    const existingStep = this.opts.steps.findByIndex(ctx.runUuid as RunId, this.phase, 1);
    const step: Step = {
      id: existingStep?.id ?? ctx.idFactory?.() ?? `${ctx.runUuid}:implement:1`,
      runId: ctx.runUuid,
      phaseId: this.phase,
      index: 1,
      title: 'Implement issue',
      status: 'running',
      startedAt,
      initialPreStepHead: preStepHead,
      revertCounts: {},
    };
    this.opts.steps.upsert(step);
    emit('step.started', 'info', 'step 1/1: Implement issue', {
      index: 1,
      total: 1,
      policy: ctx.executionPolicy,
    });

    // 5. Resolve profile
    if (!ctx.resolveProfile) {
      const failure: Failure = {
        runUuid: ctx.runUuid,
        phase: 'implement',
        kind: 'command_failed',
        message: 'resolveProfile not available on context',
        canRetry: false,
        suggestedAction: 'Ensure context is built with resolveProfile in the compose root.',
        artifacts: [],
        detectedAt: ctx.now(),
      };
      this.opts.steps.upsert({ ...step, status: 'failed', completedAt: ctx.now() });
      emit('step.failed', 'error', failure.message, { index: 1, total: 1 });
      emit('implement.failed', 'error', failure.message);
      return { outcome: 'failed', failure };
    }

    const profile = ctx.resolveProfile(this.phase);
    if (!profile) {
      const failure: Failure = {
        runUuid: ctx.runUuid,
        phase: 'implement',
        kind: 'command_failed',
        message: `resolveProfile returned empty for phase '${this.phase}'`,
        canRetry: false,
        suggestedAction: 'Ensure the phase profile is configured in the compose root.',
        artifacts: [],
        detectedAt: ctx.now(),
      };
      this.opts.steps.upsert({ ...step, status: 'failed', completedAt: ctx.now() });
      emit('step.failed', 'error', failure.message, { index: 1, total: 1 });
      emit('implement.failed', 'error', failure.message);
      return { outcome: 'failed', failure };
    }

    // 6. Load prompt template
    let template: string | undefined;
    if (ctx.promptsRoot) {
      try {
        template = loadPromptTemplate('implement', 'implement', {
          promptsRoot: ctx.promptsRoot,
        });
      } catch {
        try {
          template = loadPromptTemplate('implement', 'task', {
            promptsRoot: ctx.promptsRoot,
          });
        } catch {
          // Handled by runSingleShotAgentPhase
        }
      }
    }

    // 7. Invoke agent single-shot
    const runResult = await runSingleShotAgentPhase(ctx, {
      phase: this.phase,
      profile,
      step: 'implement',
      ...(template ? { template } : {}),
      vars: { issue_number: String(ctx.issueNumber), cwd: ctx.cwd },
      agentContract: {
        requiredArtifacts: ['implementation-log.md'],
        mustNotChangeBranch: true,
        mustNotCreateCommit: true,
      },
      skipResultExtraction: true,
    });

    if (runResult.outcome !== 'passed') {
      this.opts.steps.upsert({ ...step, status: 'failed', completedAt: ctx.now() });
      emit('step.failed', 'error', `step 1/1 failed`, { index: 1, total: 1 });
      return runResult;
    }

    this.opts.steps.upsert({ ...step, status: 'success', completedAt: ctx.now() });
    emit('step.completed', 'info', 'step 1/1 done', {
      index: 1,
      total: 1,
      policy: ctx.executionPolicy,
    });
    emit('implement.completed', 'info', 'implement complete', { policy: ctx.executionPolicy });
    return { outcome: 'passed' };
  }

  private async checkInboundWorktreeCleanliness(
    ctx: PhaseHandlerContext,
    emit: EventEmitter,
  ): Promise<PhaseResult | undefined> {
    const preserveAllowance = ctx.inboundPreserveAllowance ?? ctx.approvedInboundPaths;

    if (ctx.priorPhaseName === undefined && preserveAllowance === undefined) {
      return undefined;
    }

    let implicitPreserved: string[] = [];

    // When preserveAllowance is undefined, inspect worktree lifecycle to identify implicitly preserved paths
    if (preserveAllowance === undefined && ctx.worktreeLifecycle) {
      try {
        const plan = await ctx.worktreeLifecycle.inspect({
          cwd: ctx.cwd,
          mode: 'phase_boundary',
          preservedPatterns: orchestratorExcludePatterns(),
        });
        implicitPreserved = plan.preservedPaths;

        // When entering from plan-review without a preserve allowance, perform audited ambient cleanup
        if (
          ctx.priorPhaseName === 'plan-review' &&
          ctx.eventRepository &&
          (plan.discardedPaths.length > 0 || plan.trackedChanges.length > 0)
        ) {
          const message =
            plan.discardedPaths.length > 0
              ? `implement reset ambient worktree residue from ${ctx.priorPhaseName}: discarded ${plan.discardedPaths.join(', ')}`
              : `implement reset ambient worktree residue from ${ctx.priorPhaseName}: unstaged tracked changes`;
          const metadata = {
            reason: 'implement_inbound',
            priorPhaseName: ctx.priorPhaseName,
            discardedPaths: plan.discardedPaths,
            preservedPaths: plan.preservedPaths,
          };

          // Synchronously insert audit event BEFORE mutating Git state
          ctx.eventRepository.insert({
            runUuid: ctx.runUuid,
            phase: 'implement',
            level: 'info',
            type: 'implement.inbound_worktree_reset',
            message,
            metadata,
            timestamp: ctx.now(),
          });

          // Emit to event bus
          emit('implement.inbound_worktree_reset', 'info', message, metadata);

          // Execute the exact inspected plan
          await ctx.worktreeLifecycle.execute({ plan });
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        emit(
          'implement.phase_boundary_violation',
          'error',
          `inbound worktree reset failed: ${message}`,
          {
            priorPhaseName: ctx.priorPhaseName,
            error: message,
          },
        );
        return this.fail(
          ctx,
          emit,
          'phase_boundary_violation',
          `inbound worktree reset failed: ${message}`,
        );
      }
    }

    let statusOutput: string;
    try {
      statusOutput = await ctx.git.status(ctx.cwd);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return this.fail(
        ctx,
        emit,
        'unknown',
        `inbound worktree cleanliness check failed: ${message}`,
      );
    }

    const dirtyPaths = uncommittedSourcePaths(statusOutput);
    if (dirtyPaths.length === 0) {
      return undefined;
    }

    const normDirty = dirtyPaths.map(normalizeTaskPath).filter(Boolean);

    // When a preserve allowance is present, accept dirty paths if they are a subset of the approved allowance
    if (preserveAllowance !== undefined) {
      const normAllowanceSet = new Set(preserveAllowance.map(normalizeTaskPath).filter(Boolean));
      const unapproved = normDirty.filter((p) => !normAllowanceSet.has(p));

      if (unapproved.length === 0) {
        return undefined;
      }

      const fileList = formatDirtyPaths(unapproved);
      const message = `inbound dirty paths outside approved preserve allowance: ${fileList}. implement aborted to surface the boundary violation; resolve the dirty worktree before re-running implement.`;
      emit('implement.phase_boundary_violation', 'error', message, {
        priorPhaseName: ctx.priorPhaseName,
        dirtyPaths,
        unapprovedPaths: unapproved,
      });
      return this.fail(ctx, emit, 'phase_boundary_violation', message);
    }

    // When preserveAllowance is undefined, exempt implicitPreserved paths identified by worktreeLifecycle.inspect
    const unapproved =
      implicitPreserved.length > 0
        ? normDirty.filter(
            (p) => !new Set(implicitPreserved.map(normalizeTaskPath).filter(Boolean)).has(p),
          )
        : normDirty;

    if (unapproved.length === 0) {
      return undefined;
    }

    const fileList = formatDirtyPaths(unapproved);
    const message = `${ctx.priorPhaseName ?? 'prior phase'} left the worktree dirty: ${fileList}. implement aborted to surface the boundary violation; resolve the dirty worktree in ${ctx.priorPhaseName ?? 'prior phase'} before re-running implement.`;
    emit('implement.phase_boundary_violation', 'error', message, {
      priorPhaseName: ctx.priorPhaseName,
      dirtyPaths,
    });
    return this.fail(ctx, emit, 'phase_boundary_violation', message);
  }

  private async readPlan(
    ctx: PhaseHandlerContext,
    emit: EventEmitter,
  ): Promise<string | PhaseResult> {
    try {
      return await ctx.artifacts.read(ctx.runUuid, 'plan.md');
    } catch (e) {
      const message =
        e instanceof ArtifactNotFoundError
          ? 'plan.md not found in artifact store'
          : `Failed to read plan.md: ${e instanceof Error ? e.message : String(e)}`;
      return this.fail(
        ctx,
        emit,
        e instanceof ArtifactNotFoundError ? 'missing_artifact' : 'unknown',
        message,
      );
    }
  }

  private fail(
    ctx: PhaseHandlerContext,
    emit: EventEmitter,
    kind: FailureKind,
    message: string,
    suggestedAction?: string,
  ): PhaseResult {
    emit('implement.failed', 'error', message);
    return {
      outcome: 'failed',
      failure: {
        runUuid: ctx.runUuid,
        phase: 'implement',
        kind,
        message,
        canRetry: kind !== 'invalid_result',
        suggestedAction:
          suggestedAction ??
          (kind === 'invalid_result'
            ? 'Ensure plan.md contains "## Task" headings.'
            : 'Inspect the failing step artifacts and resume.'),
        artifacts: [],
        detectedAt: ctx.now(),
      },
    };
  }
}
