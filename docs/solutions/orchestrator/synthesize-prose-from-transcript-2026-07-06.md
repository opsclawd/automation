---
module: orchestrator
tags: [implement, contract-validation, missing-artifact, transcript-tail, safety-net, result-writer]
problem_type: design-pattern
---

# Synthesize prose artifacts from transcript tail (Issue #640)

## Problem

When the `implement` phase's primary agent invocation ends with
`contract_violation` for `MISSING_REQUIRED_ARTIFACT` and the agent
never wrote the file, but it DID commit real work and DID narrate a
completion summary in its chat transcript, the existing pipeline
escalates to a full fallback invocation (a different model re-running
the entire task) just to produce a markdown file whose content is
already in the transcript. Concrete occurrences: run `50f4cb13`,
invocations `3ac5036b` and `7cccb01f`.

This is a distinct failure class from the misplaced-artifact
remediation (`#608` / `#613` — file written in the wrong place) and
from the no-op re-verification safety net (`#610` — file omitted
because there was no new work).

## Fix (port + impl + composition)

1. **Port** — `SynthesizeFromTranscriptPort` in
   `packages/application/src/ports/synthesize-from-transcript-port.ts`.
   Mirrors `ImplementArtifactGuardPort` in shape and idempotency
   contract. The result has three outcomes:
   `no_policy_match` (pre-flight gate failed), `synthesized` (writer
   produced the file), `synthesis_failed` (writer ran but produced
   nothing usable).

2. **Implementation** —
   `packages/infrastructure/src/agent/synthesize-from-transcript.ts`.
   Pre-flight policy (D3 + D4) gates on:

   - Prose artifact allow-list: `implementation-log.md`,
     `compound.md` (the two the issue names; additions are a code
     change to `PROSE_ARTIFACT_ALLOWLIST`, not a config toggle).
   - `primaryExitCode === 0` (D3.2).
   - `!workingTreeDirty` (D3).
   - `endCommitSha !== startCommitSha` — HEAD must have advanced
     (D4.c; the no-commit case stays with `ImplementArtifactGuard`).
   - Transcript tail length >= 200 bytes AND contains a summary
     marker (the existing `STATUS_REGEX` from
     `implement-artifact-guard.ts`, plus a `Files changed:`,
     `**Status:**`, or `# Heading` heuristic for `compound.md`).

   When the policy matches, the implementation invokes the
   `result-writer` profile (default `task-reviewer`; the prompt
   builder in `buildSynthesisPrompt` includes the transcript tail,
   `git log ${base}..HEAD`, and the first 500 lines of the diff so
   the writer can cross-check). The synthesis request is marked
   with `fallbackOfInvocationId: <primary>` and
   `fallbackReason: 'synthesized_from_transcript'` so the router
   emits a `phase.fallback.escalated` event with the synthesis
   reason for free. The new `fallbackTriggerSchema` value
   `'synthesized_from_transcript'` is metadata-only; no phase
   configures it as a real fallback trigger.

3. **Composition root** — `apps/api/src/compose.ts` instantiates
   `SynthesizeFromTranscript` alongside `ImplementArtifactGuard` and
   adds a sibling branch in the `runImplement` closure. The branch
   only runs when the existing guard did NOT recover AND exactly one
   prose-eligible artifact is still missing. On `synthesized` the
   primary row's outcome becomes `'success'`; on `synthesis_failed`
   or any thrown error the original
   `contract_violation / MISSING_REQUIRED_ARTIFACT` outcome is
   preserved and the router fallback fires unchanged.

## Why this is safer than adapter-level prose fallback

- **Single call site.** Like `ImplementArtifactGuard`, the synthesis
  lives in one place (`runImplement` inside `apps/api/src/compose.ts`),
  not in every adapter. The "is this artifact prose-eligible?" check
  is not duplicated across opencode / pi / claude-code / codex /
  antigravity adapters.
- **Recovery happens before the gates.** Same placement as the
  existing safety net: inside `runImplement`, which `ImplementStepLoop`
  calls *before* the typecheck / spec-review / quality-review gates
  run. A recovered step is validated exactly like a normal successful
  step — it cannot skip those gates just because the proof-of-work
  file was synthesized.
- **Cross-checking the transcript against the diff.** The writer is
  told to compare the narration against `git log ${base}..HEAD --stat`
  and the diff. A lying narration produces a `Status: BLOCKED`
  artifact, which the synthesis branch rejects as
  `synthesis_failed` and routes to fallback. The synthesis cannot
  amplify a hallucinated summary.
- **Provenance is visible.** A successful synthesis emits
  `artifact.synthesized_from_transcript` at warn level with
  `primaryInvocationId`, `synthesisInvocationId`, and `tailBytes`.
  The synthesis row links back to the primary via
  `fallbackOfInvocationId` in the timeline. No silent recovery.
- **One attempt only.** D5 cap is a code-level invariant — the
  implementation is a single function call, not a loop. The original
  `contract_violation` outcome is restored on any failure.

## Operational signals

- `artifact.synthesized_from_transcript` (warn) — synthesis fired and
  recovered. The run did not escalate to a full fallback. Still
  worth a periodic audit to confirm the writer's prose quality.
- `artifact.synthesis_failed` (warn) — synthesis ran but produced no
  usable artifact. The original fallback path proceeded. The
  `reason` field distinguishes `agent_outcome:<X>` from
  `writer_wrote_blocked` from `artifact_missing_after_invoke` from
  `agent_threw:<message>`.
- `artifact.synthesis_policy_not_satisfied` (info) — pre-flight
  policy returned false. The `reason` field is one of
  `artifact_not_in_allowlist`, `primary_exit_nonzero`,
  `working_tree_dirty`, `head_unchanged`, `tail_too_short`,
  `no_summary_markers`. This is the diagnostic trail for
  understanding how often the new fix actually applies.

## Layer-boundary notes

- Port lives in `packages/application/src/ports/synthesize-from-transcript-port.ts`.
- Production impl lives in `packages/infrastructure/src/agent/synthesize-from-transcript.ts`.
- Wiring happens in `apps/api/src/compose.ts:2236` (instantiation)
  and `apps/api/src/compose.ts:1898-1903` (branch insertion).
- No new infra→application imports. `pnpm depcruise` continues to
  pass.

## When to revisit

- If `artifact.synthesis_failed` fires frequently with
  `reason: writer_wrote_blocked`, the writer profile is rejecting
  the transcripts — the prompt builder may need a different cross-
  check heuristic, or the allow-list may be too aggressive.
- If `artifact.synthesis_policy_not_satisfied` fires frequently
  with `reason: head_unchanged`, that's the no-op re-verification
  case and `ImplementArtifactGuard` already owns it. The
  co-occurrence of the two is expected; do not merge them without
  evidence the boundary is wrong.
- Adding new prose artifacts to `PROSE_ARTIFACT_ALLOWLIST` is a
  code change. A future iteration could lift it to a config field
  if telemetry shows the allow-list churns.
