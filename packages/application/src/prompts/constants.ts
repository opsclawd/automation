export const WORKSPACE_CONSTRAINTS = `## WORKSPACE CONSTRAINTS

Your working directory is a dedicated git worktree with the repository's complete history. Run all commands from it. Do NOT cd to or read paths outside this directory — external-directory access is automatically rejected. git log, git diff, etc. work here directly.

.ai-orchestrator.local.json, if one exists, lives only in the main checkout and is intentionally not copied into your worktree — it is operator-machine-specific and not part of your task. Do not search for it or read it outside this directory. Reason about configuration using only .ai-orchestrator.json in your own working directory; treat it as the effective config for your task.`;

export function getPostPrReviewCommitPolicy(isBatch: boolean): string {
  const subject = isBatch ? 'these comments' : 'this comment';
  const verb = isBatch ? 'are' : 'is';
  const readSubject = isBatch ? 'the comments' : 'the comment';
  return `## Instructions

Make a judgement call: ${verb} ${subject} technically valid?

If code changes are required:
1. Edit the relevant source files
2. Commit your changes:
   a. Record HEAD before: \`PRE_HEAD=$(git rev-parse HEAD)\`
   b. Stage and commit: \`git add -A && git commit -m "fix: address PR review feedback"\`
   c. If git commit exits non-zero, the pre-commit hook failed. Read the hook/lint
      output, FIX the reported errors, and retry the commit. Never report a fixed action with a failed or skipped commit.
   d. After a successful commit, confirm HEAD advanced:
      \`[ "$(git rev-parse HEAD)" != "$PRE_HEAD" ] || { echo "COMMIT DID NOT ADVANCE HEAD"; exit 1; }\`
   e. Confirm clean worktree:
      \`[ -z "$(git status --porcelain)" ] || { echo "WORKTREE DIRTY AFTER COMMIT"; exit 1; }\`
3. Do NOT push. The orchestrator will push only after validation passes.

If ${isBatch ? 'comments are' : 'the comment is'} invalid, include your reasoning in replyBody.

IMPORTANT: Do NOT post replies yourself. The orchestrator handles posting.
IMPORTANT: Do NOT push to any remote branch.

---

**CRITICAL: Do NOT run any of the following commands.**
- Do NOT run npm/pnpm/yarn/bun build, test, lint, typecheck, boundaries, or test:bash
- Do NOT run any shell scripts that invoke tests or linters
- Do NOT run npm/pnpm/yarn/bun install or any package manager commands
- Do NOT verify your fix - the orchestrator handles all verification deterministically

Your ONLY responsibility is: read ${readSubject}, make code changes (if needed), commit the changes locally (verifying HEAD advanced), write your output, and stop immediately.`;
}
