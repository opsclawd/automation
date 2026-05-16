import type { Failure, FailureKind, ClassifyExitInput } from '@ai-sdlc/domain';

export type { ClassifyExitInput } from '@ai-sdlc/domain';

interface Pattern {
  kind: FailureKind;
  regex: RegExp;
  suggestedAction: string;
}

const PATTERNS: Pattern[] = [
  {
    kind: 'missing_artifact',
    regex: /MISSING ARTIFACT|required artifact .* not found|not found after|not found in worktree/i,
    suggestedAction:
      'Inspect the phase prompt and stdout; the agent did not produce the expected file.',
  },
  {
    kind: 'invalid_result',
    regex: /invalid result file|unexpected result value/i,
    suggestedAction: 'Inspect the agent result.json and prompt template.',
  },
  {
    kind: 'branch_changed',
    regex: /(?:branch changed from|switched branch from)/i,
    suggestedAction:
      'Reset the worktree branch and retry; verify the agent prompt does not switch branches.',
  },
  {
    kind: 'timeout',
    regex: /timed? out|TIMEOUT/i,
    suggestedAction: 'Raise invocationMaxMinutes or investigate why the agent hung.',
  },
  {
    kind: 'validation_failed',
    regex: /validate phase failed|pnpm (test|lint|build|typecheck) failed/i,
    suggestedAction: 'Open the validate phase logs and rerun the failing command locally.',
  },
  {
    kind: 'github_failed',
    regex: /gh: api error|gh: HTTP \d{3}/i,
    suggestedAction: 'Check `gh auth status` and rate-limit headers.',
  },
  {
    kind: 'git_failed',
    regex:
      /fatal:|git push failed|Failed to push branch|Failed to checkout .* in worktree|Failed to attach worktree to local branch|Failed to recreate worktree from origin|is still not a worktree/i,
    suggestedAction: 'Inspect the git state in the worktree.',
  },
  {
    kind: 'agent_blocked',
    regex: /(?:agent reported BLOCKED|[Pp]hase '[^']+' is blocked|\b BLOCKED\b)/i,
    suggestedAction: 'The agent blocked itself — review the prompt and the reported reason.',
  },
];

const PHASE_REGEX = /(?:=== Phase:|starting phase|PHASE=)\s*([a-z_-]+)/gi;

export function classifyExit(input: ClassifyExitInput): Failure {
  const tail = input.combinedLogTail.slice(-8000);
  const phase = lastPhase(tail);

  for (const p of PATTERNS) {
    p.regex.lastIndex = 0;
    if (p.regex.test(tail)) {
      const result: Failure = {
        runUuid: input.runUuid,
        kind: p.kind,
        message: firstMatch(tail, p.regex) ?? `Detected ${p.kind}`,
        exitCode: input.exitCode,
        canRetry: false,
        suggestedAction: p.suggestedAction,
        artifacts: input.artifacts ?? [],
        detectedAt: input.detectedAt ?? new Date(),
      };
      if (phase !== undefined) result.phase = phase;
      return result;
    }
  }

  const kind: FailureKind = input.exitCode === 1 ? 'command_failed' : 'unknown';
  const fallback: Failure = {
    runUuid: input.runUuid,
    kind,
    message:
      tail
        .split('\n')
        .filter((l) => l.trim())
        .slice(-3)
        .join('\n')
        .trim() || `Exited with code ${input.exitCode}`,
    exitCode: input.exitCode,
    canRetry: false,
    suggestedAction: 'Inspect combined.log and stderr.log for the cause.',
    artifacts: input.artifacts ?? [],
    detectedAt: input.detectedAt ?? new Date(),
  };
  if (phase !== undefined) fallback.phase = phase;
  return fallback;
}

function lastPhase(tail: string): string | undefined {
  let m: RegExpExecArray | null;
  let last: string | undefined;
  while ((m = PHASE_REGEX.exec(tail))) last = m[1];
  PHASE_REGEX.lastIndex = 0;
  return last;
}

function firstMatch(text: string, regex: RegExp): string | undefined {
  if (regex.global) throw new Error('firstMatch requires a non-global regex');
  const idx = text.search(regex);
  if (idx === -1) return undefined;
  const lineStart = text.lastIndexOf('\n', idx - 1) + 1;
  const lineEnd = text.indexOf('\n', idx);
  return text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim();
}
