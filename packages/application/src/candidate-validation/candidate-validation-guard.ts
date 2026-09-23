import { createHash } from 'node:crypto';
import type { GitPort } from '../ports/git-port.js';
import {
  classifyCandidateContent,
  isRecognizedCandidatePath,
} from './candidate-validation-classifier.js';
import type { CandidateSnapshot, GovernanceFinding } from './types.js';

export async function takeCandidateSnapshot(cwd: string, git: GitPort): Promise<CandidateSnapshot> {
  const snapshot: CandidateSnapshot = new Map();
  const files = await git.listWorktreeFiles(cwd, { includeIgnored: true });

  for (const p of files) {
    const kind = isRecognizedCandidatePath(p);
    if (!kind) continue;

    const content = await git.worktreeFileContent(cwd, p);
    if (content !== undefined) {
      const contentHash = createHash('sha256').update(content).digest('hex');
      snapshot.set(p, { state: 'present', content, contentHash });
    } else {
      snapshot.set(p, { state: 'absent' });
    }
  }

  return snapshot;
}

export function evaluateCandidateDelta(
  baseline: CandidateSnapshot,
  finalSnapshot: CandidateSnapshot,
): { ok: boolean; findings: GovernanceFinding[] } {
  const findings: GovernanceFinding[] = [];
  const allPaths = new Set([...baseline.keys(), ...finalSnapshot.keys()]);

  for (const p of allPaths) {
    const base = baseline.get(p) ?? { state: 'absent' };
    const final = finalSnapshot.get(p) ?? { state: 'absent' };

    // Case 1: Present in baseline, absent in final -> DELETED_RECOGNIZED_ARTIFACT
    if (base.state === 'present' && final.state === 'absent') {
      findings.push({
        code: 'DELETED_RECOGNIZED_ARTIFACT',
        severity: 'critical',
        message: `Recognized candidate governance artifact '${p}' was deleted during agent invocation. Candidate validation artifacts are operator-owned and must not be removed by automated agents.`,
        path: p,
      });
      continue;
    }

    // Case 2: Present in both, identical hash -> UNCHANGED (tolerated)
    if (
      base.state === 'present' &&
      final.state === 'present' &&
      base.contentHash === final.contentHash
    ) {
      continue;
    }

    // Case 3: Created (absent -> present) or Modified (present -> present with different hash)
    if (final.state === 'present') {
      const kind = isRecognizedCandidatePath(p);
      if (kind) {
        const classifiedFindings = classifyCandidateContent(p, final.content, kind);
        findings.push(...classifiedFindings);
      }
    }
  }

  return {
    ok: findings.length === 0,
    findings,
  };
}
