Run `ce:compound`.

Goal:
Capture implementation learnings from this issue before review context dominates the session.

Input files:
- `.ai-runs/issue-${ISSUE}/issue.md`
- `.ai-runs/issue-${ISSUE}/implementation-plan.md`
- `.ai-runs/issue-${ISSUE}/implementation-log.md`
- `.ai-runs/issue-${ISSUE}/validation-initial.log`

Rules:
- Capture implementation findings.
- Capture reusable repo patterns.
- Capture file/module relationships.
- Capture test strategy.
- Mark the solution learning as pre-review / draft if appropriate.
- Do not turn this into a review report.
- Prefer creating/updating a relevant file under `docs/solutions/`.

After compounding, stop.
