import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export type ResultFailureClassification = 'serialization_artifact' | 'unrecoverable_artifact';

export interface HasEvidenceOptions {
  requireJsonStructure?: boolean;
  candidatePaths?: string[];
  cwd?: string;
}

export function hasEvidence(stdoutPath?: string, options?: HasEvidenceOptions): boolean {
  if (options?.candidatePaths && options.candidatePaths.length > 0) {
    const cwd = options.cwd ?? process.cwd();
    for (const cand of options.candidatePaths) {
      try {
        const full = isAbsolute(cand) ? cand : join(cwd, cand);
        if (existsSync(full) && statSync(full).size > 0) {
          return true;
        }
      } catch {
        // continue
      }
    }
  }

  if (!stdoutPath) return false;
  try {
    return existsSync(stdoutPath) && statSync(stdoutPath).size > 0;
  } catch {
    return false;
  }
}

export function classifyResultFailure(
  stdoutPath?: string,
  options?: HasEvidenceOptions,
): ResultFailureClassification {
  return hasEvidence(stdoutPath, options) ? 'serialization_artifact' : 'unrecoverable_artifact';
}
