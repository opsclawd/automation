import { describe, expect, it } from 'vitest';
import { openDatabase, applyMigrations } from '../../index.js';
import { ReviewStateRepository } from '../review-state-repository.js';

const t0 = '2026-07-01T00:00:00.000Z';
const t1 = '2026-07-01T00:01:00.000Z';
const t2 = '2026-07-01T00:02:00.000Z';

function setup() {
  const db = openDatabase(':memory:');
  applyMigrations(db);
  return { db, repo: new ReviewStateRepository(db) };
}

describe('ReviewStateRepository', () => {
  describe('appendAttempt / listAttempts', () => {
    it('round-trips an attempt', () => {
      const { repo } = setup();
      repo.appendAttempt({
        attemptId: 'attempt-1',
        runId: 'run-1',
        scope: 'review',
        step: 'plan-review',
        reviewMode: 'initial_full',
        createdAt: t0,
        artifacts: ['artifact1.txt'],
      });

      const attempts = repo.listAttempts('run-1', 'review', 'plan-review');
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toEqual({
        attemptId: 'attempt-1',
        runId: 'run-1',
        scope: 'review',
        step: 'plan-review',
        reviewMode: 'initial_full',
        createdAt: t0,
        artifacts: ['artifact1.txt'],
      });
    });

    it('returns empty list for run with no attempts', () => {
      const { repo } = setup();
      const attempts = repo.listAttempts('run-none', 'review', 'plan-review');
      expect(attempts).toHaveLength(0);
    });

    it('orders attempts by created_at ascending', () => {
      const { repo } = setup();
      repo.appendAttempt({
        attemptId: 'attempt-2',
        runId: 'run-1',
        scope: 'review',
        step: 'plan-review',
        reviewMode: 'intermediate_delta',
        createdAt: t1,
        artifacts: [],
      });
      repo.appendAttempt({
        attemptId: 'attempt-1',
        runId: 'run-1',
        scope: 'review',
        step: 'plan-review',
        reviewMode: 'initial_full',
        createdAt: t0,
        artifacts: [],
      });
      repo.appendAttempt({
        attemptId: 'attempt-3',
        runId: 'run-1',
        scope: 'review',
        step: 'plan-review',
        reviewMode: 'final_full',
        createdAt: t2,
        artifacts: [],
      });

      const attempts = repo.listAttempts('run-1', 'review', 'plan-review');
      expect(attempts.map((a) => a.attemptId)).toEqual(['attempt-1', 'attempt-2', 'attempt-3']);
    });

    it('filters by run, scope, and step', () => {
      const { repo } = setup();
      repo.appendAttempt({
        attemptId: 'a1',
        runId: 'run-1',
        scope: 'review',
        step: 'plan-review',
        reviewMode: 'initial_full',
        createdAt: t0,
        artifacts: [],
      });
      repo.appendAttempt({
        attemptId: 'a2',
        runId: 'run-1',
        scope: 'review',
        step: 'implement',
        reviewMode: 'initial_full',
        createdAt: t0,
        artifacts: [],
      });
      repo.appendAttempt({
        attemptId: 'a3',
        runId: 'run-2',
        scope: 'review',
        step: 'plan-review',
        reviewMode: 'initial_full',
        createdAt: t0,
        artifacts: [],
      });

      expect(repo.listAttempts('run-1', 'review', 'plan-review').map((a) => a.attemptId)).toEqual([
        'a1',
      ]);
      expect(repo.listAttempts('run-1', 'review', 'implement').map((a) => a.attemptId)).toEqual([
        'a2',
      ]);
      expect(repo.listAttempts('run-2', 'review', 'plan-review').map((a) => a.attemptId)).toEqual([
        'a3',
      ]);
    });
  });

  describe('upsertDimensionState / listDimensionStates', () => {
    it('round-trips dimension state', () => {
      const { repo } = setup();
      repo.upsertDimensionState('run-1', 'review', 'plan-review', {
        dimension: 'quality',
        latestSnapshot: {
          kind: 'git',
          identity: 'sha-abc123',
          capturedAt: t0,
        },
        latestVerdict: 'pass',
        dirty: false,
        provisionallyClean: true,
        unresolvedRecords: [
          {
            reviewerKind: 'quality',
            severity: 'high',
            summary: 'Missing error handling',
            fingerprint: 'fp1',
          },
        ],
        dispositionHistory: [{ disposition: 'open', changedAt: t0 }],
      });

      const states = repo.listDimensionStates('run-1', 'review', 'plan-review');
      expect(states).toHaveLength(1);
      expect(states[0].dimension).toBe('quality');
      expect(states[0].latestSnapshot?.kind).toBe('git');
      expect(states[0].latestSnapshot?.identity).toBe('sha-abc123');
      expect(states[0].latestVerdict).toBe('pass');
      expect(states[0].dirty).toBe(false);
      expect(states[0].provisionallyClean).toBe(true);
      expect(states[0].unresolvedRecords).toHaveLength(1);
      expect(states[0].dispositionHistory).toHaveLength(1);
    });

    it('upsert replaces existing state for same dimension', () => {
      const { repo } = setup();
      repo.upsertDimensionState('run-1', 'review', 'plan-review', {
        dimension: 'quality',
        latestVerdict: 'fail',
        dirty: true,
        provisionallyClean: false,
        unresolvedRecords: [],
        dispositionHistory: [],
      });
      repo.upsertDimensionState('run-1', 'review', 'plan-review', {
        dimension: 'quality',
        latestVerdict: 'pass',
        dirty: false,
        provisionallyClean: true,
        unresolvedRecords: [],
        dispositionHistory: [],
      });

      const states = repo.listDimensionStates('run-1', 'review', 'plan-review');
      expect(states).toHaveLength(1);
      expect(states[0].latestVerdict).toBe('pass');
    });

    it('returns empty list for run with no dimension states', () => {
      const { repo } = setup();
      const states = repo.listDimensionStates('run-none', 'review', 'plan-review');
      expect(states).toHaveLength(0);
    });

    it('stores multiple dimensions separately', () => {
      const { repo } = setup();
      repo.upsertDimensionState('run-1', 'review', 'plan-review', {
        dimension: 'quality',
        latestVerdict: 'pass',
        dirty: false,
        provisionallyClean: true,
        unresolvedRecords: [],
        dispositionHistory: [],
      });
      repo.upsertDimensionState('run-1', 'review', 'plan-review', {
        dimension: 'architect',
        latestVerdict: 'fail',
        dirty: true,
        provisionallyClean: false,
        unresolvedRecords: [],
        dispositionHistory: [],
      });

      const states = repo.listDimensionStates('run-1', 'review', 'plan-review');
      expect(states).toHaveLength(2);
      expect(states.map((s) => s.dimension).sort()).toEqual(['architect', 'quality']);
    });

    it('handles null snapshot fields', () => {
      const { repo } = setup();
      repo.upsertDimensionState('run-1', 'review', 'plan-review', {
        dimension: 'quality',
        dirty: true,
        provisionallyClean: false,
        unresolvedRecords: [],
        dispositionHistory: [],
      });

      const states = repo.listDimensionStates('run-1', 'review', 'plan-review');
      expect(states[0].latestSnapshot).toBeUndefined();
      expect(states[0].latestVerdict).toBeUndefined();
    });

    it('handles baseIdentity in snapshot', () => {
      const { repo } = setup();
      repo.upsertDimensionState('run-1', 'review', 'plan-review', {
        dimension: 'quality',
        latestSnapshot: {
          kind: 'git',
          identity: 'sha-abc123',
          baseIdentity: 'sha-000000',
          capturedAt: t0,
        },
        dirty: false,
        provisionallyClean: true,
        unresolvedRecords: [],
        dispositionHistory: [],
      });

      const states = repo.listDimensionStates('run-1', 'review', 'plan-review');
      expect(states[0].latestSnapshot?.baseIdentity).toBe('sha-000000');
    });
  });
});
