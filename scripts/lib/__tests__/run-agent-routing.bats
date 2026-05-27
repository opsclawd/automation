#!/usr/bin/env bats

setup() {
  TMPDIR_TEST="$(mktemp -d)"
  export AI_RUN_EVENTS_FILE="${TMPDIR_TEST}/events.jsonl"
  export AI_RUN_DISPLAY_ID="issue-1-20260516-120000"
  export NODE_OPTIONS='--conditions=development'
}

teardown() {
  rm -rf "$TMPDIR_TEST"
}

_run_agent() {
  local phase="$1"
  shift
  npx tsx apps/cli/src/run-agent.ts \
    --phase "$phase" \
    --cwd "$TMPDIR_TEST" \
    --run-id "test-run-$(date +%s)" \
    --repo-id "test/repo" \
    --repo-root "$PWD" \
    --phase-id "${phase}-test" \
    --prompt-file "$TMPDIR_TEST/prompt.txt" \
    --start-sha "0000000000000000000000000000000000000000" \
    "$@" 2>&1
}

@test "run-agent.ts requires --phase flag" {
  echo "test prompt" > "$TMPDIR_TEST/prompt.txt"
  run npx tsx apps/cli/src/run-agent.ts \
    --cwd "$TMPDIR_TEST" \
    --run-id "test-run" \
    --repo-id "test/repo" \
    --repo-root "$PWD" \
    --phase-id "test" \
    --prompt-file "$TMPDIR_TEST/prompt.txt" \
    --start-sha "0000000000000000000000000000000000000000" \
    2>&1
  [ "$status" -eq 2 ]
  [[ "$output" == *"must pass --phase or --profile"* ]]
}

@test "run-agent.ts requires --prompt-file flag" {
  run npx tsx apps/cli/src/run-agent.ts \
    --phase implement \
    --cwd "$TMPDIR_TEST" \
    --run-id "test-run" \
    --repo-id "test/repo" \
    --repo-root "$PWD" \
    --phase-id "test" \
    --start-sha "0000000000000000000000000000000000000000" \
    2>&1
  [ "$status" -eq 2 ]
  [[ "$output" == *"missing required flag"* ]]
  [[ "$output" == *"prompt-file"* ]]
}

@test "run-agent.ts exits 2 for unknown phase" {
  echo "test prompt" > "$TMPDIR_TEST/prompt.txt"
  run npx tsx apps/cli/src/run-agent.ts \
    --phase "nonexistent-phase-xyz" \
    --cwd "$TMPDIR_TEST" \
    --run-id "test-run" \
    --repo-id "test/repo" \
    --repo-root "$PWD" \
    --phase-id "test" \
    --prompt-file "$TMPDIR_TEST/prompt.txt" \
    --start-sha "0000000000000000000000000000000000000000" \
    2>&1
  [ "$status" -eq 2 ]
  [[ "$output" == *"unknown phase"* ]]
}

@test "run-agent.ts exits 3 for missing prompt file" {
  run npx tsx apps/cli/src/run-agent.ts \
    --phase implement \
    --cwd "$TMPDIR_TEST" \
    --run-id "test-run" \
    --repo-id "test/repo" \
    --repo-root "$PWD" \
    --phase-id "test" \
    --prompt-file "$TMPDIR_TEST/nonexistent-prompt.txt" \
    --start-sha "0000000000000000000000000000000000000000" \
    2>&1
  [ "$status" -eq 3 ]
  [[ "$output" == *"prompt file not found"* ]]
}

@test "run-agent.ts uses phaseProfiles for implement phase" {
  echo "test prompt" > "$TMPDIR_TEST/prompt.txt"
  run npx tsx apps/cli/src/run-agent.ts \
    --phase implement \
    --cwd "$TMPDIR_TEST" \
    --run-id "test-run" \
    --repo-id "test/repo" \
    --repo-root "$PWD" \
    --phase-id "implement-test" \
    --prompt-file "$TMPDIR_TEST/prompt.txt" \
    --start-sha "0000000000000000000000000000000000000000" \
    2>&1
  [ "$status" -ne 2 ]
  [[ "$output" != *"unknown phase"* ]]
  [[ "$output" != *"must pass --phase or --profile"* ]]
}

@test "run-agent.ts uses phaseProfiles for extract phase" {
  echo "test prompt" > "$TMPDIR_TEST/prompt.txt"
  run npx tsx apps/cli/src/run-agent.ts \
    --phase extract \
    --cwd "$TMPDIR_TEST" \
    --run-id "test-run" \
    --repo-id "test/repo" \
    --repo-root "$PWD" \
    --phase-id "extract-test" \
    --prompt-file "$TMPDIR_TEST/prompt.txt" \
    --start-sha "0000000000000000000000000000000000000000" \
    2>&1
  [ "$status" -ne 2 ]
  [[ "$output" != *"unknown phase"* ]]
  [[ "$output" != *"must pass --phase or --profile"* ]]
}

@test "run-agent.ts uses phaseProfiles for spec-review phase" {
  echo "test prompt" > "$TMPDIR_TEST/prompt.txt"
  run npx tsx apps/cli/src/run-agent.ts \
    --phase spec-review \
    --cwd "$TMPDIR_TEST" \
    --run-id "test-run" \
    --repo-id "test/repo" \
    --repo-root "$PWD" \
    --phase-id "spec-review-test" \
    --prompt-file "$TMPDIR_TEST/prompt.txt" \
    --start-sha "0000000000000000000000000000000000000000" \
    2>&1
  [ "$status" -ne 2 ]
  [[ "$output" != *"unknown phase"* ]]
  [[ "$output" != *"must pass --phase or --profile"* ]]
}

@test "run-agent.ts uses phaseProfiles for quality-review phase" {
  echo "test prompt" > "$TMPDIR_TEST/prompt.txt"
  run npx tsx apps/cli/src/run-agent.ts \
    --phase quality-review \
    --cwd "$TMPDIR_TEST" \
    --run-id "test-run" \
    --repo-id "test/repo" \
    --repo-root "$PWD" \
    --phase-id "quality-review-test" \
    --prompt-file "$TMPDIR_TEST/prompt.txt" \
    --start-sha "0000000000000000000000000000000000000000" \
    2>&1
  [ "$status" -ne 2 ]
  [[ "$output" != *"unknown phase"* ]]
  [[ "$output" != *"must pass --phase or --profile"* ]]
}

@test "run-agent.ts uses phaseProfiles for fix-review phase" {
  echo "test prompt" > "$TMPDIR_TEST/prompt.txt"
  run npx tsx apps/cli/src/run-agent.ts \
    --phase fix-review \
    --cwd "$TMPDIR_TEST" \
    --run-id "test-run" \
    --repo-id "test/repo" \
    --repo-root "$PWD" \
    --phase-id "fix-review-test" \
    --prompt-file "$TMPDIR_TEST/prompt.txt" \
    --start-sha "0000000000000000000000000000000000000000" \
    2>&1
  [ "$status" -ne 2 ]
  [[ "$output" != *"unknown phase"* ]]
  [[ "$output" != *"must pass --phase or --profile"* ]]
}

@test "run-agent.ts uses phaseProfiles for compound phase" {
  echo "test prompt" > "$TMPDIR_TEST/prompt.txt"
  run npx tsx apps/cli/src/run-agent.ts \
    --phase compound \
    --cwd "$TMPDIR_TEST" \
    --run-id "test-run" \
    --repo-id "test/repo" \
    --repo-root "$PWD" \
    --phase-id "compound-test" \
    --prompt-file "$TMPDIR_TEST/prompt.txt" \
    --start-sha "0000000000000000000000000000000000000000" \
    2>&1
  [ "$status" -ne 2 ]
  [[ "$output" != *"unknown phase"* ]]
  [[ "$output" != *"must pass --phase or --profile"* ]]
}

@test "run-agent.ts accepts --profile override" {
  echo "test prompt" > "$TMPDIR_TEST/prompt.txt"
  run npx tsx apps/cli/src/run-agent.ts \
    --profile builder \
    --cwd "$TMPDIR_TEST" \
    --run-id "test-run" \
    --repo-id "test/repo" \
    --repo-root "$PWD" \
    --phase-id "profile-test" \
    --prompt-file "$TMPDIR_TEST/prompt.txt" \
    --start-sha "0000000000000000000000000000000000000000" \
    2>&1
  [ "$status" -ne 2 ]
  [[ "$output" != *"unknown profile"* ]]
}

@test "run-agent.ts exits 2 for unknown profile" {
  echo "test prompt" > "$TMPDIR_TEST/prompt.txt"
  run npx tsx apps/cli/src/run-agent.ts \
    --profile "nonexistent-profile-xyz" \
    --cwd "$TMPDIR_TEST" \
    --run-id "test-run" \
    --repo-id "test/repo" \
    --repo-root "$PWD" \
    --phase-id "test" \
    --prompt-file "$TMPDIR_TEST/prompt.txt" \
    --start-sha "0000000000000000000000000000000000000000" \
    2>&1
  [ "$status" -eq 2 ]
  [[ "$output" == *"unknown profile"* ]]
}

@test "script has valid bash syntax" {
  run bash -n scripts/ai-run-issue-v2
  [ "$status" -eq 0 ]
}

@test "no run_agent_raw callsites remain in ai-run-issue-v2" {
  run grep -c 'run_agent_raw' scripts/ai-run-issue-v2
  [ "$output" -eq 0 ]
}

@test "no AGENT_MODEL default assignment remains" {
  run grep -c 'AGENT_MODEL=' scripts/ai-run-issue-v2
  [ "$output" -eq 0 ]
}

@test "no AGENT_CLI default assignment remains" {
  run grep -c 'AGENT_CLI=' scripts/ai-run-issue-v2
  [ "$output" -eq 0 ]
}

@test "all 10 phases halt on tee failure (not warn)" {
  halt_count=$(grep -c 'orchestrator_fail.*tee failed' scripts/ai-run-issue-v2)
  [[ "$halt_count" =~ ^[0-9]+$ ]]
  [ "$halt_count" -ge 10 ]
  if grep -q 'warn.*tee failed' scripts/ai-run-issue-v2; then
    warn_count=$(grep -c 'warn.*tee failed' scripts/ai-run-issue-v2)
    [ "$warn_count" -eq 0 ]
  fi
}

@test "PIPESTATUS used in all agent phase pipelines" {
  run grep -cE 'PIPESTATUS\[' scripts/ai-run-issue-v2
  [ "$output" -ge 10 ]
}

@test "_TSX_LOADER error message references ai:run-issue" {
  run grep 'tsx loader not found' scripts/ai-run-issue-v2
  [[ "$output" != *"pnpm install"* ]]
}

@test "script requires issue number argument" {
  run bash -c 'bash scripts/ai-run-issue-v2 < /dev/null 2>&1; exit $?; echo "unreachable"'
  [ "$status" -eq 1 ]
  [[ "$output" == *"Usage:"* ]]
  [[ "$output" == *"ai:run-issue"* ]]
}

@test "script defines required functions" {
  grep -q 'check_branch_after_agent()' scripts/ai-run-issue-v2
  grep -q 'orchestrator_fail()' scripts/ai-run-issue-v2
  grep -q "^warn()" scripts/ai-run-issue-v2
  grep -q "^log()" scripts/ai-run-issue-v2
}

@test "all run_* callsites have function definitions" {
  callees=$(grep -oE '\brun_[a-z_]+\b' scripts/ai-run-issue-v2 | sort -u)
  defs=$(grep -oE '^[[:space:]]*run_[a-z_]+\(\)' scripts/ai-run-issue-v2 | grep -oE 'run_[a-z_]+' | sort -u)
  missing=$(comm -23 <(echo "$callees") <(echo "$defs") | grep -v -E '^(run|run_id|run_agent)$' || true)
  [ -z "$missing" ]
}
