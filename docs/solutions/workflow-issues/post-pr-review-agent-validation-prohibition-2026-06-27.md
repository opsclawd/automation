---
title: Prevent post-pr-review Agent from Running Validation Commands
date: 2026-06-27
category: workflow-issues
module: pr-review
problem_type: workflow_issue
component: tooling
severity: medium
applies_when:
  - An agent type (e.g., antigravity/agy) has internal tool-call response timeouts shorter than the validation suite (~300s)
  - The orchestration design intentionally separates "agent fixes" from "orchestrator validates"
  - The post-pr-review phase agent runs autonomously and produces result.json
  - Running pnpm build/test/lint/typecheck/depcruise in the agent invocation window causes agent clock exhaustion
tags: [post-pr-review, agent-timeout, prompt-engineering, validation, pr-review]
---

# Prevent post-pr-review Agent from Running Validation Commands

## Context

The post-pr-review agent was autonomously running the full validation suite (`pnpm build`, `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm depcruise`, `pnpm test:bash`, `bash scripts/check-parity-coverage.sh`) during its invocation. This caused two problems:

1. **Agent clock exhaustion** — some agent runtimes (notably `antigravity` / "agy") have internal tool-call response timeouts. The validation suite takes ~300s, and the agent gets killed mid-run before writing `result.json`, producing a `missing_required_artifact` failure.

2. **Redundant work** — the orchestrator already runs validation deterministically in `verifyBuildPasses` (called from `verifyComment` after the agent finishes). The agent was doubling the wall-clock time.

## Guidance

Add explicit prohibition of validation commands to the agent's task prompt. The fix lives in the `renderTaskPrompt` closure in `apps/api/src/compose.ts` — the `## Instructions` section of the post-pr-review task prompt.

The prohibition block added:

```
---

**CRITICAL: Do NOT run any of the following commands.**
- Do NOT run npm/pnpm/yarn/bun build, test, lint, typecheck, depcruise, or test:bash
- Do NOT run any shell scripts that invoke tests or linters
- Do NOT run npm/pnpm/yarn/bun install or any package manager commands
- Do NOT verify your fix — the orchestrator handles all verification deterministically

Your ONLY responsibility is: read the comment, make a code change (if needed), commit and push the change (if one was made), write result.json, and stop immediately.
```

## Why This Matters

The architecture already has the correct separation of concerns: the **agent fixes**, the **orchestrator validates**. The bug was purely behavioral — the agent ran validation because the prompt didn't explicitly forbid it. Agent models generally honor explicit "do NOT run" instructions in their immediate task prompt, even when repo-level instructions (like AGENTS.md) say to verify work.

A prompt-only fix is the right tool for a prompt-driven problem. It required:
- No structural changes to `PollTaskRunner`, `ProcessPrReviewComments`, or `verifyComment`
- No changes to agent profiles or phase routing
- No new imports, interfaces, or type changes
- Zero test changes (all existing tests mock `renderTaskPrompt` with stubs)

Expected outcomes:
- Agent invocation time drops from ~300s to <60s per comment
- No more `missing_required_artifact` failures from agent timeout
- Build verification still runs (via `verifyBuildPasses` after the agent exits)
- The retry loop (3 attempts per comment) with `previousBuildError` feedback still handles build failures

## When to Apply

- When an agent in the orchestration pipeline autonomously runs validation and times out, check if the task prompt explicitly forbids validation before reaching for structural changes
- When the architecture already separates "agent does X" from "orchestrator verifies X", but a race condition or timeout makes them collide, fix the agent's prompt first — it's the cheapest intervention
- When considering approach A (prompt-only), B (new phase), or C (runtime enforcement): prefer A if the architecture isolates concerns correctly and the bug is purely behavioral

## Examples

**Before** (compose.ts renderTaskPrompt — lines 2125-2137):

```typescript
'Make a judgement call: is this comment technically valid?',
'',
'If a code change is required:',
'1. Edit the relevant source files',
'2. Stage and commit: `git add -A && git commit -m "fix: address PR review feedback"`',
`3. Push: \`git push origin '${branch.replace(/'/g, "'\\''")}'\``,
'',
'If the comment is invalid, include your reasoning in replyBody.',
'',
'IMPORTANT: Do NOT post replies yourself. The orchestrator handles posting.',
```

**After** (compose.ts renderTaskPrompt — lines 2125-2162):

```typescript
'Make a judgement call: is this comment technically valid?',
'',
'If a code change is required:',
'1. Edit the relevant source files',
'2. Stage and commit: `git add -A && git commit -m "fix: address PR review feedback"`',
`3. Push: \`git push origin '${branch.replace(/'/g, "'\\''")}'\``,
'',
'If the comment is invalid, include your reasoning in replyBody.',
'',
'IMPORTANT: Do NOT post replies yourself. The orchestrator handles posting.',
'',
'---',
'',
'**CRITICAL: Do NOT run any of the following commands.**',
'- Do NOT run npm/pnpm/yarn/bun build, test, lint, typecheck, depcruise, or test:bash',
'- Do NOT run any shell scripts that invoke tests or linters',
'- Do NOT run npm/pnpm/yarn/bun install or any package manager commands',
'- Do NOT verify your fix — the orchestrator handles all verification deterministically',
'',
'Your ONLY responsibility is: read the comment, make a code change (if needed), commit and push the change (if one was made), write result.json, and stop immediately.',
```

## Related

- `apps/api/src/compose.ts` — `renderTaskPrompt` closure (lines 2079-2162)
- `packages/application/src/pr-review/` — PollTaskRunner, ProcessPrReviewComments, verifyComment (no changes needed)
- `docs/solutions/developer-experience/` — related DX patterns
