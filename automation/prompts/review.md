Run `ce:code-review`.

Review the current branch against the base branch.

Rules:
- You did not write this code.
- Find production defects.
- Do not praise.
- Return only blocking, high, and medium findings.
- Every finding must include:
  - severity
  - file path
  - evidence from diff or code
  - failure mode
  - required fix
- Write the review output to `.ai-runs/issue-${ISSUE}/code-review.md`.

After review, stop.
