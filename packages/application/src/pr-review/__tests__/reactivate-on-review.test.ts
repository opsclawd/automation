import { describe, it, expect } from 'vitest';
import { decideReactivation } from '../reactivate-on-review.js';

const readyAt = new Date('2026-06-04T00:00:00Z');

describe('decideReactivation', () => {
  it('stays ready when there is no new activity before the deadline', () => {
    const d = decideReactivation({
      readyAt,
      now: new Date('2026-06-05T00:00:00Z'),
      readyMaxDays: 7,
      lastSeenActivityAt: readyAt,
      newestCommentAt: readyAt,
    });
    expect(d.action).toBe('stay_ready');
    expect(d.reason).toContain('no new activity');
  });

  it('reactivates when a comment arrives after the last-seen cursor', () => {
    const d = decideReactivation({
      readyAt,
      now: new Date('2026-06-04T06:00:00Z'),
      readyMaxDays: 7,
      lastSeenActivityAt: readyAt,
      newestCommentAt: new Date('2026-06-04T05:00:00Z'),
    });
    expect(d.action).toBe('reactivate');
    expect(d.reason).toContain('new review activity');
  });

  it('times out when the deadline passes with no new activity', () => {
    const d = decideReactivation({
      readyAt,
      now: new Date('2026-06-12T00:00:01Z'),
      readyMaxDays: 7,
      lastSeenActivityAt: readyAt,
      newestCommentAt: readyAt,
    });
    expect(d.action).toBe('timeout');
    expect(d.reason).toContain('readyMaxDays');
  });

  it('prefers reactivation over timeout when both new activity and deadline coincide', () => {
    const d = decideReactivation({
      readyAt,
      now: new Date('2026-06-12T00:00:01Z'),
      readyMaxDays: 7,
      lastSeenActivityAt: readyAt,
      newestCommentAt: new Date('2026-06-11T00:00:00Z'),
    });
    expect(d.action).toBe('reactivate');
  });

  it('treats equal timestamps as no new activity', () => {
    const d = decideReactivation({
      readyAt,
      now: new Date('2026-06-05T00:00:00Z'),
      readyMaxDays: 7,
      lastSeenActivityAt: readyAt,
      newestCommentAt: readyAt,
    });
    expect(d.action).toBe('stay_ready');
  });
});
