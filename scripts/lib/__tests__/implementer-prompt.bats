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

@test "implement prompt splits FINAL ACTION before MANDATORY RESULT FILE" {
  prompt="$(sed -n '/FINAL ACTION/,/IMPL_LOG_EOF/p' "$SCRIPT")"
  echo "$prompt" | grep -q "cat > implementation-log.md"
  result_block="$(sed -n '/MANDATORY RESULT FILE (Step N+1)/,/RESULT_EOF/p' "$SCRIPT")"
  echo "$result_block" | grep -q "cat > implement-task"

  final_action_line="$(grep -n 'FINAL ACTION' "$SCRIPT" | head -1 | cut -d: -f1)"
  result_file_line="$(grep -n 'MANDATORY RESULT FILE' "$SCRIPT" | head -1 | cut -d: -f1)"
  [ "$final_action_line" -lt "$result_file_line" ]
}

@test "implement prompt writes implementation-log.md not implementation-log-task-N.md" {
  grep -q "cat > implementation-log.md " "$SCRIPT"
  ! grep -q "implementation-log-task-\${task_n}" "$SCRIPT" || \
    grep -q "implementation-log.md\b" "$SCRIPT"
}
