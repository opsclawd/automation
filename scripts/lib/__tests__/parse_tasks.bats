#!/usr/bin/env bats

setup() {
  SCRIPT_DIR="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  source "${SCRIPT_DIR}/parse_tasks_helpers.sh"

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

@test "PR task list generation: excludes fenced tasks" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 1: Real feature
```bash
## Task 2: Phantom task in example
```
## Task 2: Also real
PLAN
  result=$(_strip_fenced < "$TMPDIR_TEST/plan.md" | awk '/^#{2,3} Task [0-9]+:/ {sub(/^#{2,3} /, "- "); print}' 2>/dev/null || true)
  [ "$(echo "$result" | wc -l | tr -d ' ')" = "2" ]
  echo "$result" | grep -q "Real feature"
  echo "$result" | grep -q "Also real"
  ! echo "$result" | grep -q "Phantom"
}

@test "_strip_fenced: unclosed fence treats rest of file as fenced (safe default)" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
outside
```
inside
  ## Task 99: Phantom in unclosed
still inside
PLAN
  result=$(_strip_fenced < "$TMPDIR_TEST/plan.md")
  echo "$result" | grep -q "outside"
  ! echo "$result" | grep -q "Phantom in unclosed"
}

@test "parse_tasks: fenced tasks before, between, and after real tasks" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
```bash
  ## Task 0: Before any real task
```
## Task 1: First real

Body.

```bash
  ## Task 1: Duplicate in fence
```

## Task 2: Second real

```
  ## Task 99: After all real tasks
```
PLAN
  result=$(parse_tasks "$TMPDIR_TEST/plan.md")
  [ "$(echo "$result" | wc -l | tr -d ' ')" = "2" ]
  echo "$result" | grep -q "First real"
  echo "$result" | grep -q "Second real"
}

@test "parse_tasks: multiple fence blocks with tasks" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 1: Real one

```bash
  ## Task 2: Fenced one
```

## Task 2: Real two

```sh
  ## Task 3: Fenced two
```

## Task 3: Real three
PLAN
  result=$(parse_tasks "$TMPDIR_TEST/plan.md")
  [ "$(echo "$result" | wc -l | tr -d ' ')" = "3" ]
}

@test "parse_tasks: task header adjacent to fence line" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 1: Real
```
  ## Task 2: Fenced
```
## Task 2: Also real
PLAN
  result=$(parse_tasks "$TMPDIR_TEST/plan.md")
  [ "$(echo "$result" | wc -l | tr -d ' ')" = "2" ]
  echo "$result" | grep -q "^Real$"
  echo "$result" | grep -q "^Also real$"
}

@test "find_first_incomplete_task: count matches parse_tasks for plan with fenced examples" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 1: Real

```bash
  ## Task 2: Fenced phantom
  ## Task 3: Another phantom
```

## Task 2: Also real

```
  ## Task 4: Yet another phantom
```
PLAN
  parsed_count=$(parse_tasks "$TMPDIR_TEST/plan.md" | wc -l | tr -d ' ')
  incomplete=$(find_first_incomplete_task)
  [ "$incomplete" = "1" ]
  task_count=$(_strip_fenced < "$TMPDIR_TEST/plan.md" | awk '/^#{2,3} Task [0-9]+:/ {n++} END{print n+0}')
  [ "$task_count" = "$parsed_count" ]
}
