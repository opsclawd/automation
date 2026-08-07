export interface ScopeFinding {
  severity: string;
  summary: string;
  files?: string[];
  file?: string;
}

export interface OutOfScopeWrite {
  path: string;
  reason: string;
}

export interface ScopeAssessment {
  allowedFiles: string[];
  outOfScopeFiles: OutOfScopeWrite[];
  changedFiles: string[];
}

/**
 * Normalizes slash direction, removes leading ./ or worktree-absolute prefix,
 * and rejects traversal (..) or paths outside the workspace directory.
 */
export function normalizeRepositoryPath(path: string, cwd: string): string | undefined {
  if (!path || typeof path !== 'string') return undefined;

  let trimmed = path.trim().replace(/\\/g, '/');
  if (!trimmed) return undefined;

  let normalizedCwd = cwd.trim().replace(/\\/g, '/');
  while (normalizedCwd.endsWith('/')) {
    normalizedCwd = normalizedCwd.slice(0, -1);
  }

  const isAbsolute = trimmed.startsWith('/') || /^[a-zA-Z]:\//.test(trimmed);
  if (isAbsolute) {
    if (trimmed === normalizedCwd) {
      return undefined;
    }
    if (trimmed.startsWith(`${normalizedCwd}/`)) {
      trimmed = trimmed.slice(normalizedCwd.length + 1);
    } else {
      return undefined;
    }
  }

  const rawSegments = trimmed.split('/');
  const stack: string[] = [];

  for (const segment of rawSegments) {
    if (!segment || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (stack.length === 0) {
        return undefined;
      }
      stack.pop();
    } else {
      stack.push(segment);
    }
  }

  if (stack.length === 0) {
    return undefined;
  }

  return stack.join('/');
}

/**
 * Normalizes and deduplicates finding file anchors, returning a sorted list.
 */
export function deriveAllowedFiles(
  findings: Array<{ files?: string[]; file?: string }>,
  cwd: string,
): string[] {
  const allowed = new Set<string>();
  for (const f of findings) {
    if (f.file && typeof f.file === 'string') {
      const norm = normalizeRepositoryPath(f.file, cwd);
      if (norm) {
        allowed.add(norm);
      }
    }
    if (f.files && Array.isArray(f.files)) {
      for (const file of f.files) {
        const norm = normalizeRepositoryPath(file, cwd);
        if (norm) {
          allowed.add(norm);
        }
      }
    }
  }
  return Array.from(allowed).sort();
}

/**
 * Assesses changed files against allowed anchors, attributing fixer reasons
 * or defaulting when unprovided.
 */
export function assessChangedFiles(input: {
  changedFiles: string[];
  allowedFiles: string[];
  reasons?: Record<string, string>;
  cwd: string;
}): ScopeAssessment {
  const allowedSet = new Set<string>();
  for (const file of input.allowedFiles) {
    const norm = normalizeRepositoryPath(file, input.cwd);
    if (norm) {
      allowedSet.add(norm);
    }
  }

  const normalizedReasons = new Map<string, string>();
  if (input.reasons) {
    for (const [key, value] of Object.entries(input.reasons)) {
      const normKey = normalizeRepositoryPath(key, input.cwd);
      if (normKey && value && value.trim().length > 0) {
        normalizedReasons.set(normKey, value.trim());
      }
    }
  }

  const changedSet = new Set<string>();
  const outOfScopeFiles: OutOfScopeWrite[] = [];

  for (const file of input.changedFiles) {
    const norm = normalizeRepositoryPath(file, input.cwd);
    const pathKey = norm ?? file.trim().replace(/\\/g, '/');
    if (pathKey) {
      changedSet.add(pathKey);
      if (!norm || !allowedSet.has(norm)) {
        const reason = normalizedReasons.get(pathKey) ?? 'No justification provided by fixer.';
        outOfScopeFiles.push({ path: pathKey, reason });
      }
    }
  }

  const sortedChanged = Array.from(changedSet).sort();
  const sortedAllowed = Array.from(allowedSet).sort();
  outOfScopeFiles.sort((a, b) => a.path.localeCompare(b.path));

  return {
    allowedFiles: sortedAllowed,
    outOfScopeFiles,
    changedFiles: sortedChanged,
  };
}

/**
 * Formats a scope warning block for inclusion in reviewer history context.
 */
export function formatScopeWarning(assessment: ScopeAssessment): string {
  const lines: string[] = [
    'Warning: The previous fix attempt modified files outside the scope of the reported findings.',
    'The reviewer should accept legitimate adjacent changes (such as tests or call sites) but raise a high-severity finding for unrelated edits.',
    '',
    'Out-of-scope modified files:',
  ];
  for (const item of assessment.outOfScopeFiles) {
    lines.push(`- ${item.path}: ${item.reason}`);
  }
  return lines.join('\n');
}

/**
 * Constructs a structured commit message with a concise subject line
 * and bounded list of findings and modified files.
 */
export function buildFindingCommitMessage(
  findings: Array<{ summary: string; severity?: string }>,
  changedFiles: string[],
): string {
  let subject = 'fix(review): address review findings';
  const firstFinding = findings[0];
  if (findings.length === 1 && firstFinding?.summary) {
    const conciseSummary = firstFinding.summary.trim().replace(/\s+/g, ' ');
    const maxLen = 70;
    const truncated =
      conciseSummary.length > maxLen ? `${conciseSummary.slice(0, maxLen - 3)}...` : conciseSummary;
    subject = `fix(review): ${truncated}`;
  } else if (findings.length > 1) {
    subject = `fix(review): address ${findings.length} review findings`;
  }

  const bodyLines: string[] = [];

  if (findings.length > 0) {
    bodyLines.push('Addressed findings:');
    for (const f of findings.slice(0, 20)) {
      const severityStr = f.severity ? `[${f.severity}] ` : '';
      bodyLines.push(`- ${severityStr}${f.summary.trim()}`);
    }
    if (findings.length > 20) {
      bodyLines.push(`- ...and ${findings.length - 20} more finding(s)`);
    }
  }

  if (changedFiles.length > 0) {
    if (bodyLines.length > 0) {
      bodyLines.push('');
    }
    bodyLines.push('Modified files:');
    for (const file of changedFiles.slice(0, 50)) {
      bodyLines.push(`- ${file}`);
    }
    if (changedFiles.length > 50) {
      bodyLines.push(`- ...and ${changedFiles.length - 50} more file(s)`);
    }
  }

  return bodyLines.length > 0 ? `${subject}\n\n${bodyLines.join('\n')}` : subject;
}
