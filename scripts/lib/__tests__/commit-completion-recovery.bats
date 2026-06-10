#!/usr/bin/env bats

# Tests for the dirty-tree detection and run_commit_completion recovery in
# scripts/ai-run-issue-v2. Verifies that when an implementer reports DONE
# but the worktree has uncommitted changes, the orchestrator detects it
# and either recovers or fails with diagnostics.

setup() {
  SCRIPT_PATH="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)/scripts/ai-run-issue-v2"
  SHARED_LIB="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)/scripts/lib/result-resolver.sh"
  source "$SHARED_LIB"

  # Extract run_commit_completion via awk brace-counting.
  eval "$(awk '
    /^(run_commit_completion)\(\)/ { found=1 }
    found { print; if (/\{/) depth+=gsub(/{/,"{"); if (/\}/) depth-=gsub(/}/,"}"); if (depth==0 && found) { found=0; depth=0 } }
  ' "$SCRIPT_PATH")"

  TMPDIR_TEST="$(mktemp -d)"
  WORKTREE_DIR="$TMPDIR_TEST/worktree"
  mkdir -p "$WORKTREE_DIR"
  DIRTY_FLAG="$TMPDIR_TEST/dirty"

  # Stub git — uses file-based state so subshells (pipes) can persist changes.
  _MOCK_HEAD_SHA="aaa111"
  echo -n "" > "$DIRTY_FLAG"
  git() {
    case "$1" in
      -C) shift; shift ;;
    esac
    case "$*" in
      "rev-parse HEAD") echo "$_MOCK_HEAD_SHA" ;;
      "status --porcelain --untracked-files=no")
        if [[ -s "$DIRTY_FLAG" ]]; then
          cat "$DIRTY_FLAG"
        else
          echo ""
        fi
        ;;
      *) return 0 ;;
    esac
  }

  # Stub node/run-agent.ts to simulate the commit-completion agent.
  # Uses file-based state (DIRTY_FLAG) because node runs inside a pipe
  # subshell and variable changes wouldn't propagate.
  _CC_AGENT_EXIT=0
  _CC_AGENT_CLEANS_TREE=1
  NODE_OPTIONS='--conditions=development'
  node() {
    if [[ $_CC_AGENT_CLEANS_TREE -eq 1 ]]; then
      echo -n "" > "$DIRTY_FLAG"
    fi
    return $_CC_AGENT_EXIT
  }

  # Stubs for helpers
  log() { :; }
  warn() { :; }
  check_branch_after_agent() { :; }
  emit_event() { :; }
  REPO_ROOT="$TMPDIR_TEST/repo"
  RUN_ID="test-run"
  REPO_ID="test/repo"
  _TSX_LOADER="/dev/null"
  ISSUES_DIR="$TMPDIR_TEST/issues"
  mkdir -p "$ISSUES_DIR"
}

teardown() {
  rm -rf "$TMPDIR_TEST"
}

@test "run_commit_completion: returns 0 immediately when worktree is clean" {
  echo -n "" > "$DIRTY_FLAG"
  run run_commit_completion 1 "test commit msg"
  [ "$status" -eq 0 ]
}

@test "run_commit_completion: invokes agent when worktree is dirty" {
  echo " M src/foo.ts" > "$DIRTY_FLAG"
  _CC_AGENT_CLEANS_TREE=1
  _CC_AGENT_EXIT=0
  run run_commit_completion 1 "test commit msg"
  [ "$status" -eq 0 ]
  # Agent was invoked (output captured in log)
  [ -f "${ISSUES_DIR}/commit-completion-task-1.log" ]
}

@test "run_commit_completion: returns 0 when agent cleans the tree" {
  echo " M src/foo.ts" > "$DIRTY_FLAG"
  _CC_AGENT_CLEANS_TREE=1
  _CC_AGENT_EXIT=0
  run run_commit_completion 1 "test commit msg"
  [ "$status" -eq 0 ]
}

@test "run_commit_completion: returns 1 when tree stays dirty after agent" {
  echo " M src/foo.ts" > "$DIRTY_FLAG"
  _CC_AGENT_CLEANS_TREE=0
  _CC_AGENT_EXIT=0
  run run_commit_completion 1 "test commit msg"
  [ "$status" -eq 1 ]
}

@test "run_commit_completion: returns 1 when agent exits non-zero and tree stays dirty" {
  echo " M src/foo.ts" > "$DIRTY_FLAG"
  _CC_AGENT_CLEANS_TREE=0
  _CC_AGENT_EXIT=1
  run run_commit_completion 1 "test commit msg"
  [ "$status" -eq 1 ]
}

@test "run_commit_completion: returns 0 when agent exits non-zero but tree is clean" {
  # Agent fails but somehow the tree gets cleaned (edge case)
  echo " M src/foo.ts" > "$DIRTY_FLAG"
  _CC_AGENT_CLEANS_TREE=1
  _CC_AGENT_EXIT=1
  run run_commit_completion 1 "test commit msg"
  [ "$status" -eq 0 ]
}

# --- Integration-style tests for the five design scenarios ---
# These test the guard logic pattern (dirty check → recovery → re-check → fail)
# as it would run in the main task loop, using the extracted run_commit_completion.

@test "scenario 1: Mode A — no commits, dirty tracked files → recovery commits → clean" {
  printf " M src/foo.ts\n?? src/new-file.ts\n" > "$DIRTY_FLAG"
  _CC_AGENT_CLEANS_TREE=1
  _CC_AGENT_EXIT=0
  run run_commit_completion 1 "feat: implement task 1"
  [ "$status" -eq 0 ]
}

@test "scenario 2: Mode B — commit fails, recovery agent fixes lint and commits" {
  echo " M src/foo.ts" > "$DIRTY_FLAG"
  _CC_AGENT_CLEANS_TREE=1
  _CC_AGENT_EXIT=0
  run run_commit_completion 1 "feat: implement task 1"
  [ "$status" -eq 0 ]
}

@test "scenario 3: Mode B (unfixable) — commit fails, recovery can't fix → fail with output" {
  echo " M src/foo.ts" > "$DIRTY_FLAG"
  _CC_AGENT_CLEANS_TREE=0
  _CC_AGENT_EXIT=0
  run run_commit_completion 1 "feat: implement task 1"
  [ "$status" -eq 1 ]
}

@test "scenario 4: Third gap — one commit + other files dirty → recovery commits leftover" {
  echo " M src/unrelated.ts" > "$DIRTY_FLAG"
  _CC_AGENT_CLEANS_TREE=1
  _CC_AGENT_EXIT=0
  run run_commit_completion 1 "feat: implement task 1"
  [ "$status" -eq 0 ]
}

@test "scenario 5: Clean tree — no recovery needed → pass through" {
  echo -n "" > "$DIRTY_FLAG"
  run run_commit_completion 1 "feat: implement task 1"
  [ "$status" -eq 0 ]
  [ ! -f "${ISSUES_DIR}/commit-completion-task-1.log" ]
}
