import type { Failure, FailureKind } from '@ai-sdlc/domain';

export interface ClassifyExitInput {
  exitCode: number;
  combinedLogTail: string;
  runUuid?: string;
  artifacts?: string[];
  detectedAt?: Date;
}

interface Pattern {
  kind: FailureKind;
  regex: RegExp;
  suggestedAction: string;
}

const PATTERNS: Pattern[] = [
  {
    kind: 'missing_artifact',
    regex: /MISSING ARTIFACT|required artifact .* not found/i,
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
    regex: /branch changed from/i,
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
    regex: /fatal: .*git|git push failed/i,
    suggestedAction: 'Inspect the git state in the worktree.',
  },
  {
    kind: 'agent_blocked',
    regex: /agent reported BLOCKED/i,
    suggestedAction: 'The agent blocked itself — review the prompt and the reported reason.',
  },
];

const PHASE_REGEX = /(?:starting phase|PHASE=)\s*([a-z_-]+)/gi;

export function classifyExit(
  input: ClassifyExitInput,
): Omit<Failure, 'runUuid'> & { runUuid?: string } {
  const tail = input.combinedLogTail.slice(-8000);
  const phase = lastPhase(tail);

  for (const p of PATTERNS) {
    if (p.regex.test(tail)) {
      const result: Omit<Failure, 'runUuid'> & { runUuid?: string } = {
        kind: p.kind,
        message: firstMatch(tail, p.regex) ?? `Detected ${p.kind}`,
        exitCode: input.exitCode,
        canRetry: false,
        suggestedAction: p.suggestedAction,
        artifacts: input.artifacts ?? [],
        detectedAt: input.detectedAt ?? new Date(),
      };
      if (input.runUuid !== undefined) result.runUuid = input.runUuid;
      if (phase !== undefined) result.phase = phase;
      return result;
    }
  }

  const kind: FailureKind = input.exitCode === 1 ? 'command_failed' : 'unknown';
  const fallback: Omit<Failure, 'runUuid'> & { runUuid?: string } = {
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
  if (input.runUuid !== undefined) fallback.runUuid = input.runUuid;
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
  const m = text.match(regex);
  return m ? m[0] : undefined;
}
