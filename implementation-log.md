# Implementation Log - Task 8

Implemented Task 8: Update docs/quickstart.md flag table.

## What was implemented
1. **Updated the Flag Table in Documentation**:
   - Modified `docs/quickstart.md` to update the flag table for the `run` command.
   - Labeled `--model` and `--agent-cli` as Bash executor only, and clarified they are rejected for `--executor ts`.
   - Clarified `--base-branch` default behavior (target repository default branch) and its usage (worktree creation and PR base).
2. **Link Verification**:
   - Confirmed the schema reference on line 62 in the Configuration section: `[packages/shared/src/config/schema.ts](../packages/shared/src/config/schema.ts)` still points to a valid file path and remains unchanged.

## Verification
- Checked the contents of `docs/quickstart.md` manually to ensure the formatting and markdown table are correct.
- Verified that `packages/shared/src/config/schema.ts` exists.
