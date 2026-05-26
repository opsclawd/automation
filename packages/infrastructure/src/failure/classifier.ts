import type { Failure, FailureKind, ClassifyExitInput, ClassifierEvent } from '@ai-sdlc/domain';

export type { ClassifyExitInput, ClassifierEvent } from '@ai-sdlc/domain';

interface Pattern {
  kind: FailureKind;
  regex: RegExp;
  suggestedAction: string;
}

const PATTERNS: Pattern[] = [
  {
    kind: 'missing_artifact',
    regex:
      /MISSING ARTIFACT|required artifact .* not found|not found after|not found in worktree|no findings to act on/i,
    suggestedAction:
      'Inspect the phase prompt and stdout; the agent did not produce the expected file.',
  },
  {
    kind: 'invalid_result',
    regex: /invalid result file|unexpected result value|No tasks found in plan\.md/i,
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
    regex:
      /validate phase failed|pnpm (test|lint|build|typecheck) failed|\[(?:build|lint|typecheck|test) failed\]/i,
    suggestedAction: 'Open the validate phase logs and rerun the failing command locally.',
  },
  {
    kind: 'github_failed',
    regex: /gh: api error|gh: HTTP \d{3}|Failed to fetch issue|Failed to create PR and no open PR/i,
    suggestedAction: 'Check `gh auth status` and rate-limit headers.',
  },
  {
    kind: 'git_failed',
    regex:
      /fatal:|git push failed|Failed to push branch|Failed to checkout .* in worktree|Failed to attach worktree to local branch|Failed to recreate worktree from origin|is still not a worktree|Worktree missing and no local or remote branch|Worktree creation failed|Worktree has no commits/i,
    suggestedAction: 'Inspect the git state in the worktree.',
  },
  {
    kind: 'agent_blocked',
    regex:
      /(?:agent reported BLOCKED|[Pp]hase '[^']+' is blocked|\bis (?:BLOCKED|NEEDS_CONTEXT)\b|fix review is blocked|ai:blocked|blocked from previous phase|reviews failing|review loop hit max|exited review loop)/i,
    suggestedAction: 'The agent blocked itself — review the prompt and the reported reason.',
  },
];

const PHASE_REGEX = /(?:=== Phase:|starting phase|PHASE=)\s*([a-z_-]+)/gi;

// Absolute floor: any failure completing in under 30 seconds cannot be a
// legitimate timeout, regardless of phase or invocation budget.  Phase-level
// timeouts in scripts/ai-run-issue-v2 start at 300 s (TIMEOUT_VALIDATE); a
// ratio-based threshold against the global invocationMaxMinutes would suppress
// genuine phase timeouts, so we use an absolute minimum instead.
// See opsclawd/automation#107 and PR #110 review discussion.
const MIN_TIMEOUT_ELAPSED_MS = 30_000;

function timeoutPlausible(input: ClassifyExitInput): boolean {
  if (input.elapsedMs === undefined) return true;
  return input.elapsedMs >= MIN_TIMEOUT_ELAPSED_MS;
}

export function classifyExit(input: ClassifyExitInput): Failure {
  if (input.events && input.events.length > 0) {
    // Event-driven classification is attempted first. When the terminal event
    // matches a structured metadata rule (e.g. missingArtifact, reason pattern),
    // its result is used directly. When no rule matches (the catch-all case),
    // buildFailureFromEvent returns null and the classifier falls through to
    // log scraping — preserving artifact/specific classifications that the
    // event's reason string alone would lose.
    const terminal = pickTerminalEvent(input.events);
    if (terminal) {
      const fromEvent = buildFailureFromEvent(terminal, input);
      if (fromEvent !== null) return fromEvent;
    }
  }

  const tail = input.combinedLogTail.slice(-8000);
  const phase = lastPhase(tail);

  let best: { pattern: Pattern; matchIndex: number } | undefined;
  for (const p of PATTERNS) {
    if (p.kind === 'timeout' && !timeoutPlausible(input)) continue;
    const gRegex = new RegExp(p.regex.source, p.regex.flags + 'g');
    let m: RegExpExecArray | null;
    while ((m = gRegex.exec(tail))) {
      if (!best || m.index > best.matchIndex) {
        best = { pattern: p, matchIndex: m.index };
      }
    }
  }

  if (best) {
    const lineStart = tail.lastIndexOf('\n', best.matchIndex - 1) + 1;
    const lineEnd = tail.indexOf('\n', best.matchIndex);
    const message = tail.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim();
    const result: Failure = {
      runUuid: input.runUuid,
      kind: best.pattern.kind,
      message: message || `Detected ${best.pattern.kind}`,
      exitCode: input.exitCode,
      canRetry: false,
      suggestedAction: best.pattern.suggestedAction,
      artifacts: input.artifacts ?? [],
      detectedAt: input.detectedAt ?? new Date(),
    };
    if (phase !== undefined) result.phase = phase;
    return result;
  }

  // When timeoutPlausible gates out the timeout pattern and no other pattern
  // matches, the exit code drives the fallback: exit 1 → command_failed,
  // anything else → unknown. Both are more honest than a false "timeout" —
  // the caller (bash orchestrator) already has an accurate exit-code label
  // from the case statement, and "unknown + inspect logs" is actionable.
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

// Event-driven classification does not produce github_failed or git_failed
// kinds. Those remain log-scraping-only until corresponding event types are defined.

function pickTerminalEvent(events: ClassifierEvent[]): ClassifierEvent | undefined {
  // Walk events in reverse chronological order (most recent first) to find the
  // terminal event that best represents *why* the run failed.
  //
  // Special case: when loop.exhausted and phase.failed are emitted for the
  // same phase (the "paired" pattern), loop.exhausted is preferred because
  // it carries the structured agent_blocked signal. A generic phase.failed
  // following loop.exhausted in fix-review would regress to command_failed.
  //
  // But when phase.failed comes from a LATER phase (e.g. compound or create-pr
  // after fix-review exhausted), it represents the true terminal failure and
  // must not be overridden by a stale loop.exhausted from an earlier phase.
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === 'phase.failed') {
      // If there is a paired loop.exhausted in the same phase before this
      // event, prefer the loop.exhausted — it is the more informative signal.
      const paired = findPairedLoopExhausted(events, e, i);
      if (paired) return paired;
      return e;
    }
    if (e.type === 'loop.exhausted') {
      // This is the most recent terminal event. It wins unless a later
      // phase.failed from a different phase already matched above.
      // Since we're walking reverse, reaching here means no later
      // phase.failed exists, so loop.exhausted is the terminal event.
      return e;
    }
  }
  return lastOf(events, (e) => e.type === 'run.failed');
}

function findPairedLoopExhausted(
  events: ClassifierEvent[],
  phaseFailed: ClassifierEvent,
  phaseFailedIndex: number,
): ClassifierEvent | undefined {
  // A loop.exhausted is "paired" with phase.failed when it appears in the
  // same phase, earlier in the stream. This handles the common pattern where
  // a fix-review loop emits both events for the same exhaustion incident.
  if (phaseFailed.phase === undefined) return undefined;
  for (let j = phaseFailedIndex - 1; j >= 0; j--) {
    const candidate = events[j]!;
    if (candidate.type === 'loop.exhausted' && candidate.phase === phaseFailed.phase) {
      return candidate;
    }
  }
  return undefined;
}

function lastOf<T>(arr: T[], pred: (t: T) => boolean): T | undefined {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (pred(arr[i]!)) return arr[i];
  }
  return undefined;
}

function buildFailureFromEvent(e: ClassifierEvent, input: ClassifyExitInput): Failure | null {
  const meta = e.metadata ?? {};
  const reason = typeof meta.reason === 'string' ? meta.reason : '';
  const missingArtifact =
    typeof meta.missingArtifact === 'string' ? meta.missingArtifact : undefined;
  const command = typeof meta.command === 'string' ? meta.command : undefined;
  const metaExit = typeof meta.exitCode === 'number' ? meta.exitCode : undefined;

  let kind: FailureKind;
  let message = e.message || '';
  let suggestedAction = 'Inspect the failed phase artifacts and stderr.log.';

  if (e.type === 'loop.exhausted') {
    kind = 'agent_blocked';
    suggestedAction = 'The fix-review loop hit max iterations — inspect the latest review.md.';
  } else if (e.type === 'run.failed') {
    kind = 'unknown';
    suggestedAction = 'Inspect combined.log and stderr.log for the cause.';
  } else if (missingArtifact !== undefined) {
    kind = 'missing_artifact';
    message = `Missing artifact: ${missingArtifact}`;
    suggestedAction =
      'Inspect the phase prompt and stdout; the agent did not produce the expected file.';
  } else if (/invalid result/i.test(reason)) {
    kind = 'invalid_result';
    suggestedAction = 'Inspect the agent result.json and prompt template.';
  } else if (/(?:branch changed from|switched branch from|branch drifted)/i.test(reason)) {
    kind = 'branch_changed';
    suggestedAction =
      'Reset the worktree branch and retry; verify the agent prompt does not switch branches.';
  } else if (/timeout|timed out/i.test(reason) && timeoutPlausible(input)) {
    kind = 'timeout';
    suggestedAction = 'Raise invocationMaxMinutes or investigate why the agent hung.';
  } else if (/blocked/i.test(reason)) {
    kind = 'agent_blocked';
    suggestedAction = 'The agent blocked itself — review the prompt and the reported reason.';
  } else if (e.phase === 'validate' && command !== undefined) {
    kind = 'validation_failed';
    message = `${command} exited ${metaExit ?? input.exitCode}`;
    suggestedAction = 'Open the validate phase logs and rerun the failing command locally.';
  } else {
    return null;
  }

  const failure: Failure = {
    runUuid: input.runUuid,
    kind,
    message: message || `Detected ${kind}`,
    exitCode: metaExit ?? input.exitCode,
    canRetry: false,
    suggestedAction,
    artifacts: input.artifacts ?? [],
    detectedAt: new Date(e.timestamp),
  };
  if (e.phase !== undefined) failure.phase = e.phase;
  return failure;
}
