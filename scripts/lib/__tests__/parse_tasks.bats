#!/usr/bin/env bats

setup() {
  SCRIPT_DIR="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  source "${SCRIPT_DIR}/emit_event.sh"
  source "${SCRIPT_DIR}/parse_tasks_helpers.sh"
  source "${SCRIPT_DIR}/review-manifest-helpers.sh"

  TMPDIR_TEST="$(mktemp -d)"
  export ISSUES_DIR="$TMPDIR_TEST"
  # stub get_task_completion_status
  get_task_completion_status() { echo "pending"; }
}

teardown() {
  rm -rf "$TMPDIR_TEST"
}

@test "read_manifest: returns titles and count for valid manifest" {
  cat > "$TMPDIR_TEST/task-manifest.json" << 'JSON'
{
  "version": 1,
  "task_count": 3,
  "tasks": [
    { "n": 1, "title": "First task", "files": [], "validation": [] },
    { "n": 2, "title": "Second task", "files": [], "validation": [] },
    { "n": 3, "title": "Third task" }
  ]
}
JSON
  MANIFEST_TASKS=""
  MANIFEST_COUNT=0
  read_manifest "$TMPDIR_TEST/task-manifest.json"
  [ $? -eq 0 ]
  [ "$MANIFEST_COUNT" -eq 3 ]
  echo "$MANIFEST_TASKS" | grep -q "First task"
  echo "$MANIFEST_TASKS" | grep -q "Second task"
  echo "$MANIFEST_TASKS" | grep -q "Third task"
}

@test "read_manifest: returns error for missing file" {
  MANIFEST_TASKS=""
  MANIFEST_COUNT=0
  ! read_manifest "$TMPDIR_TEST/nonexistent.json" 2>/dev/null
}

@test "read_manifest: returns error for invalid JSON" {
  echo "not json" > "$TMPDIR_TEST/task-manifest.json"
  ! read_manifest "$TMPDIR_TEST/task-manifest.json" 2>/dev/null
}

@test "read_manifest: returns error for wrong version" {
  cat > "$TMPDIR_TEST/task-manifest.json" << 'JSON'
{ "version": 2, "task_count": 1, "tasks": [{ "n": 1, "title": "T" }] }
JSON
  ! read_manifest "$TMPDIR_TEST/task-manifest.json" 2>/dev/null
}

@test "read_manifest: returns error for count mismatch" {
  cat > "$TMPDIR_TEST/task-manifest.json" << 'JSON'
{ "version": 1, "task_count": 5, "tasks": [{ "n": 1, "title": "T" }] }
JSON
  ! read_manifest "$TMPDIR_TEST/task-manifest.json" 2>/dev/null
}

@test "read_manifest: returns error for non-sequential numbers" {
  cat > "$TMPDIR_TEST/task-manifest.json" << 'JSON'
{ "version": 1, "task_count": 2, "tasks": [{ "n": 1, "title": "A" }, { "n": 3, "title": "B" }] }
JSON
  ! read_manifest "$TMPDIR_TEST/task-manifest.json" 2>/dev/null
}

@test "read_manifest: returns error for empty title" {
  cat > "$TMPDIR_TEST/task-manifest.json" << 'JSON'
{ "version": 1, "task_count": 1, "tasks": [{ "n": 1, "title": "" }] }
JSON
  ! read_manifest "$TMPDIR_TEST/task-manifest.json" 2>/dev/null
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
  echo "$result" | grep -q "Phantom fenced task"
  ! echo "$result" | grep -q "Second task body"
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

@test "extract_task_text: title first appears inside fence, grep finds real copy" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
```bash
  ## Task 1: Implement X
echo "example"
```
## Task 1: Implement X

Body of task 1.

## Task 2: Second task
PLAN
  result=$(extract_task_text "$TMPDIR_TEST/plan.md" "Implement X")
  echo "$result" | grep -q "Body of task 1"
  ! echo "$result" | grep -q "Second task"
}

@test "extract_task_text: falls back to task number when title does not match" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 1: Implement authentication
This is the auth body.
```bash
  ## Task 1: Fenced example (indented — new behavior skips it)
```
More body text.
## Task 2: Write database migration
This is the migration body.
PLAN
  result=$(extract_task_text "$TMPDIR_TEST/plan.md" "Implement auth" "1")
  echo "$result" | grep -q "auth body"
  echo "$result" | grep -q "Fenced example"
  ! echo "$result" | grep -q "migration body"
}

@test "extract_task_text: title match works when no task_num provided" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 1: Implement auth
This is the auth body.
## Task 2: Write migration
This is the migration body.
PLAN
  result=$(extract_task_text "$TMPDIR_TEST/plan.md" "Implement auth")
  echo "$result" | grep -q "auth body"
}

@test "extract_task_text: prefers task_num lookup when both title and task_num provided" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 1: Manifest title differs
Actual body for task 1.
```bash
  ## Task 1: Fenced phantom (indented — ignored by raw grep)
```
More text.
## Task 2: Prose has different title
Actual body for task 2.
PLAN
  result=$(extract_task_text "$TMPDIR_TEST/plan.md" "Prose has different title" "1")
  echo "$result" | grep -q "Actual body for task 1"
  echo "$result" | grep -q "Fenced phantom"
  ! echo "$result" | grep -q "Actual body for task 2"
}

@test "extract_task_text: task_num fallback finds correct task" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 1: First task
Body 1.
## Task 2: Second task
Body 2.
## Task 3: Third task
Body 3.
PLAN
  result=$(extract_task_text "$TMPDIR_TEST/plan.md" "Non-existent title" "2")
  echo "$result" | grep -q "Body 2"
  ! echo "$result" | grep -q "Body 1"
  ! echo "$result" | grep -q "Body 3"
}

@test "extract_task_text: stops at ### Task N: headers (level-3)" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 1: First task

Body 1.

### Task 2: Sub task

Body 2.

## Task 2: Second task

Body 2b.
PLAN
  result=$(extract_task_text "$TMPDIR_TEST/plan.md" "First task" "1")
  echo "$result" | grep -q "Body 1"
  ! echo "$result" | grep -q "Body 2"
}

@test "extract_task_text: stops at ### Task N: with task_num lookup" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
### Task 1: First task

Body 1.

### Task 2: Second task

Body 2.
PLAN
  result=$(extract_task_text "$TMPDIR_TEST/plan.md" "First task" "1")
  echo "$result" | grep -q "Body 1"
  ! echo "$result" | grep -q "Body 2"
}

@test "extract_task_text: nested fences do not cause heading skip (#315 regression)" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 1: Setup

```bash
cat > fixture.sh << 'SCRIPT'
```bash
  ## Task 99: Nested phantom
```
SCRIPT
```

Real body continues here.

## Task 2: Core logic

Core body.
PLAN
  result=$(extract_task_text "$TMPDIR_TEST/plan.md" "Setup" "1")
  echo "$result" | grep -q "Real body continues here" || {
    echo "FAIL: nested fences caused heading miss"
    echo "got: [$result]"
    false
  }
  ! echo "$result" | grep -q "Core body"
}

@test "extract_task_text: end boundary is fence-aware for column-0 fenced headings (#315)" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 1: First task

This is the body of task 1.

```
## Task 2: Phantom at column 0 inside fence
```

Still part of task 1 body.

## Task 2: Real second task

Second task body.
PLAN
  result=$(extract_task_text "$TMPDIR_TEST/plan.md" "First task" "1")
  echo "$result" | grep -q "Still part of task 1 body" || {
    echo "FAIL: last body line of task 1 missing"
    echo "got: [$result]"
    false
  }
  echo "$result" | grep -q "Phantom at column 0" || {
    echo "FAIL: fenced column-0 heading was excluded (should be part of task 1 body)"
    echo "got: [$result]"
    false
  }
  ! echo "$result" | grep -q "Real second task"
}

@test "extract_task_text: unbalanced fence boundary falls back to raw matching (#315 review)" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 1: First task

Body with unclosed fence.
```
unclosed

## Task 2: Real second task

Second body.
PLAN
  result=$(extract_task_text "$TMPDIR_TEST/plan.md" "First task" "1")
  echo "$result" | grep -q "unclosed" || {
    echo "FAIL: fenced body content missing from task 1"
    echo "got: [$result]"
    false
  }
  ! echo "$result" | grep -q "Second body" || {
    echo "FAIL: task 2 body leaked into task 1 extraction (unbalanced fence swallowed boundary)"
    echo "got: [$result]"
    false
  }
}

@test "extract_task_text: returns exit 1 when no heading matches task title" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 1: Write tests

Test body.

## Task 2: Refactor code

Refactor body.
PLAN
  set +e
  result=$(extract_task_text "$TMPDIR_TEST/plan.md" "Nonexistent task title" 2>/dev/null)
  local rc=$?
  set -e
  [ "$rc" -eq 1 ] || {
    echo "FAIL: expected exit 1 for non-matching title, got exit ${rc}"
    false
  }
}

@test "extract_task_text: title fallback is fence-aware when number path is empty (#315)" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 1: Real task

Body.

```
## Task 2: Phantom — only heading with this number
```
PLAN
  set +e
  result=$(extract_task_text "$TMPDIR_TEST/plan.md" "Phantom" 2)
  local rc=$?
  set -e
  [ "$rc" -eq 1 ] || {
    echo "FAIL: expected exit 1 when title-match is inside fence, got exit ${rc}"
    echo "got: [$result]"
    false
  }
}

@test "extract_task_text: numbered exhausted skips title fallback to avoid wrong task body (#315 review)" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 1: Implement auth

Task 1 body.

```
## Task 2: Implement auth
```
PLAN
  set +e
  result=$(extract_task_text "$TMPDIR_TEST/plan.md" "Implement auth" 2)
  local rc=$?
  set -e
  [ "$rc" -eq 1 ] || {
    echo "FAIL: expected exit 1 when Task 2 heading is fenced-only and title matches Task 1, got exit ${rc}"
    echo "got: [$result]"
    false
  }
}

@test "extract_task_commit_msg: title first appears inside fence, gets real commit msg" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
```bash
  ## Task 1: Implement X
echo "example"
```
## Task 1: Implement X

Body of task 1.
git commit -m "feat: real commit"

## Task 2: Second task
PLAN
  result=$(extract_task_commit_msg "$TMPDIR_TEST/plan.md" "Implement X" "fallback")
  [ "$result" = "feat: real commit" ]
}

@test "extract_task_commit_msg: falls back to task number when title does not match" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 1: Implement authentication

Body here.
git commit -m "feat: add auth"

## Task 2: Write database migration

Body here.
git commit -m "feat: add migration"
PLAN
  result=$(extract_task_commit_msg "$TMPDIR_TEST/plan.md" "Implement auth" "fallback" "1")
  [ "$result" = "feat: add auth" ]
}

@test "extract_task_commit_msg: task_num fallback returns correct commit msg" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 1: First task

git commit -m "feat: first"

## Task 2: Second task

git commit -m "feat: second"
PLAN
  result=$(extract_task_commit_msg "$TMPDIR_TEST/plan.md" "Non-existent title" "fallback" "2")
  [ "$result" = "feat: second" ]
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

@test "_extract_declared_count: returns count from HTML comment" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
<!-- task-count: 5 -->
## Task 1: First
PLAN
  result=$(_extract_declared_count "$TMPDIR_TEST/plan.md")
  [ "$result" = "5" ]
}

@test "_extract_declared_count: returns empty when comment absent" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 1: First
PLAN
  result=$(_extract_declared_count "$TMPDIR_TEST/plan.md")
  [ -z "$result" ]
}

@test "_extract_declared_count: extracts count immediately before first task header" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
<!-- task-count: 7 -->
<!-- task-count: 3 -->
## Task 1: First
PLAN
  result=$(_extract_declared_count "$TMPDIR_TEST/plan.md")
  [ "$result" = "3" ]
}

@test "_extract_declared_count: ignores prose task-count before real comment" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
Some prose mentioning <!-- task-count: 99 --> as an example.
<!-- task-count: 2 -->
## Task 1: First
## Task 2: Second
PLAN
  result=$(_extract_declared_count "$TMPDIR_TEST/plan.md")
  [ "$result" = "2" ]
}

@test "_extract_declared_count: ignores fenced task-count comments" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
```
<!-- task-count: 99 -->
```
<!-- task-count: 2 -->
## Task 1: First
## Task 2: Second
PLAN
  result=$(_extract_declared_count "$TMPDIR_TEST/plan.md")
  [ "$result" = "2" ]
}

@test "_check_sequential_numbers: passes for contiguous 1..N" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 1: First
## Task 2: Second
## Task 3: Third
PLAN
  result=$(_check_sequential_numbers "$TMPDIR_TEST/plan.md")
  [ -z "$result" ]
}

@test "_check_sequential_numbers: fails for gap in numbering" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 1: First
## Task 3: Third
PLAN
  set +e
  result=$(_check_sequential_numbers "$TMPDIR_TEST/plan.md")
  set -e
  [[ "$result" == *"not sequential"* ]]
}

@test "_check_sequential_numbers: fails for duplicate numbers" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 1: First
## Task 2: Second
## Task 2: Also second
PLAN
  set +e
  result=$(_check_sequential_numbers "$TMPDIR_TEST/plan.md")
  set -e
  [[ "$result" == *"not sequential"* ]]
}

@test "_check_sequential_numbers: passes for single task" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 1: Only task
PLAN
  result=$(_check_sequential_numbers "$TMPDIR_TEST/plan.md")
  [ -z "$result" ]
}

@test "_check_sequential_numbers: ignores fenced task headers" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 1: First
```bash
## Task 99: Phantom
```
## Task 2: Second
PLAN
  result=$(_check_sequential_numbers "$TMPDIR_TEST/plan.md")
  [ -z "$result" ]
}

@test "_check_duplicate_titles: passes with unique titles" {
  result=$(_check_duplicate_titles "Task A
Task B
Task C")
  [ -z "$result" ]
}

@test "_check_duplicate_titles: fails with duplicate titles" {
  set +e
  result=$(_check_duplicate_titles "Implement X
Implement X
Do something else")
  set -e
  [[ "$result" == *"duplicate task titles"* ]]
  [[ "$result" == *"Implement X"* ]]
}

@test "_check_duplicate_titles: is case-insensitive" {
  set +e
  result=$(_check_duplicate_titles "Implement X
implement x")
  set -e
  [[ "$result" == *"duplicate task titles"* ]]
}

@test "_check_fixture_titles: warns on fixture-like title" {
  result=$(_check_fixture_titles "Fix failing tests")
  [[ "$result" == *"fixture pattern"* ]]
}

@test "_check_fixture_titles: matches multi-word pattern as whole phrase" {
  result=$(_check_fixture_titles "Some task")
  [[ "$result" == *"fixture pattern"* ]]
}

@test "_check_fixture_titles: no false positive on partial word match" {
  result=$(_check_fixture_titles "Add logging to the task runner")
  [ -z "$result" ]
}

@test "_check_fixture_titles: returns empty for normal titles" {
  result=$(_check_fixture_titles "Implement the data model")
  [ -z "$result" ]
}

@test "_check_fixture_titles: returns empty for empty input" {
  result=$(_check_fixture_titles "")
  [ -z "$result" ]
}

@test "_check_sequential_numbers: ignores subtask headings without colon" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 1: Implement feature
### Task 1 notes
Some detail here.
## Task 2: Write tests
PLAN
  result=$(_check_sequential_numbers "$TMPDIR_TEST/plan.md")
  [ -z "$result" ]
}

@test "_check_sequential_numbers: fails for out-of-order task numbers" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 2: Second
## Task 1: First
## Task 3: Third
PLAN
  set +e
  result=$(_check_sequential_numbers "$TMPDIR_TEST/plan.md")
  set -e
  [[ "$result" == *"not sequential"* ]]
}

@test "_extract_declared_count: handles flexible whitespace in HTML comment" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
<!--  task-count:  5  -->
## Task 1: First
PLAN
  result=$(_extract_declared_count "$TMPDIR_TEST/plan.md")
  [ "$result" = "5" ]
}

@test "_check_duplicate_titles: shows original casing in error message" {
  set +e
  result=$(_check_duplicate_titles "Implement X
Implement X
Do something else")
  set -e
  [[ "$result" == *"duplicate task titles"* ]]
  [[ "$result" == *"Implement X"* ]]
}

@test "_check_duplicate_titles: reports all distinct duplicate pairs" {
  set +e
  result=$(_check_duplicate_titles "Do A
Do B
Do A
Do B")
  set -e
  [[ "$result" == *"duplicate task titles"* ]]
  [[ "$result" == *"Do A"* ]]
  [[ "$result" == *"Do B"* ]]
}

@test "_check_duplicate_titles: handles titles with regex metacharacters" {
  local input
  input=$'Refactor the API.\nRefactor the API.'
  set +e
  result=$(_check_duplicate_titles "$input")
  set -e
  [[ "$result" == *"duplicate task titles"* ]]
  [[ "$result" == *"Refactor the API."* ]]
}

@test "validate_task_list: passes with correct declared count and sequential tasks" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
<!-- task-count: 2 -->
## Task 1: Build the data model
Body.
## Task 2: Write tests
PLAN
  emit_event() { true; }
  result=$(validate_task_list "$TMPDIR_TEST/plan.md" 2)
  [ -z "$result" ]
}

@test "validate_task_list: fails when declared count mismatches" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
<!-- task-count: 5 -->
## Task 1: Only one task
PLAN
  emit_event() { true; }
  set +e
  result=$(validate_task_list "$TMPDIR_TEST/plan.md" 1)
  set -e
  [[ "$result" == *"parsed 1 tasks but plan declares 5"* ]]
}

@test "validate_task_list: passes when no manifest and no declared count (prose fallback)" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 1: Do something
## Task 2: Do another thing
PLAN
  emit_event() { true; }
  run validate_task_list "$TMPDIR_TEST/plan.md" 2
  [[ $status -eq 0 ]]
}

@test "validate_task_list: fails on gap in task numbers" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
<!-- task-count: 2 -->
## Task 1: First
## Task 3: Third
PLAN
  emit_event() { true; }
  set +e
  result=$(validate_task_list "$TMPDIR_TEST/plan.md" 2)
  set -e
  [[ "$result" == *"not sequential"* ]]
}

@test "validate_task_list: fails on duplicate titles" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
<!-- task-count: 2 -->
## Task 1: Do the thing
## Task 2: Do the thing
PLAN
  emit_event() { true; }
  set +e
  result=$(validate_task_list "$TMPDIR_TEST/plan.md" 2)
  set -e
  [[ "$result" == *"duplicate task titles"* ]]
}

@test "validate_task_list: passes but warns on fixture-like title" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
<!-- task-count: 1 -->
## Task 1: Fix failing tests
PLAN
  emit_event() { true; }
  result=$(validate_task_list "$TMPDIR_TEST/plan.md" 1)
  [ -z "$result" ]
}

@test "validate_task_list: accepts valid manifest without scraping prose" {
  cat > "$TMPDIR_TEST/task-manifest.json" << 'JSON'
{ "version": 1, "task_count": 2, "tasks": [{ "n": 1, "title": "Build model" }, { "n": 2, "title": "Write tests" }] }
JSON
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 1: Build model
Body.
## Task 2: Write tests
PLAN
  emit_event() { true; }
  result=$(validate_task_list "$TMPDIR_TEST/plan.md" 2)
  [ -z "$result" ]
}

@test "validate_task_list: rejects invalid manifest" {
  echo "bad" > "$TMPDIR_TEST/task-manifest.json"
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
<!-- task-count: 2 -->
## Task 1: Only one task
PLAN
  emit_event() { true; }
  set +e
  result=$(validate_task_list "$TMPDIR_TEST/plan.md" 1)
  set -e
  [[ "$result" == *"parsed 1 tasks but plan declares"* ]]
}

@test "validate_task_list: rejects manifest when tasks missing from plan prose" {
  cat > "$TMPDIR_TEST/task-manifest.json" << 'JSON'
{ "version": 1, "task_count": 3, "tasks": [{ "n": 1, "title": "Alpha" }, { "n": 2, "title": "Beta" }, { "n": 3, "title": "Gamma" }] }
JSON
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 1: Alpha
## Task 2: Beta
PLAN
  emit_event() { true; }
  set +e
  result=$(validate_task_list "$TMPDIR_TEST/plan.md" 3)
  set -e
  [[ "$result" == *"manifest tasks missing from plan.md prose"* ]]
  [[ "$result" == *"Task 3"* ]]
}

@test "validate_task_list: accepts manifest when all tasks have matching prose headers" {
  cat > "$TMPDIR_TEST/task-manifest.json" << 'JSON'
{ "version": 1, "task_count": 2, "tasks": [{ "n": 1, "title": "Build model" }, { "n": 2, "title": "Write tests" }] }
JSON
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 1: Build model
Body here.
### Task 2: Write tests
More body.
PLAN
  emit_event() { true; }
  result=$(validate_task_list "$TMPDIR_TEST/plan.md" 2)
  [ -z "$result" ]
}

@test "validate_task_list: rejects manifest when prose has extra tasks not in manifest" {
  cat > "$TMPDIR_TEST/task-manifest.json" << 'JSON'
{ "version": 1, "task_count": 2, "tasks": [{ "n": 1, "title": "Alpha" }, { "n": 2, "title": "Beta" }] }
JSON
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 1: Alpha
## Task 2: Beta
## Task 3: Gamma
PLAN
  emit_event() { true; }
  set +e
  result=$(validate_task_list "$TMPDIR_TEST/plan.md" 2)
  set -e
  [[ "$result" == *"prose tasks not in manifest"* ]]
  [[ "$result" == *"Task 3"* ]]
}

@test "validate_task_list: rejects non-positive prose task numbers (Task 0, #319)" {
  cat > "$TMPDIR_TEST/task-manifest.json" << 'JSON'
{ "version": 1, "task_count": 2, "tasks": [{ "n": 1, "title": "Alpha" }, { "n": 2, "title": "Beta" }] }
JSON
  # A real column-0 "## Task 0:" is not executable (manifest is 1-indexed and the
  # implement loop only iterates manifest tasks), so it must be flagged as not in
  # the manifest rather than silently accepted as "in range".
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 0: Setup that gets silently skipped
## Task 1: Alpha
## Task 2: Beta
PLAN
  emit_event() { true; }
  set +e
  result=$(validate_task_list "$TMPDIR_TEST/plan.md" 2)
  set -e
  [[ "$result" == *"prose tasks not in manifest"* ]]
  [[ "$result" == *"Task 0"* ]]
}

@test "validate_task_list: accepts column-0 task header by number even inside a fence (#319 number-only)" {
  cat > "$TMPDIR_TEST/task-manifest.json" << 'JSON'
{ "version": 1, "task_count": 2, "tasks": [{ "n": 1, "title": "Real task" }, { "n": 2, "title": "Hidden task" }] }
JSON
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 1: Real task
Body.
```markdown
## Task 2: Should not count
```
PLAN
  emit_event() { true; }
  set +e
  result=$(validate_task_list "$TMPDIR_TEST/plan.md" 2)
  set -e
  # Presence is checked by NUMBER only (no fence-stripping, no title match) —
  # title matching false-failed valid plans where prose elaborates the manifest
  # title (#223, #147), so it was removed. A column-0 "## Task 2:" satisfies the
  # presence check regardless of fences. Distinguishing a real section from a
  # fenced example is delegated to the plan-write indent contract and
  # extract_task_text consistency (tracked in #315), not enforced here.
  [ -z "$result" ]
}

@test "parse_tasks: prefers manifest over scraping when manifest exists" {
  cat > "$TMPDIR_TEST/task-manifest.json" << 'JSON'
{ "version": 1, "task_count": 2, "tasks": [{ "n": 1, "title": "Alpha" }, { "n": 2, "title": "Beta" }] }
JSON
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 1: Different title
## Task 2: Another different title
PLAN
  result=$(parse_tasks "$TMPDIR_TEST/plan.md")
  [ "$(echo "$result" | wc -l | tr -d ' ')" = "2" ]
  echo "$result" | grep -q "Alpha"
  echo "$result" | grep -q "Beta"
}

@test "parse_tasks: falls back to scraping when no manifest" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 1: Scraped task
## Task 2: Another scraped task
PLAN
  result=$(parse_tasks "$TMPDIR_TEST/plan.md")
  [ "$(echo "$result" | wc -l | tr -d ' ')" = "2" ]
  echo "$result" | grep -q "Scraped task"
  echo "$result" | grep -q "Another scraped task"
}

@test "parse_tasks: falls back to scraping when manifest is invalid" {
  echo "bad" > "$TMPDIR_TEST/task-manifest.json"
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 1: Fallback task
PLAN
  result=$(parse_tasks "$TMPDIR_TEST/plan.md")
  echo "$result" | grep -q "Fallback task"
}

@test "find_first_incomplete_task: uses manifest count when manifest exists" {
  cat > "$TMPDIR_TEST/task-manifest.json" << 'JSON'
{ "version": 1, "task_count": 3, "tasks": [{ "n": 1, "title": "A" }, { "n": 2, "title": "B" }, { "n": 3, "title": "C" }] }
JSON
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 1: A
## Task 2: B
## Task 3: C
PLAN
  get_task_completion_status() {
    if [[ "$1" -le 2 ]]; then echo "complete"; else echo "pending"; fi
  }
  result=$(find_first_incomplete_task)
  [ "$result" = "3" ]
}

@test "detect_resume_point: uses manifest for task counting" {
  cat > "$TMPDIR_TEST/task-manifest.json" << 'JSON'
{ "version": 1, "task_count": 2, "tasks": [{ "n": 1, "title": "A" }, { "n": 2, "title": "B" }] }
JSON
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 1: A
## Task 2: B
PLAN
  get_task_completion_status() { echo "complete"; }
  warn() { true; }
  result=$(detect_resume_point)
  [ "$result" = "validate" ]
}

@test "detect_resume_point: returns implement when manifest omits a prose task" {
  cat > "$TMPDIR_TEST/task-manifest.json" << 'JSON'
{ "version": 1, "task_count": 2, "tasks": [{ "n": 1, "title": "A" }, { "n": 2, "title": "B" }] }
JSON
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 1: A
## Task 2: B
## Task 3: C
PLAN
  get_task_completion_status() { echo "complete"; }
  warn() { true; }
  result=$(detect_resume_point)
  [ "$result" = "implement" ]
}

@test "integration: manifest + plan.md produces correct task list" {
  cat > "$TMPDIR_TEST/task-manifest.json" << 'JSON'
{ "version": 1, "task_count": 3, "tasks": [
  { "n": 1, "title": "Add read_manifest function", "files": ["scripts/lib/parse_tasks_helpers.sh"] },
  { "n": 2, "title": "Update parse_tasks to prefer manifest", "files": ["scripts/lib/parse_tasks_helpers.sh"] },
  { "n": 3, "title": "Update plan-write prompt", "files": ["scripts/ai-run-issue-v2"] }
] }
JSON
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
# Test Plan

<!-- task-count: 3 -->

## Task 1: Add read_manifest function

Body for task 1.

```bash
  ## Task 2: Phantom example header
```

## Task 2: Update parse_tasks to prefer manifest

Body for task 2.

## Task 3: Update plan-write prompt

Body for task 3.
PLAN

  emit_event() { true; }

  TASKS=$(parse_tasks "$TMPDIR_TEST/plan.md")
  TASK_COUNT=$(echo "$TASKS" | grep -c "." || echo 0)
  [ "$TASK_COUNT" -eq 3 ]

  validate_result=$(validate_task_list "$TMPDIR_TEST/plan.md" 3)
  [ -z "$validate_result" ]

  incomplete=$(find_first_incomplete_task)
  [ "$incomplete" = "1" ]
}

@test "integration: no manifest falls back to scraping correctly" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 1: Scrape task one

Body.

```bash
  ## Task 2: Phantom fenced task
```

## Task 2: Scrape task two

Body.
PLAN

  emit_event() { true; }

  TASKS=$(parse_tasks "$TMPDIR_TEST/plan.md")
  TASK_COUNT=$(echo "$TASKS" | grep -c "." || echo 0)
  [ "$TASK_COUNT" -eq 2 ]
  echo "$TASKS" | grep -q "Scrape task one"
  echo "$TASKS" | grep -q "Scrape task two"
  ! echo "$TASKS" | grep -q "Phantom"
}

@test "integration: invalid manifest falls back to scraping" {
  echo "{ bad json" > "$TMPDIR_TEST/task-manifest.json"
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 1: Fallback task
PLAN

  emit_event() { true; }

  TASKS=$(parse_tasks "$TMPDIR_TEST/plan.md")
  [ "$(echo "$TASKS" | wc -l | tr -d ' ')" = "1" ]
  echo "$TASKS" | grep -q "Fallback task"
}

@test "validate_task_list: tolerates in-range duplicate prose task numbers (manifest-anchored, #315)" {
  cat > "$TMPDIR_TEST/task-manifest.json" << 'JSON'
{ "version": 1, "task_count": 2, "tasks": [{ "n": 1, "title": "Alpha" }, { "n": 2, "title": "Beta" }] }
JSON
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 1: Alpha
## Task 2: Beta
## Task 2: Duplicate beta
PLAN
  emit_event() { true; }
  set +e
  result=$(validate_task_list "$TMPDIR_TEST/plan.md" 2)
  set -e
  # Manifest-anchored extraction (#315): the manifest is validated to be
  # 1..task_count and drives execution, so an in-range duplicate prose heading
  # is tolerated rather than hard-failing the run. Blindly flagging duplicate
  # prose task numbers re-introduces the false positives that example/fixture
  # headings cause (e.g. a plan whose subject is task parsing). Both manifest
  # tasks are present and no out-of-range extras exist → passes.
  [ -z "$result" ]
}

@test "validate_task_list: reports both missing-from-prose and extra-in-prose errors" {
  cat > "$TMPDIR_TEST/task-manifest.json" << 'JSON'
{ "version": 1, "task_count": 2, "tasks": [{ "n": 1, "title": "Alpha" }, { "n": 2, "title": "Beta" }] }
JSON
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 1: Alpha
## Task 3: Gamma
PLAN
  emit_event() { true; }
  set +e
  result=$(validate_task_list "$TMPDIR_TEST/plan.md" 2)
  set -e
  [[ "$result" == *"missing from plan.md prose"* ]]
  [[ "$result" == *"Task 2"* ]]
  [[ "$result" == *"prose tasks not in manifest"* ]]
  [[ "$result" == *"Task 3"* ]]
}

@test "validate_task_list: passes self-referential plan with in-range example headings and unbalanced fences (#315 regression)" {
  cat > "$TMPDIR_TEST/task-manifest.json" << 'JSON'
{ "version": 1, "task_count": 2, "tasks": [{ "n": 1, "title": "Create the linter" }, { "n": 2, "title": "Add bats tests" }] }
JSON
  # Mirrors the #315 failure: a plan about task parsing whose bats fixtures
  # contain in-range "## Task N:" example headings AND an intentionally
  # unbalanced code fence. Manifest-anchored extraction must not be fooled.
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
### Task 1: Create the linter

Example fixture for the test:
```bash
cat > plan.md << 'INNER'
## Task 1: Alpha
```typescript
## Task 2: Beta
still unclosed
INNER
```

### Task 2: Add bats tests

Another fixture:
```bash
## Task 1: Alpha
## Task 2: Gamma
```
PLAN
  emit_event() { true; }
  set +e
  result=$(validate_task_list "$TMPDIR_TEST/plan.md" 2)
  set -e
  [ -z "$result" ]
}

@test "_check_manifest_against_prose: appends fence-count hint when a task is missing and fences are odd" {
  cat > "$TMPDIR_TEST/task-manifest.json" << 'JSON'
{ "version": 1, "task_count": 2, "tasks": [{ "n": 1, "title": "Alpha" }, { "n": 2, "title": "Beta" }] }
JSON
  printf '### Task 1: Alpha\n\n```bash\necho hi\n' > "$TMPDIR_TEST/plan.md"
  set +e
  result=$(_check_manifest_against_prose "$TMPDIR_TEST/plan.md" "$TMPDIR_TEST/task-manifest.json")
  set -e
  [[ "$result" == *"manifest tasks missing from plan.md prose"* ]]
  [[ "$result" == *"Task 2"* ]]
  [[ "$result" == *"likely caused by an unbalanced code fence"* ]]
  [[ "$result" == *"1 fences, expected even"* ]]
}

@test "_check_manifest_against_prose: no fence hint when a task is missing but fences are balanced" {
  cat > "$TMPDIR_TEST/task-manifest.json" << 'JSON'
{ "version": 1, "task_count": 2, "tasks": [{ "n": 1, "title": "Alpha" }, { "n": 2, "title": "Beta" }] }
JSON
  printf '### Task 1: Alpha\n\n```bash\necho hi\n```\n' > "$TMPDIR_TEST/plan.md"
  set +e
  result=$(_check_manifest_against_prose "$TMPDIR_TEST/plan.md" "$TMPDIR_TEST/task-manifest.json")
  set -e
  [[ "$result" == *"manifest tasks missing from plan.md prose"* ]]
  [[ "$result" != *"unbalanced code fence"* ]]
}

# ── _validate_review_manifest tests ────────────────────────────────────────

@test "_validate_review_manifest: returns 0 for valid manifest array" {
  cat > "$TMPDIR_TEST/review-task-manifest.json" << 'JSON'
[{"id":"R1","action":"fix","severity":"high","description":"Fix X","files":["src/a.ts"],"commit_message":"fix: X"}]
JSON
  run _validate_review_manifest "$TMPDIR_TEST/review-task-manifest.json"
  [[ $status -eq 0 ]]
}

@test "_validate_review_manifest: returns 1 for missing file" {
  run _validate_review_manifest "$TMPDIR_TEST/nonexistent.json"
  [[ $status -eq 1 ]]
}

@test "_validate_review_manifest: returns 2 for invalid JSON" {
  echo "not json" > "$TMPDIR_TEST/review-task-manifest.json"
  run _validate_review_manifest "$TMPDIR_TEST/review-task-manifest.json"
  [[ $status -eq 2 ]]
}

@test "_validate_review_manifest: returns 3 for non-array JSON" {
  echo '{"key": "value"}' > "$TMPDIR_TEST/review-task-manifest.json"
  run _validate_review_manifest "$TMPDIR_TEST/review-task-manifest.json"
  [[ $status -eq 3 ]]
}

@test "_validate_review_manifest: returns 0 for empty array" {
  echo '[]' > "$TMPDIR_TEST/review-task-manifest.json"
  run _validate_review_manifest "$TMPDIR_TEST/review-task-manifest.json"
  [[ $status -eq 0 ]]
}

# ── _dedupe_manifest_ids tests ─────────────────────────────────────────────

@test "_dedupe_manifest_ids: appends suffix to duplicate ids" {
  result=$(cat << 'JSON' | _dedupe_manifest_ids
[{"id":"C1","action":"fix"},{"id":"C1","action":"skip"}]
JSON
)
  [[ $(echo "$result" | jq -r '.[0].id') == "C1" ]]
  [[ $(echo "$result" | jq -r '.[1].id') == "C1-2" ]]
}

@test "_dedupe_manifest_ids: leaves unique ids unchanged" {
  result=$(cat << 'JSON' | _dedupe_manifest_ids
[{"id":"R1","action":"fix"},{"id":"R2","action":"fix"}]
JSON
)
  [[ $(echo "$result" | jq -r '.[0].id') == "R1" ]]
  [[ $(echo "$result" | jq -r '.[1].id') == "R2" ]]
}

@test "_dedupe_manifest_ids: handles triple duplicate" {
  result=$(cat << 'JSON' | _dedupe_manifest_ids
[{"id":"X1","action":"fix"},{"id":"X1","action":"fix"},{"id":"X1","action":"skip"}]
JSON
)
  [[ $(echo "$result" | jq -r '.[0].id') == "X1" ]]
  [[ $(echo "$result" | jq -r '.[1].id') == "X1-2" ]]
  [[ $(echo "$result" | jq -r '.[2].id') == "X1-3" ]]
}

@test "_dedupe_manifest_ids: passes through non-array input unchanged" {
  result=$(echo '{"key":"value"}' | _dedupe_manifest_ids)
  [[ "$(echo "$result" | jq -r '.key')" == "value" ]]
}

# ── _lint_task_size tests ────────────────────────────────────────────────────

@test "_lint_task_size: returns 0 when no test files exceed thresholds" {
  local test_dir
  test_dir=$(mktemp -d)

  export _TASK_SPLIT_MAX_LINES=500
  export _TASK_SPLIT_MAX_CASES=10
  export _TASK_SPLIT_BLOCK=false
  export WORKTREE_DIR="$test_dir"
  export AI_RUN_EVENTS_FILE="${test_dir}/events.jsonl"
  export AI_RUN_DISPLAY_ID="test-lint"
  : > "$AI_RUN_EVENTS_FILE"

  local small_file="${test_dir}/small.test.ts"
  for _ in $(seq 1 10); do echo "// line"; done > "$small_file"

  cat > "${test_dir}/task-manifest.json" << 'JSON'
{ "version": 1, "task_count": 1, "tasks": [
  { "n": 1, "title": "Update small test", "files": ["small.test.ts"] }
] }
JSON

  _lint_task_size "${test_dir}/task-manifest.json"
  [ $? -eq 0 ]

  rm -rf "$test_dir"
}

@test "_lint_task_size: warns when test file exceeds line threshold" {
  local test_dir
  test_dir=$(mktemp -d)
  export _TASK_SPLIT_MAX_LINES=500

  export _TASK_SPLIT_MAX_CASES=10
  export _TASK_SPLIT_BLOCK=false
  export WORKTREE_DIR="$test_dir"
  export AI_RUN_EVENTS_FILE="${test_dir}/events.jsonl"
  export AI_RUN_DISPLAY_ID="test-lint-lines"
  : > "$AI_RUN_EVENTS_FILE"

  local big_file="${test_dir}/big.test.ts"
  for _ in $(seq 1 501); do echo "// line"; done > "$big_file"

  cat > "${test_dir}/task-manifest.json" << 'JSON'
{ "version": 1, "task_count": 1, "tasks": [
  { "n": 1, "title": "Update big test", "files": ["big.test.ts"] }
] }
JSON

  _lint_task_size "${test_dir}/task-manifest.json"

  jq -e 'select(.type == "task_size.oversized")' "$AI_RUN_EVENTS_FILE" >/dev/null

  rm -rf "$test_dir"
}
@test "_lint_task_size: warns when test file exceeds test case threshold" {
  local test_dir
  test_dir=$(mktemp -d)
  export _TASK_SPLIT_MAX_LINES=500

  export _TASK_SPLIT_MAX_CASES=10
  export _TASK_SPLIT_BLOCK=false
  export WORKTREE_DIR="$test_dir"
  export AI_RUN_EVENTS_FILE="${test_dir}/events.jsonl"
  export AI_RUN_DISPLAY_ID="test-lint-cases"
  : > "$AI_RUN_EVENTS_FILE"

  local case_file="${test_dir}/many-cases.test.ts"
  for _ in $(seq 1 11); do echo "it('case', async () => {})"; done > "$case_file"

  cat > "${test_dir}/task-manifest.json" << 'JSON'
{ "version": 1, "task_count": 1, "tasks": [
  { "n": 1, "title": "Update many cases", "files": ["many-cases.test.ts"] }
] }
JSON

  _lint_task_size "${test_dir}/task-manifest.json"

  jq -e 'select(.type == "task_size.oversized")' "$AI_RUN_EVENTS_FILE" >/dev/null

  rm -rf "$test_dir"
}
@test "_lint_task_size: counts multiline test declarations correctly" {
  local test_dir
  test_dir=$(mktemp -d)
  export _TASK_SPLIT_MAX_LINES=500

  export _TASK_SPLIT_MAX_CASES=5
  export _TASK_SPLIT_BLOCK=false
  export WORKTREE_DIR="$test_dir"
  export AI_RUN_EVENTS_FILE="${test_dir}/events.jsonl"
  export AI_RUN_DISPLAY_ID="test-lint-multiline"
  : > "$AI_RUN_EVENTS_FILE"

  local case_file="${test_dir}/multiline-cases.test.ts"
  cat > "$case_file" << 'TS'
describe('suite', () => {
  it('first test',
    async () => {
      expect(true).toBe(true);
    })

  it('second test',
    () => {
      expect(true).toBe(true);
    })

  test('third test',
    async () => {
      expect(true).toBe(true);
    })

  test.skip('fourth test',
    () => {
      expect(true).toBe(true);
    })

  it.skip('fifth test',
    async () => {
      expect(true).toBe(true);
    })

  it.only('sixth test',
    () => {
      expect(true).toBe(true);
    })
})
TS

  cat > "${test_dir}/task-manifest.json" << 'JSON'
{ "version": 1, "task_count": 1, "tasks": [
  { "n": 1, "title": "Update multiline tests", "files": ["multiline-cases.test.ts"] }
] }
JSON

  _lint_task_size "${test_dir}/task-manifest.json"

  jq -e 'select(.type == "task_size.oversized")' "$AI_RUN_EVENTS_FILE" >/dev/null

  rm -rf "$test_dir"
}
@test "_lint_task_size: skips tasks with no files field" {
  local test_dir
  test_dir=$(mktemp -d)
  export _TASK_SPLIT_MAX_LINES=500

  export _TASK_SPLIT_MAX_CASES=10
  export _TASK_SPLIT_BLOCK=false
  export WORKTREE_DIR="$test_dir"
  export AI_RUN_EVENTS_FILE="${test_dir}/events.jsonl"
  export AI_RUN_DISPLAY_ID="test-lint-nofiles"
  : > "$AI_RUN_EVENTS_FILE"

  cat > "${test_dir}/task-manifest.json" << 'JSON'
{ "version": 1, "task_count": 1, "tasks": [
  { "n": 1, "title": "Task with no files" }
] }
JSON

  _lint_task_size "${test_dir}/task-manifest.json"
  [ $? -eq 0 ]

  local events
  events=$(cat "$AI_RUN_EVENTS_FILE")
  [ -z "$events" ]

  rm -rf "$test_dir"
}

@test "_lint_task_size: skips non-test files" {
  local test_dir
  test_dir=$(mktemp -d)

  export _TASK_SPLIT_MAX_LINES=2
  export _TASK_SPLIT_MAX_CASES=1
  export _TASK_SPLIT_BLOCK=false
  export WORKTREE_DIR="$test_dir"
  export AI_RUN_EVENTS_FILE="${test_dir}/events.jsonl"
  export AI_RUN_DISPLAY_ID="test-lint-nontest"
  : > "$AI_RUN_EVENTS_FILE"

  local ts_file="${test_dir}/large-module.ts"
  for _ in $(seq 1 100); do echo "// large implementation file"; done > "$ts_file"

  cat > "${test_dir}/task-manifest.json" << 'JSON'
{ "version": 1, "task_count": 1, "tasks": [
  { "n": 1, "title": "Update large module", "files": ["large-module.ts"] }
] }
JSON

  _lint_task_size "${test_dir}/task-manifest.json"
  [ $? -eq 0 ]

  local events
  events=$(cat "$AI_RUN_EVENTS_FILE")
  [ -z "$events" ]
}

@test "_lint_task_size: skips files that do not exist on disk" {
  local test_dir
  test_dir=$(mktemp -d)
  trap "rm -rf $test_dir" EXIT

  export _TASK_SPLIT_MAX_LINES=2
  export _TASK_SPLIT_MAX_CASES=1
  export _TASK_SPLIT_BLOCK=false
  export WORKTREE_DIR="$test_dir"
  export AI_RUN_EVENTS_FILE="${test_dir}/events.jsonl"
  export AI_RUN_DISPLAY_ID="test-lint-missing"
  : > "$AI_RUN_EVENTS_FILE"

  cat > "${test_dir}/task-manifest.json" << 'JSON'
{ "version": 1, "task_count": 1, "tasks": [
  { "n": 1, "title": "Update nonexistent", "files": ["nonexistent.test.ts"] }
] }
JSON

  _lint_task_size "${test_dir}/task-manifest.json"
  [ $? -eq 0 ]

  local events
  events=$(cat "$AI_RUN_EVENTS_FILE")
  [ -z "$events" ]
}

@test "_lint_task_size: returns 1 when block is true and oversized task found" {
  local test_dir
  test_dir=$(mktemp -d)
  trap "rm -rf $test_dir" EXIT

  export _TASK_SPLIT_MAX_LINES=500
  export _TASK_SPLIT_MAX_CASES=10
  export _TASK_SPLIT_BLOCK=true
  export WORKTREE_DIR="$test_dir"
  export AI_RUN_EVENTS_FILE="${test_dir}/events.jsonl"
  export AI_RUN_DISPLAY_ID="test-lint-block"
  : > "$AI_RUN_EVENTS_FILE"

  local big_file="${test_dir}/big.test.ts"
  for _ in $(seq 1 501); do echo "// big file"; done > "$big_file"

  cat > "${test_dir}/task-manifest.json" << 'JSON'
{ "version": 1, "task_count": 1, "tasks": [
  { "n": 1, "title": "Update big test", "files": ["big.test.ts"] }
] }
JSON

  set +e
  _lint_task_size "${test_dir}/task-manifest.json"
  local rc=$?
  set -e

  [ "$rc" -eq 1 ]
}

@test "_lint_task_size: returns 0 when manifest is missing" {
  export AI_RUN_EVENTS_FILE="/dev/null"
  export AI_RUN_DISPLAY_ID="test-lint-missing-manifest"
  export WORKTREE_DIR="/tmp"
  export _TASK_SPLIT_MAX_LINES=500
  export _TASK_SPLIT_MAX_CASES=10
  export _TASK_SPLIT_BLOCK=false

  _lint_task_size "/nonexistent/task-manifest.json"
  [ $? -eq 0 ]
}

@test "_lint_task_size: warns for .spec.ts and .bats test files too" {
  local test_dir
  test_dir=$(mktemp -d)
  trap "rm -rf $test_dir" EXIT

  export _TASK_SPLIT_MAX_LINES=500
  export _TASK_SPLIT_MAX_CASES=10
  export _TASK_SPLIT_BLOCK=false
  export WORKTREE_DIR="$test_dir"
  export AI_RUN_EVENTS_FILE="${test_dir}/events.jsonl"
  export AI_RUN_DISPLAY_ID="test-lint-bats"
  : > "$AI_RUN_EVENTS_FILE"

  local bats_file="${test_dir}/oversized.bats"
  for _ in $(seq 1 501); do echo "# large bats file"; done > "$bats_file"

  cat > "${test_dir}/task-manifest.json" << 'JSON'
{ "version": 1, "task_count": 1, "tasks": [
  { "n": 1, "title": "Update bats tests", "files": ["oversized.bats"] }
] }
JSON

  _lint_task_size "${test_dir}/task-manifest.json"

  jq -e 'select(.type == "task_size.oversized")' "$AI_RUN_EVENTS_FILE" >/dev/null
}

@test "_lint_task_size: block=true FATAL on stderr with full task details" {
  local test_dir
  test_dir=$(mktemp -d)
  trap "rm -rf $test_dir" EXIT

  export _TASK_SPLIT_MAX_LINES=500
  export _TASK_SPLIT_MAX_CASES=10
  export _TASK_SPLIT_BLOCK=true
  export WORKTREE_DIR="$test_dir"
  export AI_RUN_EVENTS_FILE="${test_dir}/events.jsonl"
  export AI_RUN_DISPLAY_ID="test-lint-stderr"
  : > "$AI_RUN_EVENTS_FILE"

  local oversized="${test_dir}/oversized.test.ts"
  for _ in $(seq 1 501); do echo "// oversized line"; done > "$oversized"

  cat > "${test_dir}/task-manifest.json" << 'JSON'
{ "version": 1, "task_count": 1, "tasks": [
  { "n": 1, "title": "Refactor Oversized Test", "files": ["oversized.test.ts"] }
] }
JSON

  orchestrator_fail() {
    echo "orchestrator_fail would be called: $*" >&2
  }

  run _lint_task_size "${test_dir}/task-manifest.json"
  [ "$status" -eq 1 ]
  [[ "$output" == *"FATAL: Task 1 (Refactor Oversized Test) targets oversized test file oversized.test.ts: line count"* ]]
}

@test "_lint_task_size: block=true reports all oversized files, not just the first" {
  local test_dir
  test_dir=$(mktemp -d)
  trap "rm -rf $test_dir" EXIT

  export _TASK_SPLIT_MAX_LINES=500
  export _TASK_SPLIT_MAX_CASES=10
  export _TASK_SPLIT_BLOCK=true
  export WORKTREE_DIR="$test_dir"
  export AI_RUN_EVENTS_FILE="${test_dir}/events.jsonl"
  export AI_RUN_DISPLAY_ID="test-lint-block-all"
  : > "$AI_RUN_EVENTS_FILE"

  local big1="${test_dir}/big.test.ts"
  local big2="${test_dir}/huge.spec.ts"
  local big3="${test_dir}/massive.bats"
  for _ in $(seq 1 501); do echo "// line"; done > "$big1"
  for _ in $(seq 1 502); do echo "// line"; done > "$big2"
  for _ in $(seq 1 503); do echo "# line"; done > "$big3"

  cat > "${test_dir}/task-manifest.json" << 'JSON'
{ "version": 1, "task_count": 1, "tasks": [
  { "n": 1, "title": "Update all tests", "files": ["big.test.ts", "huge.spec.ts", "massive.bats"] }
] }
JSON

  run _lint_task_size "${test_dir}/task-manifest.json"
  [ "$status" -eq 1 ]
  [[ "$output" == *"big.test.ts"* ]]
  [[ "$output" == *"huge.spec.ts"* ]]
  [[ "$output" == *"massive.bats"* ]]
}
