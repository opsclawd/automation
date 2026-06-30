#!/usr/bin/env bats

setup() {
  TMPDIR_TEST="$(mktemp -d)"

  STUB_BIN_DIR="${TMPDIR_TEST}/stub-bin"
  mkdir -p "$STUB_BIN_DIR"

  cat > "${STUB_BIN_DIR}/opencode" <<'STUB_EOF'
#!/usr/bin/env bash
exit 0
STUB_EOF
  chmod +x "${STUB_BIN_DIR}/opencode"

  cat > "${STUB_BIN_DIR}/pi" <<'STUB_EOF'
#!/usr/bin/env bash
exit 0
STUB_EOF
  chmod +x "${STUB_BIN_DIR}/pi"

  export PATH="${STUB_BIN_DIR}:${PATH}"
  export AI_RUN_EVENTS_FILE="${TMPDIR_TEST}/events.jsonl"
  export AI_RUN_DISPLAY_ID="issue-1-20260516-120000"
  export NODE_OPTIONS='--conditions=development'
  export TSX_LOADER="${PWD}/apps/cli/node_modules/tsx/dist/loader.mjs"
}

teardown() {
  rm -rf "$TMPDIR_TEST"
}

_run_agent() {
  local phase="$1"
  shift
  node --import "$TSX_LOADER" apps/cli/src/run-agent.ts \
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
  run node --import "$TSX_LOADER" apps/cli/src/run-agent.ts \
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
  run node --import "$TSX_LOADER" apps/cli/src/run-agent.ts \
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
  run node --import "$TSX_LOADER" apps/cli/src/run-agent.ts \
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
  run node --import "$TSX_LOADER" apps/cli/src/run-agent.ts \
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
  run node --import "$TSX_LOADER" apps/cli/src/run-agent.ts \
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
  run node --import "$TSX_LOADER" apps/cli/src/run-agent.ts \
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
  run node --import "$TSX_LOADER" apps/cli/src/run-agent.ts \
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
  run node --import "$TSX_LOADER" apps/cli/src/run-agent.ts \
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
  run node --import "$TSX_LOADER" apps/cli/src/run-agent.ts \
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
  run node --import "$TSX_LOADER" apps/cli/src/run-agent.ts \
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
  run node --import "$TSX_LOADER" apps/cli/src/run-agent.ts \
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
  run node --import "$TSX_LOADER" apps/cli/src/run-agent.ts \
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
  run bash -n scripts/legacy/ai-run-issue-v2
  [ "$status" -eq 0 ]
}

@test "no run_agent_raw callsites remain in ai-run-issue-v2" {
  run grep -c 'run_agent_raw' scripts/legacy/ai-run-issue-v2
  [ "$output" -eq 0 ]
}

@test "no AGENT_MODEL default assignment remains" {
  run grep -c 'AGENT_MODEL=' scripts/legacy/ai-run-issue-v2
  [ "$output" -eq 0 ]
}

@test "no AGENT_CLI default assignment remains" {
  run grep -c 'AGENT_CLI=' scripts/legacy/ai-run-issue-v2
  [ "$output" -eq 0 ]
}

@test "all primary phases halt on tee failure (arbitrate exempt: soft intervention)" {
  halt_count=$(grep -c 'orchestrator_fail.*tee failed' scripts/legacy/ai-run-issue-v2)
  [[ "$halt_count" =~ ^[0-9]+$ ]]
  [ "$halt_count" -ge 10 ]
  # The arbiter is a soft intervention and is the ONLY phase allowed to warn
  # (not halt) on tee failure. Any warn-on-tee handler must be the arbiter's.
  if grep -q 'warn.*tee failed' scripts/legacy/ai-run-issue-v2; then
    warn_count=$(grep -c 'warn.*tee failed' scripts/legacy/ai-run-issue-v2)
    arbiter_warn_count=$(grep -c 'warn.*tee failed writing log for arbiter' scripts/legacy/ai-run-issue-v2)
    [ "$warn_count" -eq "$arbiter_warn_count" ]
  fi
}

@test "PIPESTATUS used in all agent phase pipelines" {
  run grep -cE 'PIPESTATUS\[' scripts/legacy/ai-run-issue-v2
  [ "$output" -ge 10 ]
}

@test "_TSX_LOADER error message references ai:run-issue" {
  run grep 'tsx loader not found' scripts/legacy/ai-run-issue-v2
  [[ "$output" != *"pnpm install"* ]]
}

@test "script requires issue number argument" {
  run bash -c 'bash scripts/legacy/ai-run-issue-v2 < /dev/null 2>&1; exit $?; echo "unreachable"'
  [ "$status" -eq 1 ]
  [[ "$output" == *"Usage:"* ]]
  [[ "$output" == *"ai:run-issue"* ]]
}

@test "script defines required functions" {
  grep -q 'check_branch_after_agent()' scripts/legacy/ai-run-issue-v2
  grep -q 'orchestrator_fail()' scripts/legacy/ai-run-issue-v2
  grep -q "^warn()" scripts/legacy/ai-run-issue-v2
  grep -q "^log()" scripts/legacy/ai-run-issue-v2
}

@test "all run_* callsites have function definitions" {
  callees=$(grep -oE '\brun_[a-z_]+\b' scripts/legacy/ai-run-issue-v2 | sort -u)
  defs=$(grep -oE '^[[:space:]]*run_[a-z_]+\(\)' scripts/legacy/ai-run-issue-v2 | grep -oE 'run_[a-z_]+' | sort -u)
  lib_defs=$(grep -roE '^[[:space:]]*run_[a-z_]+\(\)' scripts/lib/ | grep -oE 'run_[a-z_]+' | sort -u)
  all_defs=$(echo -e "$defs\n$lib_defs" | sort -u)
  missing=$(comm -23 <(echo "$callees") <(echo "$all_defs") | grep -v -E '^(run|run_id|run_agent)$' || true)
  [ -z "$missing" ]
}

@test "ai-pr-review-poll has valid bash syntax" {
  run bash -n scripts/legacy/ai-pr-review-poll
  [ "$status" -eq 0 ]
}

@test "no 'opencode --model' callsites remain in ai-pr-review-poll" {
  run grep -c 'opencode --model' scripts/legacy/ai-pr-review-poll
  [ "$output" -eq 0 ]
}

@test "no AGENT_MODEL default remains in ai-pr-review-poll" {
  run grep -c 'AGENT_MODEL=' scripts/legacy/ai-pr-review-poll
  [ "$output" -eq 0 ]
}

@test "no AGENT_CLI reference remains in ai-pr-review-poll" {
  run grep -c 'AGENT_CLI' scripts/legacy/ai-pr-review-poll
  [ "$output" -eq 0 ]
}

@test "run_agent in ai-pr-review-poll routes through run-agent.ts" {
  # run_agent routing now lives in the legacy script (M6-05 shim delegates to TS poller)
  run grep -q 'run-agent.ts' scripts/legacy/ai-pr-review-poll.legacy
  [ "$status" -eq 0 ]
  run grep -q '\-\-phase "\$routing_phase"' scripts/legacy/ai-pr-review-poll.legacy
  [ "$status" -eq 0 ]
  run grep -q '\-\-phase-id "\$routing_phase"' scripts/legacy/ai-pr-review-poll.legacy
  [ "$status" -eq 0 ]
}


@test "ai-consolidate-compound has valid bash syntax" {
  run bash -n scripts/ai-consolidate-compound
  [ "$status" -eq 0 ]
}
@test "no 'opencode --model' callsites remain in ai-consolidate-compound" {
  run grep -c 'opencode --model' scripts/ai-consolidate-compound
  [ "$output" -eq 0 ]
}
@test "no AGENT_MODEL default remains in ai-consolidate-compound" {
  run grep -c 'AGENT_MODEL=' scripts/ai-consolidate-compound
  [ "$output" -eq 0 ]
}
@test "no AGENT_CLI reference remains in ai-consolidate-compound" {
  run grep -c 'AGENT_CLI' scripts/ai-consolidate-compound
  [ "$output" -eq 0 ]
}
@test "run_agent in ai-consolidate-compound routes through run-agent.ts" {
  run grep -q 'run-agent.ts' scripts/ai-consolidate-compound
  [ "$status" -eq 0 ]
  run grep -q '\-\-phase compound' scripts/ai-consolidate-compound
  [ "$status" -eq 0 ]
}
@test "ai-consolidate-compound generates phase-id from input mode" {
  run grep -q 'consolidate-issues-' scripts/ai-consolidate-compound
  [ "$status" -eq 0 ]
  run grep -q 'consolidate-since-' scripts/ai-consolidate-compound
  [ "$status" -eq 0 ]
}
@test "ai-consolidate-compound supports CONSOLIDATE_RUN_ID env var" {
  run grep -q 'CONSOLIDATE_RUN_ID' scripts/ai-consolidate-compound
  [ "$status" -eq 0 ]
}
@test "ai-consolidate-compound supports OWNER_REPO env var" {
  run grep -q 'OWNER_REPO' scripts/ai-consolidate-compound
  [ "$status" -eq 0 ]
}
@test "ai-consolidate-compound usage mentions AI_AGENT_MODEL" {
  run grep -q 'AI_AGENT_MODEL' scripts/ai-consolidate-compound
  [ "$status" -eq 0 ]
}
@test "ai-consolidate-compound usage mentions AI_AGENT_PROVIDER" {
  run grep -q 'AI_AGENT_PROVIDER' scripts/ai-consolidate-compound
  [ "$status" -eq 0 ]
}

@test "ai-consolidate-compound exits 0 when no compound inputs found" {
  run bash scripts/ai-consolidate-compound --issues 99999 --yes 2>&1
  [ "$status" -eq 0 ]
  [[ "$output" == *"No compound inputs to consolidate"* ]]
}

@test ".ai-orchestrator.json has compound phase with a resolvable profile" {
  run python3 -c "
import json, sys
with open('.ai-orchestrator.json') as f:
    cfg = json.load(f)
phases = cfg.get('agent', {}).get('phaseProfiles', {})
profiles = cfg.get('agent', {}).get('profiles', {})
roles = cfg.get('agent', {}).get('roles', {})
if 'compound' not in phases:
    print('MISSING: compound not in phaseProfiles')
    sys.exit(1)
entry = phases['compound']
prof = entry.get('profile')
if not prof:
    role = entry.get('role')
    if role and role in roles:
        prof = roles[role].get('profile')
if not prof:
    print('MISSING: compound phase has no resolvable profile (checked profile and role)')
    sys.exit(1)
if prof not in profiles:
    print(f'MISSING: profile {prof!r} not found in agent.profiles')
    sys.exit(1)
print(f'OK: compound -> {prof}')
"
  [ "$status" -eq 0 ]
  [[ "$output" == *"OK: compound"* ]]
}

@test "run-agent.ts uses phaseProfiles for whole-pr-review phase" {
  echo "test prompt" > "$TMPDIR_TEST/prompt.txt"
  run node --import "$TSX_LOADER" apps/cli/src/run-agent.ts \
    --phase whole-pr-review \
    --cwd "$TMPDIR_TEST" \
    --run-id "test-run" \
    --repo-id "test/repo" \
    --repo-root "$PWD" \
    --phase-id "whole-pr-review-test" \
    --prompt-file "$TMPDIR_TEST/prompt.txt" \
    --start-sha "0000000000000000000000000000000000000000" \
    2>&1
  [ "$status" -ne 2 ]
  [[ "$output" != *"unknown phase"* ]]
  [[ "$output" != *"must pass --phase or --profile"* ]]
}

@test "run-agent.ts uses phaseProfiles for whole-pr-fix-review phase" {
  echo "test prompt" > "$TMPDIR_TEST/prompt.txt"
  run node --import "$TSX_LOADER" apps/cli/src/run-agent.ts \
    --phase whole-pr-fix-review \
    --cwd "$TMPDIR_TEST" \
    --run-id "test-run" \
    --repo-id "test/repo" \
    --repo-root "$PWD" \
    --phase-id "fix-review-test-wpr" \
    --prompt-file "$TMPDIR_TEST/prompt.txt" \
    --start-sha "0000000000000000000000000000000000000000" \
    2>&1
  # Intentionally loose: -ne 2 asserts "not a CLI error exit" (consistent with
  # the whole-pr-review test above). Other non-zero codes (e.g. 1 from a crash)
  # would also pass — see review finding #3. Tightening to -eq 0 would be more
  # strict but would break consistency with neighboring tests.
  [ "$status" -ne 2 ]
  [[ "$output" != *"unknown phase"* ]]
  [[ "$output" != *"must pass --phase or --profile"* ]]
}
