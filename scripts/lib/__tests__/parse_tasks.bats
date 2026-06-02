#!/usr/bin/env bats

setup() {
  SCRIPT_PATH="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)/scripts/ai-run-issue-v2"
  eval "$(awk '
    /^_strip_fenced\(\)/ { found=1 }
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
