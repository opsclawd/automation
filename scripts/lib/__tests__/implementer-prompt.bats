#!/usr/bin/env bats

# Regression guard for issue-285: the implementer prompt embeds shell snippets
# (PRE_HEAD=$(git rev-parse HEAD), [ "$(git rev-parse HEAD)" != "$PRE_HEAD" ], ...)
# that are LITERAL instructions for the agent. They must be escaped in the
# IMPLEMENTER_PROMPT="..." double-quoted string, or the orchestrator (set -u)
# expands $PRE_HEAD itself and dies with "PRE_HEAD: unbound variable".

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  SCRIPT="$REPO_ROOT/scripts/legacy/ai-run-issue-v2"
}

@test "IMPLEMENTER_PROMPT builds under set -u without an unbound-variable crash" {
  # Extract the IMPLEMENTER_PROMPT="..." assignment (start through its close line).
  local block
  block=$(awk '/IMPLEMENTER_PROMPT="/{f=1} f{print} /\$\{BRANCH\}\."$/{exit}' "$SCRIPT")
  run bash -c '
    set -euo pipefail
    task_n=1; task_title="t"; task_text="x"; _cc_msg="m"; BRANCH="b"; WORKTREE_DIR="/w"
    '"$block"'
    printf "%s" "$IMPLEMENTER_PROMPT"
  '
  [ "$status" -eq 0 ]
  # The agent must receive these as literal instructions, not orchestrator-expanded.
  [[ "$output" == *'PRE_HEAD=$(git rev-parse HEAD)'* ]]
  [[ "$output" == *'"$(git rev-parse HEAD)" != "$PRE_HEAD"'* ]]
  [[ "$output" == *'[ -z "$(git status --porcelain)" ]'* ]]
}

@test "implementer prompt does not contain an orchestrator-expanding \$PRE_HEAD" {
  # The unescaped form would be expanded by the orchestrator and crash under set -u.
  run grep -nF '"$PRE_HEAD"' "$SCRIPT"
  [ "$status" -ne 0 ]
}
