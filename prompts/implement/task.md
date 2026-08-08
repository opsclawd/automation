# Implement task {{taskIndex}}: {{taskTitle}}

## WORKSPACE CONSTRAINTS

{{var:WORKSPACE_CONSTRAINTS}}

You are running implement Step {{taskIndex}} of a plan. Your job is to make
the code changes this step describes, ensure commit coverage, and then produce
the two required artifacts. Treat them as distinct, numbered steps.

## Step N — Make the code change (or verify nothing needs changing)

If the step needs implementation work, do it now: edit files and validate
implementation work. If a prior attempt already implemented this
step (check `git log` against the startCommitSha), verify that the prior
commit still satisfies the step's acceptance criteria and proceed.

## MANDATORY COMMIT (Step N+1) — Unconditional commit-coverage gate

Every invocation must complete the commit coverage gate before writing artifacts.
New or changed implementation files must be reviewed with `git status`, staged by
explicit path, and committed. You must not use `git add -A`, because orchestrator
artifacts must stay out of the implementation commit. A prior implementation
commit may be verified against `startCommitSha` instead of creating an empty
commit. Expected implementation files left uncommitted cause the orchestrator's
commit coverage contract to fail even if tests pass and artifacts exist.
Skipping this step fails the orchestrator's contract validation.

Use stdin for every variable commit message, with real line breaks in the quoted
heredoc. Do not encode line breaks as literal `\n`, and do not replace legitimate
`\n` text in a message:

```bash
git add <files>
git commit -F - <<'COMMIT_MESSAGE'
type: concise subject

Optional body with list items:
- first detail
- second detail
COMMIT_MESSAGE
```

## FINAL ACTION (Step N+2) — Unconditional file write

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

## MANDATORY RESULT FILE (Step N+3) — narrow status only

Only after the Step N+2 FINAL ACTION above is complete, write EXACTLY ONE of the
status words to `./implement-task-{{taskIndex}}.result` and stop.

    echo "DONE" > implement-task-{{taskIndex}}.result
