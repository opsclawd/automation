You are resolving pull request comments.

Input files:
- `.ai-runs/pr-${PR}/pr-comments.md`
- `.ai-runs/pr-${PR}/pr-review-comments.json`
- `.ai-runs/pr-${PR}/pr-issue-comments.json`

Rules:
- Address each actionable human PR comment individually.
- Ignore bot comments unless they contain concrete failing checks.
- Do not argue.
- Do not expand scope.
- Make the minimum code changes needed.
- Write a response plan to `.ai-runs/pr-${PR}/pr-comment-response-plan.md`.
- Write implementation notes to `.ai-runs/pr-${PR}/pr-comment-fix-log.md`.

After fixes, stop.
