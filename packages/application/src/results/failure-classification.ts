import { existsSync, statSync } from 'node:fs';

export type ResultFailureClassification = 'serialization_artifact' | 'unrecoverable_artifact';

export function hasEvidence(stdoutPath?: string): boolean {
  if (!stdoutPath) return false;
  try {
    return existsSync(stdoutPath) && statSync(stdoutPath).size > 0;
  } catch {
    return false;
  }
}

export function classifyResultFailure(stdoutPath?: string): ResultFailureClassification {
  return hasEvidence(stdoutPath) ? 'serialization_artifact' : 'unrecoverable_artifact';
}
