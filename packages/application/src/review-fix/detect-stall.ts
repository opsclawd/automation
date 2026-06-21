export type StallType = 'none' | 'oscillation' | 'no_progress';

export function detectStall(findingHistory: Array<Set<string>>): StallType {
  if (findingHistory.length < 3) return 'none';

  const current = findingHistory[findingHistory.length - 1]!;
  const prev = findingHistory[findingHistory.length - 2]!;
  const prevPrev = findingHistory[findingHistory.length - 3]!;

  for (const finding of current) {
    if (prev.has(finding) && prevPrev.has(finding)) return 'no_progress';
    if (!prev.has(finding) && prevPrev.has(finding)) return 'oscillation';
  }

  return 'none';
}
