#!/usr/bin/env bash
# plan-review.sh — Adversarial plan review functions for the orchestrator.

# _checksum_file: Compute a stable checksum for a file, or empty string if missing.
_checksum_file() {
  [[ -f "$1" ]] && sha256sum "$1" 2>/dev/null | cut -d' ' -f1 || echo ""
}

# _check_excluded_file_integrity: Verify that a git-excluded file has not been
# modified by an agent. Git's --exclude-standard hides ignored files from
# ls-files and diff, so _check_review_worktree_violations cannot detect edits
# to files in the exclude list (e.g., plan.md when seed_excludes ignores it).
# Calls orchestrator_fail on mismatch.
# Args:
#   $1 — file path
#   $2 — expected checksum (from _checksum_file captured before agent ran)
#   $3 — label for error message (e.g., "plan.md")
_check_excluded_file_integrity() {
  local file_path="$1"
  local expected_checksum="$2"
  local label="${3:-$(basename "$file_path")}"
  local actual_checksum
  actual_checksum=$(_checksum_file "$file_path")
  if [[ "$actual_checksum" != "$expected_checksum" ]]; then
    orchestrator_fail "Agent modified excluded file ${label} (contract violation): checksum changed from '${expected_checksum:-<missing>}' to '${actual_checksum:-<missing>}'"
  fi
}

# _check_review_worktree_violations: Verify that the review/fix agents did not
# modify files outside the allowed set. Calls orchestrator_fail on violation.
# Args:
#   $1 — worktree dir
#   $2 — (optional) pre-agent SHA; if set, also checks for committed changes
#   $3 — (optional) allowlist regex; defaults to plan.md + findings.
#        Pass a stricter pattern for reviewer calls (findings only).
#        The pass marker is NEVER in the allowlist — only the orchestrator
#        writes it after run_plan_review_loop returns success.
_check_review_worktree_violations() {
  local worktree_dir="$1"
  local pre_sha="${2:-}"
  local allowlist="${3:-^(plan\.md|plan-review-findings\.md|task-manifest\.json)$}"
  local violations
  violations=$({
    git -C "$worktree_dir" diff --name-only HEAD 2>/dev/null
    git -C "$worktree_dir" ls-files --others --exclude-standard 2>/dev/null
    if [[ -n "$pre_sha" ]]; then
      git -C "$worktree_dir" diff --name-only "$pre_sha"..HEAD 2>/dev/null
    fi
  } | grep . | grep -vE "$allowlist" | tr '\n' ' ' || true)
  # Also check for review artifacts hidden from git by .git/info/exclude rules.
  # seed_excludes adds plan-review-passed.marker to the exclude list, so
  # --exclude-standard won't surface it even if an agent creates it.
  local _excluded_artifacts=""
  if [[ ! "$allowlist" =~ plan-review-passed\.marker ]] && [[ -f "${worktree_dir}/plan-review-passed.marker" ]]; then
    _excluded_artifacts="plan-review-passed.marker"
  fi
  if [[ -n "$violations$_excluded_artifacts" ]]; then
    orchestrator_fail "Plan review/fix agent modified unexpected files (contract violation): ${violations}${_excluded_artifacts}"
  fi
}

# classify_plan_risk: Check if plan.md contains the <!-- plan-review-required -->
# sentinel written by the plan-write agent when it detects retry/state-machine/
# side-effect patterns.
# Returns 0 if review required, 1 if skip.
# Args:
#   $1 — path to the worktree directory containing plan.md
classify_plan_risk() {
  local worktree_dir="$1"
  local plan_file="${worktree_dir}/plan.md"

  if [[ ! -f "$plan_file" ]]; then
    return 1
  fi

  if grep -q '<!-- plan-review-required -->' "$plan_file"; then
    return 0
  fi

  return 1
}

# parse_review_findings: Read plan-review-findings.md and extract the highest
# severity level present.
# Returns one of: PASS | P2_ACKNOWLEDGED | P1_FOUND | PROCEED_WITH_CONCERNS
# Args:
#   $1 — path to the worktree directory containing plan-review-findings.md
parse_review_findings() {
  local worktree_dir="$1"
  local findings_file="${worktree_dir}/plan-review-findings.md"

  if [[ ! -f "$findings_file" ]]; then
    echo "PASS"
    return
  fi

  if grep -qiE 'Review Result:[[:space:]]*PROCEED_WITH_CONCERNS' "$findings_file"; then
    echo "PROCEED_WITH_CONCERNS"
    return
  fi

  local _p1_unresolved _p2_unresolved
  read -r _p1_unresolved _p2_unresolved < <(
    awk '
      function flush() {
        if (in_block && sev=="P1" && !resolved) p1++
        if (in_block && sev=="P2" && !resolved) p2++
        in_block=0; sev=""; resolved=0
      }
      /^## Review Result:/ { next }
      (tolower($0) ~ /^[[:space:]]*#{2,3}[[:space:]]+p1:/) || (tolower($0) ~ /^[[:space:]]*[-*][[:space:]]*\*\*p1\*\*/) || (tolower($0) ~ /^[[:space:]]*severity:[[:space:]]*p1($|[[:space:]])/) { flush(); in_block=1; sev="P1" }
      (tolower($0) ~ /^[[:space:]]*#{2,3}[[:space:]]+p2:/) || (tolower($0) ~ /^[[:space:]]*[-*][[:space:]]*\*\*p2\*\*/) || (tolower($0) ~ /^[[:space:]]*severity:[[:space:]]*p2($|[[:space:]])/) { flush(); in_block=1; sev="P2" }
      (tolower($0) ~ /^[[:space:]]*#{2,3}[[:space:]]/) && !in_block { flush(); in_block=1 }
      /\*\*RESOLVED\*\*/ || /— RESOLVED/ { resolved=1 }
      END { flush(); print p1+0, p2+0 }
    ' "$findings_file"
  )

  if [[ "$_p1_unresolved" -gt 0 ]]; then
    echo "P1_FOUND"
    return
  fi

  if [[ "$_p2_unresolved" -gt 0 ]]; then
    echo "P2_ACKNOWLEDGED"
    return
  fi

  echo "PASS"
}

# parse_judgment_decision: Read plan-review-judgment.md and extract the judgment.
# Returns one of: PROCEED | PROCEED_WITH_CAVEATS | ESCALATE
# Args:
#   $1 — path to the worktree directory containing plan-review-judgment.md
parse_judgment_decision() {
  local worktree_dir="$1"
  local judgment_file="${worktree_dir}/plan-review-judgment.md"

  if [[ ! -f "$judgment_file" ]]; then
    echo "ESCALATE"
    return
  fi

  local judgment_line
  judgment_line=$(grep -iE '^## Judgment:' "$judgment_file" | head -1 || true)
  if [[ -z "$judgment_line" ]]; then
    echo "ESCALATE"
    return
  fi

  if echo "$judgment_line" | grep -qiE 'PROCEED_WITH_CAVEATS'; then
    echo "PROCEED_WITH_CAVEATS"
    return
  fi

  if echo "$judgment_line" | grep -qiE 'PROCEED'; then
    echo "PROCEED"
    return
  fi

  if echo "$judgment_line" | grep -qiE 'ESCALATE'; then
    echo "ESCALATE"
    return
  fi

  echo "ESCALATE"
}

# _append_known_limitations: Append items to a Known Limitations section in plan.md.
# Creates the section if it doesn't exist.
# Args:
#   $1 — path to plan.md
#   $2... — items to append (each as a separate argument)
_append_known_limitations() {
  local plan_file="$1"
  shift
  local items=("$@")
  if [[ ! -f "$plan_file" ]]; then
    return
  fi
  if grep -q '^## Known Limitations' "$plan_file"; then
    for item in "${items[@]}"; do
      echo "$item" >> "$plan_file"
    done
  else
    printf '\n## Known Limitations\n' >> "$plan_file"
    for item in "${items[@]}"; do
      echo "$item" >> "$plan_file"
    done
  fi
}

# run_adversarial_reviewer: Invoke the reviewer agent to read plan.md and
# produce plan-review-findings.md.
# Args:
#   $1 — worktree dir
#   $2 — repo root
#   $3 — run ID
#   $4 — repo ID
#   $5 — branch name
#   $6 — timeout seconds
#   $7 — iteration number (for logging)
#   $8 — (optional) path to previous iteration's findings file; empty on first iteration
run_adversarial_reviewer() {
  local worktree_dir="$1"
  local repo_root="$2"
  local run_id="$3"
  local repo_id="$4"
  local branch="$5"
  local timeout_sec="$6"
  local iteration="$7"
  local prev_findings_path="${8:-}"

  local issues_dir="$worktree_dir"
  local tsx_loader="${_TSX_LOADER:-tsx}"

  log "  Plan review: invoking adversarial reviewer (iteration ${iteration})..."

  local REVIEWER_PROMPT="You are an adversarial plan reviewer. Your job is to find design-level errors in the implementation plan.
## CONTEXT
You are reviewing: ${worktree_dir}/plan.md
## YOUR ROLE
Read the plan document. Your scope is NARROW:
1. Identify all state transitions, side effects, and retry/recovery paths.
2. For each, verify that the stated behavior is correct and complete given the runtime semantics.
3. Quote specific plan text that is wrong or incomplete.
4. Explain what actually happens at runtime.
5. Classify each finding as P1 (will cause incorrect behavior at runtime) or P2 (incomplete but not incorrect).
## SCOPE RESTRICTIONS
- Do NOT review code style, naming, or general plan quality.
- Do NOT suggest improvements outside state transitions, side effects, and retry paths.
- Do NOT edit any source files. Your ONLY output is plan-review-findings.md.
## OUTPUT FORMAT
Write findings to ${worktree_dir}/plan-review-findings.md using this format:
If no findings:
\`\`\`markdown
## Review Result: PASS
No P1 or P2 findings. The plan's state transitions, side effects, and retry paths are correct and complete.
\`\`\`
If findings exist:
\`\`\`markdown
## Review Result: FINDINGS
### P1: [short title]
**Plan text:** > [exact quote from plan]
**What actually happens:** [explanation]
**Why this is wrong:** [reasoning]
### P2: [short title]
**Plan text:** > [exact quote from plan]
**What is incomplete:** [explanation]
\`\`\`
If findings exist but P1s are unresolvable within the current milestone scope:
\`\`\`markdown
## Review Result: PROCEED_WITH_CONCERNS
**Reasoning:** [why the P1 is unresolvable within this milestone's scope — e.g., depends on a future story, requires infrastructure not in scope]

### P1s carried forward
- [P1 title]: [one-line summary]
\`\`\`
Use PROCEED_WITH_CONCERNS only when a P1 is a genuine correctness issue that cannot be resolved within the current plan's scope boundary. Do NOT use it for resolvable P1s or to avoid engaging with difficult findings.
## MANDATORY OUTPUT FILE
Write findings to: ${worktree_dir}/plan-review-findings.md
## STOP RULE
Stop after writing plan-review-findings.md. Do NOT modify any other file.
CRITICAL: Do NOT switch branches (no git checkout, git switch, git stash branch). All work must stay on branch ${branch}."

if [[ -n "$prev_findings_path" && -f "$prev_findings_path" ]]; then
  REVIEWER_PROMPT+="

## PREVIOUS FINDINGS
Previous findings file: ${prev_findings_path}
This is a RE-review pass. You have previously reviewed this plan and produced findings.
## YOUR TASK
1. Read the previous findings file first.
2. For each prior finding, verify whether the plan fixer has resolved it:
   - If resolved: note it as **RESOLVED** and move on.
   - If not resolved: carry it forward as a finding in your new report.
3. After verifying prior findings, scan the CHANGED sections of plan.md for new
   design-level bugs introduced by the fixes.
4. Do NOT flag new issues in unchanged sections of the plan unless they are
   severe correctness problems (P1-level) that you genuinely missed before.
5. Do NOT re-litigate findings you previously accepted.
   - Findings resolved via the plan fixer are RESOLVED.
   - Findings accepted as P2_ACKNOWLEDGED or PROCEED_WITH_CONCERNS are accepted and should not be re-flagged."
fi

  local _reviewer_prompt_file
  _reviewer_prompt_file=$(mktemp)
  printf '%s' "$REVIEWER_PROMPT" > "$_reviewer_prompt_file"
  local _main_state_before
  _main_state_before=$(_capture_main_state)
  ! NODE_OPTIONS='--conditions=development' node --import "$tsx_loader" "${repo_root}/apps/cli/src/run-agent.ts" \
    --phase plan-review \
    --phase-id "plan-review-${iteration}" \
    --cwd "$worktree_dir" \
    --run-id "$run_id" \
    --repo-id "$repo_id" \
    --repo-root "$repo_root" \
    --prompt-file "$_reviewer_prompt_file" \
    --timeout-minutes $(( (timeout_sec + 59) / 60 )) \
    --start-sha "$(git -C "$worktree_dir" rev-parse HEAD 2>/dev/null || printf '0%.0s' {1..40})" \
    --expected-artifacts plan-review-findings.md \
    2>&1 | tee -a "${issues_dir}/plan-review.log"; _agent_ec=${PIPESTATUS[0]} _tee_ec=${PIPESTATUS[1]}
  rm -f "$_reviewer_prompt_file"
  if [[ ${_tee_ec:-0} -ne 0 ]]; then
    warn "tee failed writing log for plan-review (exit $_tee_ec)"
  fi
  _guard_main_checkout "plan-review-${iteration}" "$_main_state_before"
  check_branch_after_agent
  return ${_agent_ec:-0}
}

# run_plan_fixer: Invoke the plan-writer agent to address findings and update plan.md.
# Args:
#   $1 — worktree dir
#   $2 — repo root
#   $3 — run ID
#   $4 — repo ID
#   $5 — branch name
#   $6 — timeout seconds
#   $7 — iteration number
run_plan_fixer() {
  local worktree_dir="$1"
  local repo_root="$2"
  local run_id="$3"
  local repo_id="$4"
  local branch="$5"
  local timeout_sec="$6"
  local iteration="$7"

  local issues_dir="$worktree_dir"
  local tsx_loader="${_TSX_LOADER:-tsx}"

  log "  Plan review: invoking plan-fixer to address findings (iteration ${iteration})..."

  local FIXER_PROMPT="You are a plan fixer. Your job is to address adversarial review findings in the implementation plan.
## CONTEXT
You are working in: ${worktree_dir}
Plan file: plan.md
Findings file: plan-review-findings.md
## YOUR TASK
1. Read plan-review-findings.md.
2. For each P1 finding: update plan.md to fix the incorrect or incomplete behavior. Quote what changed and why.
3. For each P2 finding: add a '## Known Limitations' section to plan.md (if not present) and acknowledge the limitation.
4. If the plan changes affect task boundaries (add, remove, or renumber tasks), also update task-manifest.json to stay in sync.
5. Do NOT change any other file.
## RULES
- Do NOT switch branches.
- Do NOT edit source files (*.ts, *.js, *.sh, *.py, etc.).
- Stop after updating plan.md and task-manifest.json (if task boundaries changed).
CRITICAL: Do NOT switch branches (no git checkout, git switch, git stash branch). All work must stay on branch ${branch}."

  local _fixer_prompt_file
  _fixer_prompt_file=$(mktemp)
  printf '%s' "$FIXER_PROMPT" > "$_fixer_prompt_file"
  local _main_state_before
  _main_state_before=$(_capture_main_state)
  ! NODE_OPTIONS='--conditions=development' node --import "$tsx_loader" "${repo_root}/apps/cli/src/run-agent.ts" \
    --phase plan-fix \
    --phase-id "plan-fix-${iteration}" \
    --cwd "$worktree_dir" \
    --run-id "$run_id" \
    --repo-id "$repo_id" \
    --repo-root "$repo_root" \
    --prompt-file "$_fixer_prompt_file" \
    --timeout-minutes $(( (timeout_sec + 59) / 60 )) \
    --start-sha "$(git -C "$worktree_dir" rev-parse HEAD 2>/dev/null || printf '0%.0s' {1..40})" \
    2>&1 | tee -a "${issues_dir}/plan-fix.log"; _agent_ec=${PIPESTATUS[0]} _tee_ec=${PIPESTATUS[1]}
  rm -f "$_fixer_prompt_file"
  if [[ ${_tee_ec:-0} -ne 0 ]]; then
    warn "tee failed writing log for plan-fix (exit $_tee_ec)"
  fi
  _guard_main_checkout "plan-fix-${iteration}" "$_main_state_before"
  check_branch_after_agent
  return ${_agent_ec:-0}
}

# run_plan_review_loop: Orchestrates the review→fix→re-review loop.
# Args:
#   $1 — worktree dir
#   $2 — repo root
#   $3 — run ID
#   $4 — repo ID
#   $5 — branch name
#   $6 — timeout seconds
#   $7 — max iterations
# Returns 0 if plan passes, 1 if max iterations reached without convergence.
run_plan_review_loop() {
  local worktree_dir="$1"
  local repo_root="$2"
  local run_id="$3"
  local repo_id="$4"
  local branch="$5"
  local timeout_sec="$6"
  local max_iter="$7"

  local iteration=0
  local status=""

  while [[ $iteration -lt $max_iter ]]; do
    iteration=$((iteration + 1))
    emit_event "plan-review" "info" "plan_review.review_started" \
      "Review loop iteration ${iteration}" iteration="$iteration"

    local _pre_review_sha
    _pre_review_sha=$(git -C "$worktree_dir" rev-parse HEAD 2>/dev/null || echo "")
    local _plan_checksum_before
    _plan_checksum_before=$(_checksum_file "${worktree_dir}/plan.md")
    local _manifest_checksum_before
    _manifest_checksum_before=$(_checksum_file "${worktree_dir}/task-manifest.json")
    rm -f "${worktree_dir}/plan-review-findings.md"
    local _prev_findings=""
    if [[ $iteration -gt 1 ]]; then
      local _prev_iter=$((iteration - 1))
      if [[ -f "${worktree_dir}/plan-review-findings-iter-${_prev_iter}.md" ]]; then
        _prev_findings="${worktree_dir}/plan-review-findings-iter-${_prev_iter}.md"
      fi
    fi
    run_adversarial_reviewer "$worktree_dir" "$repo_root" "$run_id" "$repo_id" "$branch" "$timeout_sec" "$iteration" "$_prev_findings"
    local reviewer_ec=$?
    if [[ $reviewer_ec -ne 0 ]]; then
      warn "Adversarial reviewer agent failed (exit ${reviewer_ec}) on iteration ${iteration}"
      emit_event "plan-review" "error" "plan_review.reviewer_failed" \
        "Reviewer agent failed on iteration ${iteration}" iteration="$iteration" exit_code="$reviewer_ec"
      orchestrator_fail "Adversarial reviewer agent failed (exit ${reviewer_ec}) on iteration ${iteration} — agent invocation error, not plan non-convergence"
    fi
    _check_review_worktree_violations "$worktree_dir" "$_pre_review_sha" '^plan-review-findings\.md$'
    _check_excluded_file_integrity "${worktree_dir}/plan.md" "$_plan_checksum_before" "plan.md"
    _check_excluded_file_integrity "${worktree_dir}/task-manifest.json" "$_manifest_checksum_before" "task-manifest.json"

    if [[ ! -f "${worktree_dir}/plan-review-findings.md" ]]; then
      warn "Reviewer agent completed successfully but plan-review-findings.md is missing"
      emit_event "plan-review" "error" "plan_review.findings_file_missing" \
        "Reviewer agent did not produce plan-review-findings.md on iteration ${iteration}" iteration="$iteration"
      orchestrator_fail "Reviewer agent completed but plan-review-findings.md not found — agent contract violation"
    fi

    # Archive findings before deletion at end of iteration
    if [[ -f "${worktree_dir}/plan-review-findings.md" ]]; then
      cp "${worktree_dir}/plan-review-findings.md" "${worktree_dir}/plan-review-findings-iter-${iteration}.md"
    fi

    status=$(parse_review_findings "$worktree_dir")
    local p1_count=0 p2_count=0
    if [[ -f "${worktree_dir}/plan-review-findings.md" ]]; then
      p1_count=$(grep -ciE '(#{2,3}[[:space:]]+P1:|[[:space:]]\*\*P1\*\*|severity:[[:space:]]*P1($|[[:space:]]))' "${worktree_dir}/plan-review-findings.md" 2>/dev/null || echo 0)
      p2_count=$(grep -ciE '(#{2,3}[[:space:]]+P2:|[[:space:]]\*\*P2\*\*|severity:[[:space:]]*P2($|[[:space:]]))' "${worktree_dir}/plan-review-findings.md" 2>/dev/null || echo 0)
    fi

    emit_event "plan-review" "info" "plan_review.findings" \
      "Iteration ${iteration}: ${p1_count} P1 findings, ${p2_count} P2 findings" \
      iteration="$iteration" p1="$p1_count" p2="$p2_count"

    if [[ "$status" == "PASS" ]]; then
      info "Plan passed adversarial review on iteration ${iteration}"
      emit_event "plan-review" "info" "plan_review.review_passed" \
        "Plan passed adversarial review" iterations="$iteration"
      return 0
    fi

    if [[ "$status" == "P2_ACKNOWLEDGED" ]]; then
      info "Plan passed with P2 acknowledgments on iteration ${iteration}"
      emit_event "plan-review" "info" "plan_review.review_passed" \
        "Plan passed with P2 acknowledgments" iterations="$iteration" p2="$p2_count"
      return 0
    fi

    if [[ "$status" == "PROCEED_WITH_CONCERNS" ]]; then
      info "Plan review: reviewer proceeds with concerns on iteration ${iteration}"
      emit_event "plan-review" "info" "plan_review.proceed_with_concerns" \
        "Reviewer invoked PROCEED_WITH_CONCERNS" iteration="$iteration"
      local _carried_p1s
      _carried_p1s=$(awk '/^### P1s carried forward/{flag=1;next} /^#{1,3}[^#]/{flag=0} flag && /^- /{print}' "${worktree_dir}/plan-review-findings.md" 2>/dev/null || true)
      if [[ -n "$_carried_p1s" ]]; then
        local _p1_lines
        mapfile -t _p1_lines <<< "$_carried_p1s"
        _append_known_limitations "${worktree_dir}/plan.md" "${_p1_lines[@]}"
      fi
      return 0
    fi

    if [[ "$status" == "P1_FOUND" ]]; then
      local _pre_fixer_sha
      _pre_fixer_sha=$(git -C "$worktree_dir" rev-parse HEAD 2>/dev/null || echo "")
      run_plan_fixer "$worktree_dir" "$repo_root" "$run_id" "$repo_id" "$branch" "$timeout_sec" "$iteration"
      local fixer_ec=$?
      if [[ $fixer_ec -ne 0 ]]; then
        warn "Plan fixer agent failed (exit ${fixer_ec}) on iteration ${iteration}"
        emit_event "plan-review" "error" "plan_review.fixer_failed" \
          "Plan fixer failed on iteration ${iteration}" iteration="$iteration" exit_code="$fixer_ec"
        orchestrator_fail "Plan fixer agent failed (exit ${fixer_ec}) on iteration ${iteration} — agent invocation error, not plan non-convergence"
      fi
      _check_review_worktree_violations "$worktree_dir" "$_pre_fixer_sha"
      continue
    fi
  done

  # If we exited the loop after running the fixer on the last iteration,
  # the fixer output was never reviewed. Run one final review pass to
  # evaluate whether the fix resolved the P1 findings.
  if [[ "$status" == "P1_FOUND" ]]; then
    local _final_iter=$((iteration + 1))
    emit_event "plan-review" "info" "plan_review.final_review" \
      "Running final review after last fixer pass" iteration="$_final_iter"

    local _pre_review_sha
    _pre_review_sha=$(git -C "$worktree_dir" rev-parse HEAD 2>/dev/null || echo "")
    local _plan_checksum_before
    _plan_checksum_before=$(_checksum_file "${worktree_dir}/plan.md")
    local _manifest_checksum_before
    _manifest_checksum_before=$(_checksum_file "${worktree_dir}/task-manifest.json")
    rm -f "${worktree_dir}/plan-review-findings.md"
    local _prev_findings=""
    if [[ -f "${worktree_dir}/plan-review-findings-iter-${iteration}.md" ]]; then
      _prev_findings="${worktree_dir}/plan-review-findings-iter-${iteration}.md"
    fi
    run_adversarial_reviewer "$worktree_dir" "$repo_root" "$run_id" "$repo_id" "$branch" "$timeout_sec" "$_final_iter" "$_prev_findings"
    local reviewer_ec=$?
    if [[ $reviewer_ec -ne 0 ]]; then
      warn "Adversarial reviewer agent failed (exit ${reviewer_ec}) on final review pass"
      emit_event "plan-review" "error" "plan_review.reviewer_failed" \
        "Reviewer agent failed on final review pass" iteration="$_final_iter" exit_code="$reviewer_ec"
      orchestrator_fail "Adversarial reviewer agent failed (exit ${reviewer_ec}) on final review pass — agent invocation error, not plan non-convergence"
    fi
    _check_review_worktree_violations "$worktree_dir" "$_pre_review_sha" '^plan-review-findings\.md$'
    _check_excluded_file_integrity "${worktree_dir}/plan.md" "$_plan_checksum_before" "plan.md"
    _check_excluded_file_integrity "${worktree_dir}/task-manifest.json" "$_manifest_checksum_before" "task-manifest.json"

    if [[ ! -f "${worktree_dir}/plan-review-findings.md" ]]; then
      warn "Reviewer agent completed successfully but plan-review-findings.md is missing on final review pass"
      emit_event "plan-review" "error" "plan_review.findings_file_missing" \
        "Reviewer agent did not produce plan-review-findings.md on final review pass" iteration="$_final_iter"
      orchestrator_fail "Reviewer agent completed but plan-review-findings.md not found on final review pass — agent contract violation"
    fi

    # Archive final review findings before deletion
    if [[ -f "${worktree_dir}/plan-review-findings.md" ]]; then
      cp "${worktree_dir}/plan-review-findings.md" "${worktree_dir}/plan-review-findings-iter-${_final_iter}.md"
    fi

    status=$(parse_review_findings "$worktree_dir")
    if [[ "$status" == "PASS" || "$status" == "P2_ACKNOWLEDGED" ]]; then
      info "Plan passed adversarial review on final pass (iteration ${_final_iter})"
      emit_event "plan-review" "info" "plan_review.review_passed" \
        "Plan passed adversarial review on final pass" iterations="$_final_iter"
      return 0
    fi

    if [[ "$status" == "PROCEED_WITH_CONCERNS" ]]; then
      info "Plan review: reviewer proceeds with concerns on final pass (iteration ${_final_iter})"
      emit_event "plan-review" "info" "plan_review.proceed_with_concerns" \
        "Reviewer invoked PROCEED_WITH_CONCERNS on final pass" iteration="$_final_iter"
      _carried_p1s=$(awk '/^### P1s carried forward/{flag=1;next} /^#{1,3}[^#]/{flag=0} flag && /^- /{print}' "${worktree_dir}/plan-review-findings.md" 2>/dev/null || true)
      if [[ -n "$_carried_p1s" ]]; then
        local _p1_lines
        mapfile -t _p1_lines <<< "$_carried_p1s"
        _append_known_limitations "${worktree_dir}/plan.md" "${_p1_lines[@]}"
      fi
      return 0
    fi
  fi

  emit_event "plan-review" "warn" "plan_review.max_iterations_reached" \
    "Plan review loop reached max iterations (${max_iter})" max_iterations="$max_iter"
  return 1
}

# escalate_plan_review: Post structured GitHub comment, apply label, exit.
# Args:
#   $1 — worktree dir
#   $2 — issue number
#   $3 — max iterations
escalate_plan_review() {
  local worktree_dir="$1"
  local issue_num="$2"
  local max_iter="$3"

  local findings_content=""
  [[ -f "${worktree_dir}/plan-review-findings.md" ]] && findings_content=$(cat "${worktree_dir}/plan-review-findings.md")

  local comment_body="## Plan Review: Escalation (max iterations reached)

**Plan:** plan.md
**Review passes:** ${max_iter}
**Remaining findings:** see below

${findings_content}

### Reason for non-convergence
The adversarial review loop reached the maximum of ${max_iter} iterations without resolving all P1 findings. Manual review is required."

  gh issue comment "$issue_num" --body "$comment_body" || warn "Failed to post escalation comment on issue #${issue_num}"
  gh issue edit "$issue_num" --add-label "ai:needs-human-review" || warn "Failed to add ai:needs-human-review label to issue #${issue_num}"

  emit_event "plan-review" "error" "plan_review.escalation" \
    "Escalated to human: max iterations reached" issue="$issue_num" max_iterations="$max_iter"

  orchestrator_fail "Plan review did not converge after ${max_iter} iterations. Escalated to issue #${issue_num}."
}

# run_plan_review_judge: Invoke the judgment agent to evaluate non-convergent reviews.
# Args:
#   $1 — worktree dir
#   $2 — repo root
#   $3 — run ID
#   $4 — repo ID
#   $5 — branch name
#   $6 — timeout seconds
#   $7 — (optional) judgment agent profile override
run_plan_review_judge() {
  local worktree_dir="$1"
  local repo_root="$2"
  local run_id="$3"
  local repo_id="$4"
  local branch="$5"
  local timeout_sec="$6"
  local judge_profile="${7:-}"

  local issues_dir="$worktree_dir"
  local tsx_loader="${_TSX_LOADER:-tsx}"

  # Resolve profile: use explicit override, or fall back to plan-review phase profile
  if [[ -z "$judge_profile" ]]; then
    local _config="${_ORCHESTRATOR_CONFIG:-}"
    if [[ -n "$_config" && -f "$_config" ]]; then
      judge_profile=$(jq -r '.agent.phaseProfiles["plan-review"].profile // empty' "$_config" 2>/dev/null || true)
    fi
  fi

  log "  Plan review: invoking judgment agent..."

  local _iteration_files=""
  for f in "${worktree_dir}"/plan-review-findings-iter-*.md; do
    if [[ -f "$f" ]]; then
      _iteration_files="${_iteration_files}
- $(basename "$f")"
    fi
  done

  local JUDGE_PROMPT="You are a plan-review judge. Your job is to evaluate whether unresolved findings across multiple review iterations warrant blocking the plan.
## CONTEXT
You are working in: ${worktree_dir}
Plan file: plan.md
## ITERATION FINDINGS
The following files contain findings from each review iteration:${_iteration_files}
Read each file and plan.md.
## YOUR TASK
1. Read all iteration findings files listed above.
2. Read plan.md.
3. Determine whether the unresolved findings represent a fundamental design flaw or are scoped/bounded issues that are safe to proceed with.
4. Write your judgment to ${worktree_dir}/plan-review-judgment.md.
## OUTPUT FORMAT
Write your judgment to ${worktree_dir}/plan-review-judgment.md using one of:
If findings were minor, contradictory, or diminishing:
\`\`\`markdown
## Judgment: PROCEED
**Reasoning:** [1-2 sentences]
\`\`\`
If genuine P1s remain but are scoped/bounded enough to proceed:
\`\`\`markdown
## Judgment: PROCEED_WITH_CAVEATS
**Reasoning:** [1-2 sentences]

### Unresolved P1s carried forward
- [P1 title]: [one-line summary]
\`\`\`
If findings represent a fundamental design flaw:
\`\`\`markdown
## Judgment: ESCALATE
**Reasoning:** [1-2 sentences]
\`\`\`
## MANDATORY OUTPUT FILE
Write judgment to: ${worktree_dir}/plan-review-judgment.md
## STOP RULE
Stop after writing plan-review-judgment.md. Do NOT modify any other file.
CRITICAL: Do NOT switch branches (no git checkout, git switch, git stash branch). All work must stay on branch ${branch}."

  local _judge_prompt_file
  _judge_prompt_file=$(mktemp)
  printf '%s' "$JUDGE_PROMPT" > "$_judge_prompt_file"
  local _plan_checksum_before
  _plan_checksum_before=$(_checksum_file "${worktree_dir}/plan.md")
  local _main_state_before
  _main_state_before=$(_capture_main_state)
  ! NODE_OPTIONS='--conditions=development' node --import "$tsx_loader" "${repo_root}/apps/cli/src/run-agent.ts" \
    --phase plan-judge \
    --phase-id "plan-judge-1" \
    ${judge_profile:+--profile "$judge_profile"} \
    --cwd "$worktree_dir" \
    --run-id "$run_id" \
    --repo-id "$repo_id" \
    --repo-root "$repo_root" \
    --prompt-file "$_judge_prompt_file" \
    --timeout-minutes $(( (timeout_sec + 59) / 60 )) \
    --start-sha "$(git -C "$worktree_dir" rev-parse HEAD 2>/dev/null || printf '0%.0s' {1..40})" \
    2>&1 | tee -a "${issues_dir}/plan-judge.log"; _agent_ec=${PIPESTATUS[0]} _tee_ec=${PIPESTATUS[1]}
  rm -f "$_judge_prompt_file"
  if [[ ${_tee_ec:-0} -ne 0 ]]; then
    warn "tee failed writing log for plan-judge (exit $_tee_ec)"
  fi
  _guard_main_checkout "plan-judge-1" "$_main_state_before"
  _check_excluded_file_integrity "${worktree_dir}/plan.md" "$_plan_checksum_before" "plan.md"
  check_branch_after_agent
  return ${_agent_ec:-0}
}
