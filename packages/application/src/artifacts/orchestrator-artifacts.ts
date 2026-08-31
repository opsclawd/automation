export const ORCHESTRATOR_ARTIFACT_PATHS = Object.freeze([
  'validation.headsha',
  'validation.fingerprint',
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
  // Lean review-loop bookkeeping (#1106/#1110): written by spec-review,
  // quality-review, fix-review, follow-up-review, and the run-executor's review-convergence
  // state machine. Omitting these made deterministic-validation freshness
  // checks see the orchestrator's own instrumentation writes as source
  // changes and spuriously block follow-up-review (#1109 regression).
  'finding-ledger.json',
  'review-convergence.json',
  'review-head-sha.txt',
  // spec-review.ts and quality-review.ts each additionally write their own
  // phase-prefixed headsha file (alongside the shared review-head-sha.txt
  // above). Omitting these made quality-review's deterministic-validation
  // freshness check see spec-review's own bookkeeping write as a source
  // change and spuriously fail with "worktree source state modified since
  // last validation" immediately after a clean spec-review pass.
  'spec-review-head-sha.txt',
  'quality-review-head-sha.txt',
  'whole-change-review.json',
  'follow-up-review.json',
  'spec-review.json',
  'spec-review.md',
  'spec-requirements-ledger.json',
  'quality-review.json',
  'quality-review.md',
  'architecture-review.json',
  'architecture-review.md',
  'architecture-requirements.json',
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
  const normalized = path.replace(/\r$/, '').replace(/^(\.\/|\/)+/, '');
  if (!normalized) return false;
  if (normalized.startsWith('.ai/')) return true;
  return getOrchestratorRegexes().some((regex) => regex.test(normalized));
}

const utf8Decoder = new TextDecoder('utf-8');

export function unquoteGitPath(path: string): string {
  if (path.startsWith('"') && path.endsWith('"') && path.length >= 2) {
    const inner = path.slice(1, -1);
    let result = '';
    let i = 0;
    const len = inner.length;

    while (i < len) {
      const char = inner.charAt(i);
      if (char === '\\') {
        i++;
        if (i >= len) {
          result += '\\';
          break;
        }
        const nextChar = inner.charAt(i);
        if (nextChar >= '0' && nextChar <= '7') {
          const octalBytes: number[] = [];
          while (i < len && inner.charAt(i) >= '0' && inner.charAt(i) <= '7') {
            let octal = inner.charAt(i);
            i++;
            if (i < len && inner.charAt(i) >= '0' && inner.charAt(i) <= '7') {
              octal += inner.charAt(i);
              i++;
              if (i < len && inner.charAt(i) >= '0' && inner.charAt(i) <= '7') {
                octal += inner.charAt(i);
                i++;
              }
            }
            octalBytes.push(parseInt(octal, 8));
            if (
              i < len - 1 &&
              inner.charAt(i) === '\\' &&
              inner.charAt(i + 1) >= '0' &&
              inner.charAt(i + 1) <= '7'
            ) {
              i++;
            } else {
              break;
            }
          }
          result += utf8Decoder.decode(new Uint8Array(octalBytes));
          continue;
        }

        switch (nextChar) {
          case 'a':
            result += '\x07';
            break;
          case 'b':
            result += '\b';
            break;
          case 'f':
            result += '\f';
            break;
          case 'n':
            result += '\n';
            break;
          case 'r':
            result += '\r';
            break;
          case 't':
            result += '\t';
            break;
          case 'v':
            result += '\v';
            break;
          case '\\':
            result += '\\';
            break;
          case '"':
            result += '"';
            break;
          default:
            result += nextChar;
            break;
        }
        i++;
      } else {
        result += char;
        i++;
      }
    }
    return result;
  }
  return path;
}

export function parseGitStatusLine(rawLine: string): string[] {
  const line = rawLine.replace(/\r$/, '');
  if (!line || line.length <= 3) return [];
  const statusX = line.charAt(0);
  const statusY = line.charAt(1);
  const payload = line.slice(3);
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

  // Note: When git core.quotePath is disabled (or for unquoted paths), if an original
  // filename contains literal ' -> ', splitting on the first ' -> ' is ambiguous without -z output.
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
  return Object.freeze(unique.map((p) => `':(exclude,glob)${p.replace(/'/g, "'\\''")}'`));
}

export function getGitCommitExcludePathspecsString(): string {
  return getGitCommitExcludePathspecs().join(' ');
}
