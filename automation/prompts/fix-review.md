You are fixing AI code review findings.

Input files:
- `.ai-runs/issue-${ISSUE}/code-review.md`
- `.ai-runs/issue-${ISSUE}/implementation-plan.md`
- `.ai-runs/issue-${ISSUE}/issue.md`

Rules:
- Fix only legitimate review findings.
- Do not expand scope.
- Do not rewrite working code for style preference.
- If a finding is invalid, document why in `.ai-runs/issue-${ISSUE}/review-fix-log.md`.
- If a finding is fixed, document the fix in `.ai-runs/issue-${ISSUE}/review-fix-log.md`.
- Do not create a PR.
- Do not compound.

After fixes, stop.
