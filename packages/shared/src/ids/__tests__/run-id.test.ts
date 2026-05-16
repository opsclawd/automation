import { describe, expect, it } from 'vitest';
import { newRunId } from '../run-id.js';

describe('newRunId', () => {
  it('produces a UUID and a deterministic displayId', () => {
    const at = new Date('2026-05-13T19:23:00.000Z');
    const id = newRunId({ issueNumber: 123, now: at });
    expect(id.displayId).toBe('issue-123-20260513-192300000');
    expect(id.uuid).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('zero-pads single digit time components', () => {
    const at = new Date('2026-01-02T03:04:05.123Z');
    const id = newRunId({ issueNumber: 7, now: at });
    expect(id.displayId).toBe('issue-7-20260102-030405123');
  });

  it('produces unique displayIds within the same second', () => {
    const at = new Date('2026-05-13T19:23:00.456Z');
    const atSameSecond = new Date('2026-05-13T19:23:00.789Z');
    const a = newRunId({ issueNumber: 1, now: at });
    const b = newRunId({ issueNumber: 1, now: atSameSecond });
    expect(a.displayId).not.toBe(b.displayId);
  });

  it('produces unique UUIDs across calls', () => {
    const at = new Date('2026-05-13T19:23:00.000Z');
    const a = newRunId({ issueNumber: 1, now: at });
    const b = newRunId({ issueNumber: 1, now: at });
    expect(a.uuid).not.toBe(b.uuid);
  });
});
