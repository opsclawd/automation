import { describe, it, expect } from 'vitest';
import {
  detectUnfoundedPingPong,
  fingerprintFindings,
  type FindingHistoryEntry,
} from '../detect-stall.js';

function entry(
  findings: string[],
  fixerVerdict?: FindingHistoryEntry['fixerVerdict'],
): FindingHistoryEntry {
  return { findings: new Set(findings), fixerVerdict };
}

describe('detectUnfoundedPingPong', () => {
  it('returns false when history is shorter than the default window (4)', () => {
    expect(detectUnfoundedPingPong([])).toBe(false);
    expect(detectUnfoundedPingPong([entry(['a'], 'done_no_fixes_needed')])).toBe(false);
    expect(
      detectUnfoundedPingPong([
        entry(['a'], 'done_no_fixes_needed'),
        entry(['a'], 'done_no_fixes_needed'),
        entry(['a'], 'done_no_fixes_needed'),
      ]),
    ).toBe(false);
  });

  it('returns true when last 4 iterations all had findings + done_no_fixes_needed', () => {
    const history = [
      entry(['finding-1'], 'done_no_fixes_needed'),
      entry(['finding-1'], 'done_no_fixes_needed'),
      entry(['finding-1'], 'done_no_fixes_needed'),
      entry(['finding-1'], 'done_no_fixes_needed'),
    ];
    expect(detectUnfoundedPingPong(history)).toBe(true);
  });

  it('returns true even when the window overlaps the most recent entry', () => {
    const history = [
      entry(['finding-1'], 'done_with_fixes'),
      entry(['finding-1'], 'done_no_fixes_needed'),
      entry(['finding-1'], 'done_no_fixes_needed'),
      entry(['finding-1'], 'done_no_fixes_needed'),
      entry(['finding-1'], 'done_no_fixes_needed'),
    ];
    // Window=4 picks the last 4: all done_no_fixes_needed → true.
    expect(detectUnfoundedPingPong(history)).toBe(true);
  });

  it('returns false when any iteration in the window had done_with_fixes', () => {
    const history = [
      entry(['finding-1'], 'done_no_fixes_needed'),
      entry(['finding-1'], 'done_with_fixes'),
      entry(['finding-1'], 'done_no_fixes_needed'),
      entry(['finding-1'], 'done_no_fixes_needed'),
    ];
    expect(detectUnfoundedPingPong(history)).toBe(false);
  });

  it('returns false when any iteration in the window had empty findings', () => {
    const history = [
      entry([], 'done_no_fixes_needed'),
      entry(['finding-1'], 'done_no_fixes_needed'),
      entry(['finding-1'], 'done_no_fixes_needed'),
      entry(['finding-1'], 'done_no_fixes_needed'),
    ];
    expect(detectUnfoundedPingPong(history)).toBe(false);
  });

  it('honors a custom windowSize', () => {
    const history = [
      entry(['finding-1'], 'done_no_fixes_needed'),
      entry(['finding-1'], 'done_no_fixes_needed'),
      entry(['finding-1'], 'done_no_fixes_needed'),
    ];
    expect(detectUnfoundedPingPong(history, 3)).toBe(true);
    expect(detectUnfoundedPingPong(history, 4)).toBe(false);
  });
});

describe('fingerprintFindings', () => {
  it('lowercases and trims summaries', () => {
    expect(fingerprintFindings([{ severity: 'high', summary: '  Type Error ' }])).toEqual(
      new Set(['type error']),
    );
  });

  it('dedupes by normalized summary', () => {
    const fp = fingerprintFindings([
      { severity: 'high', summary: 'Type Error' },
      { severity: 'critical', summary: '  type error  ' },
    ]);
    expect(fp.size).toBe(1);
  });

  it('preserves multiple distinct findings', () => {
    const fp = fingerprintFindings([
      { severity: 'high', summary: 'a' },
      { severity: 'low', summary: 'b' },
    ]);
    expect(fp).toEqual(new Set(['a', 'b']));
  });
});
