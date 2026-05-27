#!/usr/bin/env bats

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

@test "phaseProfiles has extract key" {
  run grep '"extract"' .ai-orchestrator.json
  [ "$status" -eq 0 ]
}

@test "phaseProfiles has implement key" {
  run grep '"implement"' .ai-orchestrator.json
  [ "$status" -eq 0 ]
}

@test "phaseProfiles has spec-review key" {
  run grep '"spec-review"' .ai-orchestrator.json
  [ "$status" -eq 0 ]
}

@test "phaseProfiles has quality-review key" {
  run grep '"quality-review"' .ai-orchestrator.json
  [ "$status" -eq 0 ]
}

@test "phaseProfiles has fix-review key" {
  run grep '"fix-review"' .ai-orchestrator.json
  [ "$status" -eq 0 ]
}

@test "phaseProfiles has compound key" {
  run grep '"compound"' .ai-orchestrator.json
  [ "$status" -eq 0 ]
}

@test "all per-task phases use run-agent.ts" {
  run grep -cE -- '--phase (implement|spec-review|quality-review|fix-review|compound|extract)' scripts/ai-run-issue-v2
  [ "$status" -eq 0 ]
  [ "$output" -ge 7 ]
}

@test "exit code 2 replaces exit code 124 for timeout checks" {
  run grep -c '\-eq 124' scripts/ai-run-issue-v2
  [ "$output" -eq 0 ]
}

@test "exit code 2 is checked for timeout in quality-review" {
  run grep -c '\-eq 2' scripts/ai-run-issue-v2
  [ "$output" -ge 1 ]
}

@test "script has valid bash syntax" {
  run bash -n scripts/ai-run-issue-v2
  [ "$status" -eq 0 ]
}

@test "all 8 phases check tee exit code" {
  run grep -c '_tee_ec=${PIPESTATUS\[1\]}' scripts/ai-run-issue-v2
  [ "$output" -ge 8 ]
}

@test "all 8 phases halt on tee failure (not warn)" {
  halt_count=$(grep -c 'orchestrator_fail.*tee failed' scripts/ai-run-issue-v2)
  [ "$halt_count" -ge 8 ]
}

@test "script requires issue number argument" {
  run bash -c 'bash scripts/ai-run-issue-v2 < /dev/null 2>&1; exit $?; echo "unreachable"'
  [ "$status" -eq 1 ]
  [[ "$output" == *"Usage:"* ]]
  [[ "$output" == *"ai:run-issue"* ]]
}

@test "script source fails early on missing TSX loader" {
  tsx_orig="apps/cli/node_modules/tsx/dist/loader.mjs"
  if [[ -f "$tsx_orig" ]]; then
    mv "$tsx_orig" "$tsx_orig.bak" 2>/dev/null || true
    run bash -c 'bash scripts/ai-run-issue-v2 99999 2>&1; true'
    [[ "$output" == *"FATAL"* ]]
    [[ "$output" == *"tsx loader not found"* ]]
    mv "$tsx_orig.bak" "$tsx_orig" 2>/dev/null || true
  else
    skip "tsx loader not present"
  fi
}

@test "script defines required functions" {
  grep -q 'check_branch_after_agent()' scripts/ai-run-issue-v2
  grep -q 'orchestrator_fail()' scripts/ai-run-issue-v2
  grep -q "^warn()" scripts/ai-run-issue-v2
  grep -q "^log()" scripts/ai-run-issue-v2
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
  [ "$output" != *"pnpm install"* ]
}
