# Implement task {{taskIndex}}: {{taskTitle}}

You are running implement Step {{taskIndex}} of a plan. Your job is to make
the code changes this step describes and then produce the two required
artifacts. Treat them as two distinct, numbered steps.

## Step N — Make the code change (or verify nothing needs changing)

If the step needs implementation work, do it now: edit files, run
`pnpm -r typecheck`, commit. If a prior attempt already implemented this
step (check `git log` against the startCommitSha), verify that the prior
commit still satisfies the step's acceptance criteria and proceed.

## FINAL ACTION (Step N+1) — Unconditional file write

Before you stop, you MUST write exactly one file named `implementation-log.md`
at the worktree root (`./implementation-log.md`, NOT `implementation-log-task-{{taskIndex}}.md`,
NOT `report.md`, NOT stdout). This runs irrespective of whether you made
any code changes. Skipping this step fails the orchestrator's contract
validation even if your task is fully done.

The file MUST begin with:

    Status: DONE|DONE_WITH_CONCERNS|BLOCKED|NEEDS_CONTEXT

followed by 1-3 lines describing what changed (or "no changes — task
already complete at <sha>" for a re-verification) and a `Files changed:`
section listing the paths touched in this run (or `none` for a no-op
re-verification).

If your Step needs no implementation work because a prior commit already
implements it, the FINAL ACTION still runs. Treat the write as the
contract — your prose DONE does not satisfy the contract.

## MANDATORY RESULT FILE (Step N+2) — narrow status only

Only after the FINAL ACTION above is complete, write EXACTLY ONE of the
status words to `./implement-task-{{taskIndex}}.result` and stop.

    echo "DONE" > implement-task-{{taskIndex}}.result
