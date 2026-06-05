---
title: Adapter artifact layout diverges from orchestrator path expectations — execa captures stdout, inv-<uuid>/ stderr
date: 2026-06-04
category: integration-issues
module: packages/infrastructure + scripts
problem_type: convention_divergence
component: external-cli-runner
symptoms:
  - shell `... | tee -a phase.log` produces 0-byte logs even though the agent printed output
  - a `.log` fallback in the orchestrator can never fire because the log is always empty
  - reviewer-retry stderr detection reads a phase-named path the adapter never creates
  - false-positive retries because the orchestrator greps the merged tee'd log (stdout+stderr) instead of stderr
root_cause: execa_captures_to_file_orchestrator_infers_a_different_path
resolution_type: code_fix
severity: high
related_components:
  - packages/infrastructure/src/agent/external-cli-runner.ts
  - packages/infrastructure/src/agent/opencode-adapter.ts
  - scripts/ai-run-issue-v2
tags:
  - execa
  - stdout-capture
  - artifact-layout
  - stderr-path
  - reviewer-retry
  - tee
---

# Adapter Artifact Layout vs Orchestrator Path Expectations

Two related bugs (issue #157, PR #183) share one root cause: the TypeScript adapters
and the bash orchestrator disagree about **where and how agent diagnostic output is
written**, with no shared contract. Each layer independently decides what to write,
where, and what to scan.

## Bug 1: `execa` with `reject: false` captures stdout — it does not forward it

`runExternalCli` (`external-cli-runner.ts`) and the opencode adapter run the child
with `execa(..., { reject: false })`, which **captures** the child's stdout into
JS variables and writes it to a per-invocation file. It never pipes the child's
stdout to the runner's own `process.stdout`. So the shell-side
`node run-agent.ts ... | tee -a phase.log` captures **nothing** — every `phase.log`
is 0 bytes.

Issue #157 had a `.log` fallback in `run_fix_review` that read the reviewer `.log`
when the `.md` was missing. Because the `.log` is always empty, the fallback was
**dead code that had never fired in production** — it created a false sense of safety
and delayed loud failure.

**Resolution (chosen):** remove the dead `.log` fallback and tighten the upstream
validation so the fallback is never needed (`validate_review_artifacts` now requires
a non-empty `.md` via `-s`, not just existence via `-f`). Raw ANSI-stripped agent
transcript is a poor substitute for structured `.md` findings anyway.

**Lesson:** an untested fallback path is worse than no fallback. Before relying on a
secondary capture path, verify end-to-end that data actually flows through it. With
`execa({ reject: false })`, child stdout lands in `result.stdout` and the adapter's
artifact file — not in the parent's stdout, and not in any shell pipe downstream of
the node process.

## Bug 2: the orchestrator infers a stderr path the adapter never creates

Adapters write stderr to a **per-invocation directory**:
`.ai-runs/agent-artifacts/inv-<uuid>/stderr.log`. The orchestrator's reviewer-retry
logic (`rerun_reviewer_with_retry`) instead inferred a **phase-named flat path**:
`{reviewer_type}-review-task-{n}.stderr.log`, first under `WORKTREE_DIR`, then
"fixed" to `REPO_ROOT/.ai-runs/agent-artifacts/`. The base directory got corrected but
the **file name still doesn't match** — no `spec-review-task-N.stderr.log` is ever
produced. The retry's provider-error detection silently depends on a fallback grep of
the tee'd `.log` (which mixes stdout+stderr and, per Bug 1, may be empty).

This also causes **false positives**: greping the merged stdout+stderr log means an
agent that merely *discusses* provider errors in its stdout can be reclassified as a
provider failure (the TS adapters deliberately scan stderr only — see
`docs/solutions/orchestrator/quota-error-watchdog-pattern-2026-05-29.md` on
`structuralOnly`).

**Lesson:** when the shell orchestrator needs an adapter's diagnostic output, it must
read the adapter's **actual artifact path**, not invent a phase-named one. The
adapter's layout (`inv-<uuid>/stderr.log`) is the contract. Inferring a parallel
naming convention guarantees silent breakage the moment the adapter's layout changes
(which it did, in issue #191's per-invocation isolation).

## The underlying gap

There is no shared contract between orchestrator and adapter for diagnostic-output
location or structure. Consequences seen across #157, #183, #192:
- duplicated provider-error regex patterns in TS (`error-patterns.ts`) and bash
  (`REVIEWER_PROVIDER_ERROR_PATTERNS`) that drift (e.g. bash `429` lacked `\b` word
  boundaries; `RESOURCE_EXHAUSTED` lacked `/i`);
- the orchestrator scanning merged logs while the adapter scans stderr-only.

A durable fix is to give the shell layer a way to resolve the per-invocation artifact
directory for a given run/phase (the adapters already write a deterministic
`inv-<uuid>/` under `agent-artifacts/`), and to generate the bash regex from the TS
source rather than hand-copying it — mirroring the existing `resolve_result`
TS/bash-shared convention.

## What to know before touching this

- `execa({ reject: false })` returns stdout/stderr on the result object and the
  adapter writes them to `inv-<uuid>/{stdout,stderr}.log`. Nothing reaches the
  parent process's stdout. Shell `| tee` after the node process sees only what
  `run-agent.ts` itself prints (typically diagnostics on stderr).
- The per-invocation directory name is `inv-<timestamp>-<rand>`; the shell finds it
  by scanning `agent-artifacts/` for `inv-*`, not by constructing a phase-named path.
- If you add a new orchestrator-side scan of agent output, point it at the actual
  artifact file and scan **stderr**, not the merged tee'd log, to avoid stdout false
  positives.

## Related

- `docs/solutions/orchestrator/silent-provider-failure-detection-2026-06-03.md` — the provider-error detection this stderr path feeds
- `docs/solutions/orchestrator/quota-error-watchdog-pattern-2026-05-29.md` — structural (stderr-only) vs unstructured scanning
- `docs/solutions/orchestrator/review-agent-contract-hardening-2026-05-19.md` — the `.md`/`.result` validation that replaced the dead `.log` fallback
