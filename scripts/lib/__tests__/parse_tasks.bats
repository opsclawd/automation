#!/usr/bin/env bats

setup() {
  SCRIPT_PATH="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)/scripts/ai-run-issue-v2"
  eval "$(awk '
    /^_strip_fenced\(\)/ { found=1 }
    found { print; if (/\{/) depth+=gsub(/{/,"{"); if (/\}/) depth-=gsub(/}/,"}"); if (depth==0 && found) { found=0; depth=0 } }
  ' "$SCRIPT_PATH")"
  eval "$(awk '
    /^[[:space:]]*parse_tasks\(\)/ { found=1 }
    found { print; if (/\{/) depth+=gsub(/{/,"{"); if (/\}/) depth-=gsub(/}/,"}"); if (depth==0 && found) { found=0; depth=0 } }
  ' "$SCRIPT_PATH")"
  eval "$(awk '
    /^(find_first_incomplete_task|detect_resume_point)\(\)/ { found=1 }
    found { print; if (/\{/) depth+=gsub(/{/,"{"); if (/\}/) depth-=gsub(/}/,"}"); if (depth==0 && found) { found=0; depth=0 } }
  ' "$SCRIPT_PATH")"
  eval "$(awk '
    /^[[:space:]]*extract_task_commit_msg\(\)/ { found=1 }
    found { print; if (/\{/) depth+=gsub(/{/,"{"); if (/\}/) depth-=gsub(/}/,"}"); if (depth==0 && found) { found=0; depth=0 } }
  ' "$SCRIPT_PATH")"
  eval "$(awk '
    /^[[:space:]]*extract_task_text\(\)/ { found=1 }
    found { print; if (/\{/) depth+=gsub(/{/,"{"); if (/\}/) depth-=gsub(/}/,"}"); if (depth==0 && found) { found=0; depth=0 } }
  ' "$SCRIPT_PATH")"

  TMPDIR_TEST="$(mktemp -d)"
  export ISSUES_DIR="$TMPDIR_TEST"
  # stub get_task_completion_status
  get_task_completion_status() { echo "pending"; }
}

teardown() {
  rm -rf "$TMPDIR_TEST"
}

@test "_strip_fenced: removes lines inside triple-backtick fences" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
outside line 1
```
inside fence
  ## Task 99: Phantom
```
outside line 2
PLAN
  result=$(_strip_fenced < "$TMPDIR_TEST/plan.md")
  echo "$result" | grep -q "outside line 1"
  echo "$result" | grep -q "outside line 2"
  ! echo "$result" | grep -q "Phantom"
  ! echo "$result" | grep -q '```'
}

@test "parse_tasks: returns only real tasks, ignores fenced task headers" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 1: Real task one
Some body.
```bash
## Task 2: Phantom fenced task
run something
```
## Task 2: Real task two
More body.
```
## Task 3: Another phantom
```
## Task 3: Real task three
PLAN
  result=$(parse_tasks "$TMPDIR_TEST/plan.md")
  [ "$(echo "$result" | wc -l | tr -d ' ')" = "3" ]
  echo "$result" | grep -q "Real task one"
  echo "$result" | grep -q "Real task two"
  echo "$result" | grep -q "Real task three"
  ! echo "$result" | grep -q "Phantom"
}

@test "parse_tasks: plan with no tasks returns nothing" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
# Some Plan
No tasks here.
PLAN
  result=$(parse_tasks "$TMPDIR_TEST/plan.md")
  [ -z "$result" ]
}

@test "find_first_incomplete_task: counts only real tasks, ignores fenced" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 1: Real task

```bash
## Task 2: Phantom
```

## Task 2: Also real
PLAN
  get_task_completion_status() { echo "complete"; }
  result=$(find_first_incomplete_task)
  # Buggy: counts 3 (incl. fenced Task 2 Phantom) → all complete → returns 4
  # Fixed: counts 2 (only real tasks) → all complete → returns 3
  [ "$result" = "3" ]
}

@test "find_first_incomplete_task: returns 0 when no plan" {
  rm -f "$TMPDIR_TEST/plan.md"
  result=$(find_first_incomplete_task)
  [ "$result" = "0" ]
}

@test "detect_resume_point: counts only real tasks" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 1: Done task

```
## Task 2: Phantom
```
PLAN
  # Stub: tasks 1-2 are "complete", tasks 3+ are "pending"
  # Buggy sees 2 tasks (incl. fenced Task 2) — all complete — first_incomplete=3, stub(3)=pending → "implement"
  # Fixed sees 1 task — all complete — first_incomplete=2, stub(2)=complete, 2>1 → "validate"
  get_task_completion_status() {
    if [[ "$1" -le 2 ]]; then echo "complete"; else echo "pending"; fi
  }
  result=$(detect_resume_point)
  [ "$result" = "validate" ]
}

@test "extract_task_commit_msg: finds commit msg skipping fenced task boundaries" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 1: First task
```bash
## Task 2: Phantom fenced task
git commit -m "feat: phantom commit"
```

git commit -m "feat: first commit"

## Task 2: Second task
PLAN
  result=$(extract_task_commit_msg "$TMPDIR_TEST/plan.md" "First task" "fallback")
  [ "$result" = "feat: first commit" ]
}

@test "extract_task_text: reads full task text, does not stop at fenced ## boundary" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 1: First task

This is the body of task 1.

```bash
## Task 2: Phantom fenced task
```

Still part of task 1 body.

## Task 2: Second task

Second task body.
PLAN
  result=$(extract_task_text "$TMPDIR_TEST/plan.md" "First task")
  echo "$result" | grep -q "Still part of task 1 body"
}
