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

  TMPDIR_TEST="$(mktemp -d)"
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
