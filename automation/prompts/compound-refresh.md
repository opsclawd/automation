Run `ce:compound-refresh`.

Goal:
Refresh the existing implementation learning after review and review-fix work.

Input files:
- `.ai-runs/issue-${ISSUE}/implementation-plan.md`
- `.ai-runs/issue-${ISSUE}/implementation-log.md`
- `.ai-runs/issue-${ISSUE}/code-review.md`
- `.ai-runs/issue-${ISSUE}/review-fix-log.md`
- `.ai-runs/issue-${ISSUE}/validation-final.log`

Rules:
- Preserve implementation learnings that remain true.
- Add review-caught traps.
- Add corrections discovered during review.
- Remove or revise anything invalidated by review.
- Do not turn the solution doc into a review report.
- The final docs/solutions entry should teach future agents how to implement this class of change safely.

After refresh, stop.
