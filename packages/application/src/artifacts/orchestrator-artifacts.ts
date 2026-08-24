export const ORCHESTRATOR_ARTIFACT_PATHS = Object.freeze([
  'validation.headsha',
  'review-fix-plan.json',
  'review-task-manifest.json',
  'review-triage.md',
  'code-review.md',
  'review.md',
  'task-manifest.json',
  'implementation-log.md',
  'arbiter-result.json',
  'review-loop-history.json',
  'implement-step-history-*.json',
  'compound-draft.md',
  'compound.md',
  'validation.result',
  'result.json',
  'scratch-files.json',
  '.ai-tmp/scratch-files.json',
  'fix-validate-done.marker',
  'plan-review-passed.marker',
  'pr-summary.md',
  // create-pr writes this itself, then its own clean-worktree guard reads the
  // tree on resume — omitting it made create-pr block on its own output.
  'pr-url.txt',
] as const);

export const ORCHESTRATOR_PATCH_EXCLUDE = '*.patch';

export const ORCHESTRATOR_DIFF_EXCLUDES = Object.freeze([
  '*.diff',
  '*-diff.txt',
  'diff.txt',
] as const);

export const orchestratorArtifactPathSet = new Set<string>(
  ORCHESTRATOR_ARTIFACT_PATHS,
) as ReadonlySet<string>;

export function isOrchestratorArtifactPath(path: string): boolean {
  return orchestratorArtifactPathSet.has(path);
}

export function orchestratorExcludePatterns(): readonly string[] {
  return Object.freeze([
    ...ORCHESTRATOR_ARTIFACT_PATHS,
    ORCHESTRATOR_PATCH_EXCLUDE,
    ...ORCHESTRATOR_DIFF_EXCLUDES,
    ...PROMPT_ORCHESTRATOR_ARTIFACT_PATHS,
  ]);
}

function patternToRegExp(pattern: string): RegExp {
  const regexString =
    '^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$';
  return new RegExp(regexString);
}

let cachedCompiledRegexes: readonly RegExp[] | undefined;

function getOrchestratorRegexes(): readonly RegExp[] {
  if (!cachedCompiledRegexes) {
    cachedCompiledRegexes = Object.freeze(orchestratorExcludePatterns().map(patternToRegExp));
  }
  return cachedCompiledRegexes;
}

export function isOrchestratorArtifactPattern(path: string): boolean {
  if (!path || typeof path !== 'string') return false;
  const normalized = path
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(\.\/|\/)+/, '');
  if (!normalized) return false;
  return getOrchestratorRegexes().some((regex) => regex.test(normalized));
}

export function unquoteGitPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    const inner = trimmed.slice(1, -1);
    const bytes: number[] = [];
    let i = 0;
    while (i < inner.length) {
      const char = inner.charAt(i);
      if (char === '\\') {
        i++;
        if (i >= inner.length) {
          bytes.push(0x5c);
          break;
        }
        const nextChar = inner.charAt(i);
        if (nextChar >= '0' && nextChar <= '7') {
          let octal = nextChar;
          i++;
          if (i < inner.length) {
            const digit2 = inner.charAt(i);
            if (digit2 >= '0' && digit2 <= '7') {
              octal += digit2;
              i++;
              if (i < inner.length) {
                const digit3 = inner.charAt(i);
                if (digit3 >= '0' && digit3 <= '7') {
                  octal += digit3;
                  i++;
                }
              }
            }
          }
          bytes.push(parseInt(octal, 8));
          continue;
        }
        switch (nextChar) {
          case 'a':
            bytes.push(0x07);
            break;
          case 'b':
            bytes.push(0x08);
            break;
          case 'f':
            bytes.push(0x0c);
            break;
          case 'n':
            bytes.push(0x0a);
            break;
          case 'r':
            bytes.push(0x0d);
            break;
          case 't':
            bytes.push(0x09);
            break;
          case 'v':
            bytes.push(0x0b);
            break;
          case '\\':
            bytes.push(0x5c);
            break;
          case '"':
            bytes.push(0x22);
            break;
          default: {
            const codePoint = inner.codePointAt(i);
            if (codePoint !== undefined) {
              const buf = Buffer.from(String.fromCodePoint(codePoint), 'utf8');
              for (const b of buf) {
                bytes.push(b);
              }
              if (codePoint > 0xffff) {
                i++;
              }
            }
            break;
          }
        }
        i++;
      } else {
        const codePoint = inner.codePointAt(i);
        if (codePoint !== undefined) {
          const buf = Buffer.from(String.fromCodePoint(codePoint), 'utf8');
          for (const b of buf) {
            bytes.push(b);
          }
          if (codePoint > 0xffff) {
            i++;
          }
        }
        i++;
      }
    }
    return Buffer.from(bytes).toString('utf8');
  }
  return trimmed;
}

function parseGitStatusLine(line: string): string[] {
  if (!line || line.length <= 3) return [];
  const statusX = line.charAt(0);
  const statusY = line.charAt(1);
  const payload = line.slice(3).trim();
  if (!payload) return [];

  const isRenameOrCopy = statusX === 'R' || statusX === 'C' || statusY === 'R' || statusY === 'C';

  if (!isRenameOrCopy) {
    return [payload];
  }

  if (payload.startsWith('"')) {
    let i = 1;
    while (i < payload.length) {
      const c = payload.charAt(i);
      if (c === '\\') {
        i += 2;
      } else if (c === '"') {
        break;
      } else {
        i += 1;
      }
    }
    if (i < payload.length && payload.charAt(i) === '"') {
      const origPath = payload.slice(0, i + 1);
      const remaining = payload.slice(i + 1);
      const arrowIndex = remaining.indexOf(' -> ');
      if (arrowIndex !== -1) {
        const newPath = remaining.slice(arrowIndex + 4);
        return [origPath, newPath];
      }
    }
  }

  const arrowIndex = payload.indexOf(' -> ');
  if (arrowIndex !== -1) {
    return [payload.slice(0, arrowIndex), payload.slice(arrowIndex + 4)];
  }

  return [payload];
}

export function parseGitStatusPaths(status: string): string[] {
  const paths = status
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => parseGitStatusLine(line))
    .map((path) => unquoteGitPath(path))
    .map((path) => path.replace(/\\/g, '/'))
    .filter((path) => path.length > 0);

  return [...new Set(paths)].sort();
}

export function uncommittedSourcePaths(status: string): string[] {
  const compiledRegexes = getOrchestratorRegexes();
  return parseGitStatusPaths(status).filter(
    (path) => !compiledRegexes.some((regex) => regex.test(path)),
  );
}

export function isUntrackedOrAddedStatusLine(line: string): boolean {
  if (!line || line.length < 3) return false;
  return line.startsWith('?? ') || line.charAt(0) === 'A' || line.charAt(1) === 'A';
}

export function formatDirtyPaths(paths: readonly string[], max = 10): string {
  if (paths.length <= max) {
    return paths.join(', ');
  }
  const shown = paths.slice(0, max).join(', ');
  const remaining = paths.length - max;
  return `${shown} and ${remaining} more`;
}

export const PROMPT_ORCHESTRATOR_ARTIFACT_PATHS = Object.freeze([
  'issue.md',
  'issue-comments.md',
  'design.md',
  'plan.md',
  'task-context-step-*.md',
  'plan-review-findings.md',
  'plan-fix-result.json',
  'quality-review-result*.json',
  'spec-review-result*.json',
  'fix-result*.json',
  'prompt.md',
  'implementation-log*.md',
] as const);

export function getGitCommitExcludePathspecs(): readonly string[] {
  const allPatterns = orchestratorExcludePatterns();
  const unique = Array.from(new Set(allPatterns));
  return Object.freeze(unique.map((p) => `':!${p}'`));
}

export function getGitCommitExcludePathspecsString(): string {
  return getGitCommitExcludePathspecs().join(' ');
}
