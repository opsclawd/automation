import { fingerprintFinding } from '../review-state/fingerprint.js';
import { deriveAllowedFiles, normalizeRepositoryPath } from './review-fix-scope.js';

export interface ResolvedFindingFingerprint {
  fingerprint: string;
  summary: string;
  files: string[];
  resolvedInIteration: number;
  fixChangedFiles: string[];
}

export interface FindingRecurrence {
  resolved: ResolvedFindingFingerprint;
  recurringFinding: { severity: string; summary: string; files?: string[] };
}

export async function recordResolvedFindings(options: {
  resolvedMap: Map<string, ResolvedFindingFingerprint>;
  findings: Array<{ severity: string; summary: string; files?: string[]; file?: string }>;
  fixChangedFiles: string[];
  iterationIndex: number;
  cwd: string;
}): Promise<void> {
  const { resolvedMap, findings, fixChangedFiles, iterationIndex, cwd } = options;
  if (!findings || findings.length === 0 || !fixChangedFiles || fixChangedFiles.length === 0) {
    return;
  }

  const normalizedFixFiles = new Set<string>();
  for (const f of fixChangedFiles) {
    const norm = normalizeRepositoryPath(f, cwd);
    if (norm) {
      normalizedFixFiles.add(norm);
    } else if (f.trim()) {
      normalizedFixFiles.add(f.trim().replace(/\\/g, '/'));
    }
  }

  for (const finding of findings) {
    const findingFiles = deriveAllowedFiles([finding], cwd);
    const intersects = findingFiles.some((file) => normalizedFixFiles.has(file));
    if (!intersects) {
      continue;
    }

    const fingerprint = await fingerprintFinding('integration', finding.severity, finding.summary);
    if (!resolvedMap.has(fingerprint)) {
      resolvedMap.set(fingerprint, {
        fingerprint,
        summary: finding.summary,
        files: findingFiles,
        resolvedInIteration: iterationIndex,
        fixChangedFiles: [...fixChangedFiles],
      });
    }
  }
}

export async function detectFindingRecurrence(options: {
  resolvedFindings: Iterable<ResolvedFindingFingerprint> | Map<string, ResolvedFindingFingerprint>;
  rawFindings: Array<{ severity: string; summary: string; files?: string[]; file?: string }>;
  currentIteration: number;
}): Promise<FindingRecurrence | undefined> {
  const { resolvedFindings, rawFindings, currentIteration } = options;
  if (!rawFindings || rawFindings.length === 0) {
    return undefined;
  }

  const resolvedMap =
    resolvedFindings instanceof Map
      ? resolvedFindings
      : new Map(Array.from(resolvedFindings).map((r) => [r.fingerprint, r]));

  for (const finding of rawFindings) {
    const fingerprint = await fingerprintFinding('integration', finding.severity, finding.summary);
    const resolved = resolvedMap.get(fingerprint);
    if (resolved && resolved.resolvedInIteration < currentIteration) {
      return {
        resolved,
        recurringFinding: finding,
      };
    }
  }

  return undefined;
}
