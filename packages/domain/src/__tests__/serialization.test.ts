import { describe, expect, it } from 'vitest';
import { createRun, startPhase } from '../run.js';
import { serializeRun, deserializeRun, RunDeserializeError } from '../serialization.js';
import { RepositoryId } from '../ids.js';

const base = {
  repoId: RepositoryId('owner/repo'),
  uuid: '11111111-1111-1111-1111-111111111111',
  displayId: 'issue-1-20260513-000000',
  issueNumber: 1,
  startedAt: new Date('2026-05-13T00:00:00Z'),
};

describe('Run serialization', () => {
  it('round-trips Date fields as Date instances', () => {
    const r = startPhase(createRun(base), 'read_issue');
    const back = deserializeRun(serializeRun(r));
    expect(back.startedAt).toBeInstanceOf(Date);
    expect(back.startedAt.toISOString()).toBe('2026-05-13T00:00:00.000Z');
    expect(back.completedAt).toBeUndefined();
    expect(back.currentPhase).toBe('read_issue');
    expect(back.repoId).toBe('owner/repo');
  });

  it('coerces completedAt when present', () => {
    const r = createRun(base);
    const json = JSON.stringify({ ...r, completedAt: '2026-05-14T01:02:03Z' });
    const back = deserializeRun(json);
    expect(back.completedAt).toBeInstanceOf(Date);
    expect(back.completedAt?.toISOString()).toBe('2026-05-14T01:02:03.000Z');
  });

  it('throws on invalid date string', () => {
    const json = JSON.stringify({ ...createRun(base), startedAt: 'not-a-date' });
    expect(() => deserializeRun(json)).toThrow(RunDeserializeError);
  });

  it('accepts a pre-parsed object', () => {
    const r = createRun(base);
    const back = deserializeRun(JSON.parse(JSON.stringify(r)));
    expect(back.startedAt).toBeInstanceOf(Date);
  });
});
