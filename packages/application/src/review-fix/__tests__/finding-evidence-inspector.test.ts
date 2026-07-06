import { describe, it, expect } from 'vitest';
import {
  FakeFindingEvidenceInspector,
  makeFindingEvidenceInspector,
} from '../../test-doubles/fake-finding-evidence-inspector.js';
import type { FindingEvidenceCheckInput } from '../../ports/finding-evidence-inspector-port.js';

function input(over: Partial<FindingEvidenceCheckInput> = {}): FindingEvidenceCheckInput {
  return {
    cwd: '/wt',
    ref: 'HEAD',
    evidence: { path: 'src/foo.ts', line: 10 },
    ...over,
  };
}

describe('FakeFindingEvidenceInspector', () => {
  it('returns the configured next result by default', async () => {
    const fake = new FakeFindingEvidenceInspector();
    const port = makeFindingEvidenceInspector(fake);
    fake.setNext({ evidenceConfirmed: false, reason: 'forced false' });
    const result = await port(input());
    expect(result).toEqual({ evidenceConfirmed: false, reason: 'forced false' });
    expect(fake.calls).toHaveLength(1);
  });

  it('delegates to resultFn when set (per-call results)', async () => {
    const fake = new FakeFindingEvidenceInspector();
    const port = makeFindingEvidenceInspector(fake);
    fake.setResultFn((i) =>
      i.evidence.path === 'src/a.ts'
        ? { evidenceConfirmed: true, reason: 'a' }
        : { evidenceConfirmed: false, reason: 'other' },
    );
    expect(await port(input({ evidence: { path: 'src/a.ts' } }))).toEqual({
      evidenceConfirmed: true,
      reason: 'a',
    });
    expect(await port(input({ evidence: { path: 'src/b.ts' } }))).toEqual({
      evidenceConfirmed: false,
      reason: 'other',
    });
    expect(fake.calls).toHaveLength(2);
  });

  it('records every call in .calls for assertions', async () => {
    const fake = new FakeFindingEvidenceInspector();
    const port = makeFindingEvidenceInspector(fake);
    await port(input({ ref: 'sha-1', evidence: { path: 'a.ts' } }));
    await port(input({ ref: 'sha-2', evidence: { path: 'b.ts', line: 5 } }));
    expect(fake.calls).toEqual([
      { cwd: '/wt', ref: 'sha-1', evidence: { path: 'a.ts' } },
      { cwd: '/wt', ref: 'sha-2', evidence: { path: 'b.ts', line: 5 } },
    ]);
  });

  it('returns a confirmed result when input has only a path', async () => {
    const fake = new FakeFindingEvidenceInspector();
    const port = makeFindingEvidenceInspector(fake);
    fake.setNext({ evidenceConfirmed: true, reason: 'ok' });
    const result = await port(input({ evidence: { path: 'src/foo.ts' } }));
    expect(result.evidenceConfirmed).toBe(true);
  });
});
