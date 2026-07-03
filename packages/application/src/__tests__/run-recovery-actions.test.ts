import { describe, expect, it } from 'vitest';
import type { RunRecord } from '../ports.js';
import type { Phase } from '@ai-sdlc/domain';
import { planRunRecoveryAction } from '../run-recovery-actions.js';
import { UnknownPhaseError } from '../phases/index.js';

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    uuid: 'run-recovery-1',
    displayId: 'issue-1-20260601-000000',
    issueNumber: 1,
    type: 'issue_to_pr',
    status: 'failed',
    completedPhases: [],
    skippedPhases: [],
    startedAt: new Date('2026-06-01T00:00:00Z'),
    ...overrides,
  };
}

describe('planRunRecoveryAction', () => {
  describe('cancel action', () => {
    it('is denied for passed, failed, and cancelled runs', () => {
      for (const status of ['passed', 'failed', 'cancelled'] as const) {
        const run = makeRun({ status });
        const plan = planRunRecoveryAction({ action: 'cancel', run, phases: [] });
        expect(plan.allowed).toBe(false);
        expect(plan.statusCodeOnDenied).toBe(409);
        expect(plan.denialReason).toBeDefined();
        expect(plan.requiresConfirmation).toBe(false);
      }
    });

    it('is allowed for non-terminal runs', () => {
      for (const status of [
        'queued',
        'running',
        'waiting',
        'blocked',
        'needs_human_review',
      ] as const) {
        const run = makeRun({ status });
        const plan = planRunRecoveryAction({ action: 'cancel', run, phases: [] });
        expect(plan.allowed).toBe(true);
        expect(plan.requiresConfirmation).toBe(false);
      }
    });
  });

  describe('retry action', () => {
    it('allows failed, blocked, and needs_human_review runs', () => {
      for (const status of ['failed', 'blocked', 'needs_human_review'] as const) {
        const run = makeRun({ status, currentPhase: 'validate' });
        const plan = planRunRecoveryAction({ action: 'retry', run, phases: [] });
        expect(plan.allowed).toBe(true);
      }
    });

    it('denies retry for non-recoverable runs', () => {
      const run = makeRun({ status: 'running' });
      const plan = planRunRecoveryAction({ action: 'retry', run, phases: [] });
      expect(plan.allowed).toBe(false);
      expect(plan.statusCodeOnDenied).toBe(409);
      expect(plan.denialReason).toContain('failed, blocked, or needs_human_review');
    });

    it('retry target prefers run.currentPhase', () => {
      const run = makeRun({ status: 'failed', currentPhase: 'plan-design' });
      const phases: Phase[] = [
        {
          id: 'p-1',
          runUuid: 'run-recovery-1',
          name: 'read_issue',
          status: 'failed',
          attempt: 1,
          completedAt: new Date('2026-06-01T01:00:00Z'),
        },
      ];
      const plan = planRunRecoveryAction({ action: 'retry', run, phases });
      expect(plan.allowed).toBe(true);
      expect(plan.targetPhase).toBe('plan-design');
      expect(plan.attempt).toBe(1);
    });

    it('retry target falls back to the latest failed phase by completedAt', () => {
      const run = makeRun({ status: 'failed', currentPhase: undefined });
      const phases: Phase[] = [
        {
          id: 'p-1',
          runUuid: 'run-recovery-1',
          name: 'read_issue',
          status: 'failed',
          attempt: 1,
          completedAt: new Date('2026-06-01T01:00:00Z'),
        },
        {
          id: 'p-2',
          runUuid: 'run-recovery-1',
          name: 'plan-design',
          status: 'failed',
          attempt: 1,
          completedAt: new Date('2026-06-01T02:00:00Z'),
        },
      ];
      const plan = planRunRecoveryAction({ action: 'retry', run, phases });
      expect(plan.allowed).toBe(true);
      expect(plan.targetPhase).toBe('plan-design');
      expect(plan.attempt).toBe(2);
    });

    it('retry target falls back to the latest blocked phase by completedAt', () => {
      const run = makeRun({ status: 'blocked', currentPhase: undefined });
      const phases: Phase[] = [
        {
          id: 'p-1',
          runUuid: 'run-recovery-1',
          name: 'read_issue',
          status: 'blocked',
          attempt: 1,
          completedAt: new Date('2026-06-01T01:00:00Z'),
        },
        {
          id: 'p-2',
          runUuid: 'run-recovery-1',
          name: 'plan-design',
          status: 'blocked',
          attempt: 2,
          completedAt: new Date('2026-06-01T02:00:00Z'),
        },
      ];
      const plan = planRunRecoveryAction({ action: 'retry', run, phases });
      expect(plan.allowed).toBe(true);
      expect(plan.targetPhase).toBe('plan-design');
      expect(plan.attempt).toBe(3);
    });

    it('retry attempt is max failed attempt plus one', () => {
      const run = makeRun({ status: 'failed', currentPhase: 'implement' });
      const phases: Phase[] = [
        {
          id: 'p-1',
          runUuid: 'run-recovery-1',
          name: 'implement',
          status: 'failed',
          attempt: 1,
          completedAt: new Date('2026-06-01T01:00:00Z'),
        },
        {
          id: 'p-2',
          runUuid: 'run-recovery-1',
          name: 'implement',
          status: 'failed',
          attempt: 3,
          completedAt: new Date('2026-06-01T02:00:00Z'),
        },
      ];
      const plan = planRunRecoveryAction({ action: 'retry', run, phases });
      expect(plan.allowed).toBe(true);
      expect(plan.targetPhase).toBe('implement');
      expect(plan.attempt).toBe(4);
    });

    it('throws UnknownPhaseError for unknown phase names', () => {
      const run = makeRun({ status: 'failed', currentPhase: 'bogus-phase' });
      expect(() => {
        planRunRecoveryAction({ action: 'retry', run, phases: [] });
      }).toThrow(UnknownPhaseError);
    });
  });

  describe('resume action', () => {
    it('allows failed, blocked, and needs_human_review runs', () => {
      for (const status of ['failed', 'blocked', 'needs_human_review'] as const) {
        const run = makeRun({ status, currentPhase: 'validate' });
        const plan = planRunRecoveryAction({ action: 'resume', run, phases: [] });
        expect(plan.allowed).toBe(true);
      }
    });

    it('denies resume for non-recoverable runs', () => {
      const run = makeRun({ status: 'running' });
      const plan = planRunRecoveryAction({ action: 'resume', run, phases: [] });
      expect(plan.allowed).toBe(false);
      expect(plan.statusCodeOnDenied).toBe(409);
      expect(plan.denialReason).toContain('failed, blocked, or needs_human_review');
    });

    it('resume with fromPhase validates unknown phases and reads retry safety', () => {
      const run = makeRun({ status: 'failed' });

      // Unknown phase throws
      expect(() => {
        planRunRecoveryAction({ action: 'resume', run, phases: [], fromPhase: 'bogus' });
      }).toThrow(UnknownPhaseError);

      // Safe phase (plan-design)
      const safePlan = planRunRecoveryAction({
        action: 'resume',
        run,
        phases: [],
        fromPhase: 'plan-design',
      });
      expect(safePlan.allowed).toBe(true);
      expect(safePlan.targetPhase).toBe('plan-design');
      expect(safePlan.retrySafety).toBe('safe');
      expect(safePlan.requiresConfirmation).toBe(false);

      // Unsafe phase (implement)
      const unsafePlan = planRunRecoveryAction({
        action: 'resume',
        run,
        phases: [],
        fromPhase: 'implement',
      });
      expect(unsafePlan.allowed).toBe(true);
      expect(unsafePlan.targetPhase).toBe('implement');
      expect(unsafePlan.retrySafety).toBe('unsafe');
      expect(unsafePlan.requiresConfirmation).toBe(true);
    });

    it('default resume target uses completed/skipped phase progress', () => {
      const run = makeRun({
        status: 'failed',
        completedPhases: ['read_issue', 'plan-design'],
        skippedPhases: ['plan-write'],
      });
      const plan = planRunRecoveryAction({ action: 'resume', run, phases: [] });
      expect(plan.allowed).toBe(true);
      // Canonical order: read_issue, plan-design, plan-write, implement...
      // Since read_issue, plan-design are completed, and plan-write is skipped,
      // it should target implement.
      expect(plan.targetPhase).toBe('implement');
      expect(plan.retrySafety).toBe('unsafe');
      expect(plan.requiresConfirmation).toBe(true);
    });

    it('default resume target falls back when all phases are complete', () => {
      const run = makeRun({
        status: 'failed',
        completedPhases: [
          'read_issue',
          'plan-design',
          'plan-write',
          'implement',
          'validate',
          'fix-validate',
          'review-fix',
          'compound',
          'create-pr',
          'post-pr-review',
        ],
        skippedPhases: [],
        currentPhase: 'post-pr-review',
      });
      const plan = planRunRecoveryAction({ action: 'resume', run, phases: [] });
      expect(plan.allowed).toBe(true);
      expect(plan.targetPhase).toBe('post-pr-review');
    });

    it('default resume target falls back to latest failed phase when all complete and currentPhase is missing', () => {
      const run = makeRun({
        status: 'failed',
        completedPhases: [
          'read_issue',
          'plan-design',
          'plan-write',
          'implement',
          'validate',
          'fix-validate',
          'review-fix',
          'compound',
          'create-pr',
          'post-pr-review',
        ],
        skippedPhases: [],
        currentPhase: undefined,
      });
      const phases: Phase[] = [
        {
          id: 'p-1',
          runUuid: 'run-recovery-1',
          name: 'implement',
          status: 'failed',
          attempt: 1,
          completedAt: new Date('2026-06-01T01:00:00Z'),
        },
      ];
      const plan = planRunRecoveryAction({ action: 'resume', run, phases });
      expect(plan.allowed).toBe(true);
      expect(plan.targetPhase).toBe('implement');
      expect(plan.attempt).toBe(2);
    });

    it('default resume target falls back to latest blocked phase when all complete and currentPhase is missing', () => {
      const run = makeRun({
        status: 'blocked',
        completedPhases: [
          'read_issue',
          'plan-design',
          'plan-write',
          'implement',
          'validate',
          'fix-validate',
          'review-fix',
          'compound',
          'create-pr',
          'post-pr-review',
        ],
        skippedPhases: [],
        currentPhase: undefined,
      });
      const phases: Phase[] = [
        {
          id: 'p-1',
          runUuid: 'run-recovery-1',
          name: 'implement',
          status: 'blocked',
          attempt: 1,
          completedAt: new Date('2026-06-01T01:00:00Z'),
        },
      ];
      const plan = planRunRecoveryAction({ action: 'resume', run, phases });
      expect(plan.allowed).toBe(true);
      expect(plan.targetPhase).toBe('implement');
      expect(plan.attempt).toBe(2);
    });
  });

  describe('retrySafety and confirmation rules', () => {
    it('unsafe targets require confirmation metadata', () => {
      const run = makeRun({ status: 'failed', currentPhase: 'create-pr' });
      const plan = planRunRecoveryAction({ action: 'retry', run, phases: [] });
      expect(plan.allowed).toBe(true);
      expect(plan.targetPhase).toBe('create-pr');
      expect(plan.retrySafety).toBe('unsafe');
      expect(plan.requiresConfirmation).toBe(true);
    });

    it('safe targets do not require confirmation metadata', () => {
      const run = makeRun({ status: 'failed', currentPhase: 'validate' });
      const plan = planRunRecoveryAction({ action: 'retry', run, phases: [] });
      expect(plan.allowed).toBe(true);
      expect(plan.targetPhase).toBe('validate');
      expect(plan.retrySafety).toBe('safe');
      expect(plan.requiresConfirmation).toBe(false);
    });
  });
});
