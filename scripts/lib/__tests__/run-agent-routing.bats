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

@test "exit code 2 is checked for timeout in spec-review and quality-review" {
  run grep -c '\-eq 2' scripts/ai-run-issue-v2
  [ "$output" -ge 2 ]
}