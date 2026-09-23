You are analyzing a GitHub issue to produce a design document.

## CONTEXT

{{var:WORKSPACE_CONSTRAINTS}}

You are working in the repository worktree.
Issue file: issue.md (contains the GitHub issue description)
Comments file: issue-comments.md (contains issue comments, may not exist)

## TASK

1. Load the brainstorming skill: say exactly `/skill brainstorming` to activate it.
2. Read `issue.md` and `issue-comments.md` (if it exists) thoroughly.
3. Analyze the codebase to understand the existing patterns, types, and architecture relevant to this issue.
4. Using the brainstorming skill guidance, produce a design document at `./design.md` covering:
   - The problem being solved and why it matters
   - Key design decisions and trade-offs considered
   - Proposed approach with rationale
   - Assumptions made (do not ask questions — state assumptions explicitly)
   - What is in scope and what is explicitly out of scope
   - Any risks or concerns identified from code analysis
   - Downstream consumer traceability: downstream consumer requirements are future capabilities enabled by this issue's contracts, not present-tense verification targets for this PR. When documenting traceability or forward-looking architectural support for downstream consumers, distinguish "this design enables a future capability / provides contract representability" from "this PR must presently verify or execute the downstream capability." Do not formulate traceability matrix items or design commitments as present-tense verification obligations or hard gates for downstream exit-gate deliverables (such as real-provider validation, locked SHA runs, or phase completion sign-off).
   - Tooling and testing conventions: when specifying a new script, test, or tooling surface, explicitly state which existing repository convention it follows (e.g., "tests use vitest, matching every other test file in this repo") rather than leaving tooling choices implicit.
   - Exit-gate and candidate-validation governance boundary: when designing candidate-validation exit gates or audit closeouts, specify harness code, validation runner scripts, integration test suites, and blank report templates (e.g. `docs/*-report-template.md` with placeholder tokens like `<pinned-candidate-sha>`, `[ ] GO`, and `[ ] NO-GO`) only. Never specify automated agents filling in, signing, or committing candidate validation reports or audit closeout records — candidate reports, sign-offs, and release promotion decisions are strictly post-merge governance records authored and signed exclusively by human operators.

## CRITICAL RULES

- Do NOT ask questions. Make reasonable assumptions and document them explicitly.
- Do NOT rely on agent memory. Write everything to `design.md`.
- Do NOT switch branches (no `git checkout`, `git switch`, `git stash branch`).
- Stop after writing `design.md`. Do not implement anything.
