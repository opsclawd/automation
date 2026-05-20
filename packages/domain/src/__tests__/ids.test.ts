import { describe, expect, it } from 'vitest';
import { RunId, IssueNumber, PhaseName, RepositoryId, JobId, WorkerId } from '../ids.js';

describe('branded ids', () => {
  it('constructs and round-trips RunId', () => {
    const id = RunId('abc');
    expect(id).toBe('abc');
    expect(() => RunId('')).toThrow();
  });

  it('IssueNumber rejects non-positive integers', () => {
    expect(() => IssueNumber(0)).toThrow();
    expect(() => IssueNumber(-1)).toThrow();
    expect(() => IssueNumber(1.5)).toThrow();
    expect(IssueNumber(123)).toBe(123);
  });

  it('PhaseName rejects empty strings', () => {
    expect(() => PhaseName('')).toThrow();
    expect(PhaseName('plan-design')).toBe('plan-design');
  });

  it('RepositoryId, JobId, WorkerId accept non-empty strings', () => {
    expect(RepositoryId('r1')).toBe('r1');
    expect(JobId('j1')).toBe('j1');
    expect(WorkerId('w1')).toBe('w1');
    expect(() => RepositoryId('')).toThrow();
    expect(() => JobId('')).toThrow();
    expect(() => WorkerId('')).toThrow();
  });
});
