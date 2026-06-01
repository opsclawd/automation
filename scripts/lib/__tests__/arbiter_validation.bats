#!/usr/bin/env bats
setup() {
  SCRIPT_PATH="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)/scripts/ai-run-issue-v2"
  eval "$(awk '
    /^_validate_arbiter_result\(\)/ { found=1 }
    found { print; if (/\{/) depth+=gsub(/{/,"{"); if (/\}/) depth-=gsub(/}/,"}"); if (depth==0 && found) { found=0; depth=0 } }
  ' "$SCRIPT_PATH")"
  LOG_OUTPUT=""
  log() { LOG_OUTPUT="${LOG_OUTPUT}$*\n"; }
  warn() { log "WARN: $*"; }
  FAIL_OUTPUT=""
  orchestrator_fail() { FAIL_OUTPUT="$*"; return 1; }
  TMPDIR_TEST="$(mktemp -d)"
  WORKTREE_DIR="$TMPDIR_TEST"
  EMIT_EVENT_ARGS=""
  emit_event() { EMIT_EVENT_ARGS="$*"; }
}
teardown() {
  rm -rf "$TMPDIR_TEST"
}
@test "validation: valid RESOLVED_TIEBREAK with evidence passes" {
  cat > "$TMPDIR_TEST/arbiter-result.json" << 'JSON'
{
  "outcome": "RESOLVED_TIEBREAK",
  "defect_classification": "verification_spec_defect",
  "evidence": "scripts/ai-run-issue-v2:2216 — grep matches content in revalidate block, which is out of scope per task description",
  "rationale": "The spec reviewer's failure references out-of-scope code",
  "amended_verification": "",
  "original_verification": ""
}
JSON
  _validate_arbiter_result
  [ "$ARBITER_OUTCOME" = "RESOLVED_TIEBREAK" ]
  [ "$ARBITER_VALID" = "true" ]
}
@test "validation: missing evidence rejects result" {
  cat > "$TMPDIR_TEST/arbiter-result.json" << 'JSON'
{
  "outcome": "RESOLVED_TIEBREAK",
  "defect_classification": "verification_spec_defect",
  "evidence": "",
  "rationale": "Something",
  "amended_verification": "",
  "original_verification": ""
}
JSON
  _validate_arbiter_result || true
  [ "$ARBITER_OUTCOME" = "BLOCKED_IMPL_DEFECT" ]
  [ "$ARBITER_VALID" = "false" ]
}
@test "validation: RESOLVED_AMENDED with narrower command passes" {
  cat > "$TMPDIR_TEST/arbiter-result.json" << 'JSON'
{
  "outcome": "RESOLVED_AMENDED",
  "defect_classification": "verification_spec_defect",
  "evidence": "scripts/ai-run-issue-v2:2216 — original grep was whole-file, task scope is validate block only",
  "rationale": "Narrowing grep to validate block matches task scope",
  "amended_verification": "grep -n 'build failed' scripts/ai-run-issue-v2 | awk 'NR>=2094 && NR<=2101'",
  "original_verification": "grep -n 'build failed' scripts/ai-run-issue-v2"
}
JSON
  _validate_arbiter_result
  [ "$ARBITER_OUTCOME" = "RESOLVED_AMENDED" ]
  [ "$ARBITER_VALID" = "true" ]
}
@test "validation: RESOLVED_AMENDED with empty amendment is rejected" {
  cat > "$TMPDIR_TEST/arbiter-result.json" << 'JSON'
{
  "outcome": "RESOLVED_AMENDED",
  "defect_classification": "verification_spec_defect",
  "evidence": "some evidence",
  "rationale": "Removing the check",
  "amended_verification": "",
  "original_verification": "grep -n 'build failed' scripts/ai-run-issue-v2"
}
JSON
  _validate_arbiter_result || true
  [ "$ARBITER_VALID" = "false" ]
}
@test "validation: BLOCKED_IMPL_DEFECT with evidence is valid" {
  cat > "$TMPDIR_TEST/arbiter-result.json" << 'JSON'
{
  "outcome": "BLOCKED_IMPL_DEFECT",
  "defect_classification": "implementation_defect",
  "evidence": "packages/domain/src/types.ts:42 — missing required field",
  "rationale": "Genuine bug in implementation",
  "amended_verification": "",
  "original_verification": ""
}
JSON
  _validate_arbiter_result
  [ "$ARBITER_OUTCOME" = "BLOCKED_IMPL_DEFECT" ]
  [ "$ARBITER_VALID" = "true" ]
}
@test "validation: DEVIATION_PROCEED with verification_spec_defect is valid" {
  cat > "$TMPDIR_TEST/arbiter-result.json" << 'JSON'
{
  "outcome": "DEVIATION_PROCEED",
  "defect_classification": "verification_spec_defect",
  "evidence": "plan.md Task 5 — verification command references out-of-scope file",
  "rationale": "Cannot auto-fix, proceeding with deviation",
  "amended_verification": "",
  "original_verification": ""
}
JSON
  _validate_arbiter_result
  [ "$ARBITER_OUTCOME" = "DEVIATION_PROCEED" ]
  [ "$ARBITER_VALID" = "true" ]
}
@test "validation: implementation_defect with DEVIATION_PROCEED is rejected" {
  cat > "$TMPDIR_TEST/arbiter-result.json" << 'JSON'
{
  "outcome": "DEVIATION_PROCEED",
  "defect_classification": "implementation_defect",
  "evidence": "some evidence",
  "rationale": "Proceeding despite implementation defect",
  "amended_verification": "",
  "original_verification": ""
}
JSON
  _validate_arbiter_result || true
  [ "$ARBITER_VALID" = "false" ]
}
@test "validation: implementation_defect with RESOLVED_TIEBREAK is rejected" {
  cat > "$TMPDIR_TEST/arbiter-result.json" << 'JSON'
{
  "outcome": "RESOLVED_TIEBREAK",
  "defect_classification": "implementation_defect",
  "evidence": "some evidence",
  "rationale": "Tiebreaking despite implementation defect",
  "amended_verification": "",
  "original_verification": ""
}
JSON
  _validate_arbiter_result || true
  [ "$ARBITER_VALID" = "false" ]
}
@test "validation: implementation_defect with RESOLVED_AMENDED is rejected" {
  cat > "$TMPDIR_TEST/arbiter-result.json" << 'JSON'
{
  "outcome": "RESOLVED_AMENDED",
  "defect_classification": "implementation_defect",
  "evidence": "some evidence",
  "rationale": "Amending despite implementation defect",
  "amended_verification": "narrower command",
  "original_verification": "original command"
}
JSON
  _validate_arbiter_result || true
  [ "$ARBITER_VALID" = "false" ]
}
@test "validation: missing result file is rejected" {
  _validate_arbiter_result || true
  [ "$ARBITER_VALID" = "false" ]
}
@test "validation: invalid JSON is rejected" {
  echo "not json" > "$TMPDIR_TEST/arbiter-result.json"
  _validate_arbiter_result || true
  [ "$ARBITER_VALID" = "false" ]
}
@test "validation: unknown outcome is rejected" {
  cat > "$TMPDIR_TEST/arbiter-result.json" << 'JSON'
{
  "outcome": "UNKNOWN_THING",
  "defect_classification": "verification_spec_defect",
  "evidence": "evidence",
  "rationale": "rationale",
  "amended_verification": "",
  "original_verification": ""
}
JSON
  _validate_arbiter_result || true
  [ "$ARBITER_VALID" = "false" ]
}
