---
module: orchestrator
tags: [implement, contract-validation, missing-artifact, prompt-template, safety-net]
problem_type: design-pattern
---

# No-op re-verification safety net (Issue #610)

## Problem

When the `implement` phase re-invokes an agent for a Step that was already
committed in a previous (interrupted) attempt, the agent frequently concludes
"this task is already complete" and emits a chat-style prose DONE — without
ever calling the file-write tool to produce `implementation-log.md`. The
orchestrator validates Step completion on the artifact's existence alone, so
the step is reclassified as `MISSING_REQUIRED_ARTIFACT` and the run escalates
to a fallback invocation that burns another model call for work that is
already on disk.

## Fix (two components)

1. **Prompt restructure (primary).** Split the existing "MANDATORY RESULT
   FILE" block in `scripts/legacy/ai-run-issue-v2` into a numbered
   FINAL ACTION that mandates an unconditional `implementation-log.md`
   write, followed by the narrow `implement-task-<n>.result` status
   write. Same restructure lives in `prompts/implement/task.md` for
   TS-handler migration. See `scripts/legacy/ai-run-issue-v2` lines
   containing `FINAL ACTION` and `MANDATORY RESULT FILE`.

2. **Orchestrator safety net.** A new port
   `ImplementArtifactGuardPort` (`packages/application/src/ports/implement-artifact-guard-port.ts`)
   runs inside `ImplementHandler` when the agent returns
   `contract_violation` with `MISSING_REQUIRED_ARTIFACT` as the sole
   violation. The guard fires only when:
   - The expected artifact is `implementation-log.md`.
   - The transcript tail (or a `result.json`) declares DONE.
   - `headCommitSha(cwd) == startCommitSha` (no new commit).
   - `status(cwd)` is empty (no uncommitted work).

   When all four hold, the guard synthesizes a minimal
   `implementation-log.md` from verifiable state (no LLM-derived text),
   re-runs `validateAgentContract`, and emits
   `step.artifact.synthesized` with reason `no_op_reverification_done_declared`.
   When the policy is false, it emits `step.artifact.not_synthesized`
   and the existing fallback path proceeds unchanged.

## Why this is safer than adapter-level prose fallback

The fix lives in the implement handler (single call site), not in every
adapter. The synthesized content carries no factual claims beyond what
the orchestrator can derive from the DB and git. A genuine-failure case
(agent did work but forgot the artifact, leaving a non-clean tree or a
new commit) still fails the contract and triggers the fallback path —
the prior semantics are preserved.

## Operational signals

- `step.artifact.synthesized` (warn) — safety net fired; the run did
  not escalate. Operators should still review whether the prompt change
  is biting in their preferred profile.
- `step.artifact.not_synthesized` (info) — guard policy returned false.
  This is the diagnostic trail that shows the no-op-narrative case is
  happening, separate from how often the safety net recovers.

## Layer-boundary notes

The guard is a port-and-injectable: interface in `application/ports.ts`,
fake in `application/test-doubles/`, production impl in
`infrastructure/agent/implement-artifact-guard.ts`. The
`ImplementHandler` holds the guard as an optional injectable; no new
infra→application imports. `pnpm depcruise` continues to pass.

## When to revisit

- If `step.artifact.not_synthesized` fires frequently with reason
  `policy_not_satisfied` (e.g. working tree dirty), the prompt change is
  insufficient and per-runtime routing (the issue's third suggestion)
  becomes attractive — but only as a secondary optimization, not a
  primary fix.
- If the implement phase migrates fully to the TS handler, delete
  `scripts/legacy/ai-run-issue-v2` (and its prompt regression test in
  `scripts/lib/__tests__/implementer-prompt.bats`). Out of scope here.
