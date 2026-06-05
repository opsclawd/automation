#!/usr/bin/env bash
# plan-review.sh — Adversarial plan review functions for the orchestrator.

# _check_review_worktree_violations: Verify that the review/fix agents did not
# modify files outside the allowed set (plan.md, plan-review-findings.md, and
# marker files). Calls orchestrator_fail on violation.
# Args:
#   $1 — worktree dir
_check_review_worktree_violations() {
  local worktree_dir="$1"
  local violations
  violations=$({
    git -C "$worktree_dir" diff --name-only HEAD 2>/dev/null
    git -C "$worktree_dir" ls-files --others --exclude-standard 2>/dev/null
  } | grep . | grep -vE '^(plan\.md|plan-review-findings\.md|plan-review-passed\.marker|\.gitignore)$' | tr '\n' ' ' || true)
  if [[ -n "$violations" ]]; then
    orchestrator_fail "Plan review/fix agent modified unexpected files (contract violation): ${violations}"
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
# Returns one of: PASS | P2_ACKNOWLEDGED | P1_FOUND
# Args:
#   $1 — path to the worktree directory containing plan-review-findings.md
parse_review_findings() {
  local worktree_dir="$1"
  local findings_file="${worktree_dir}/plan-review-findings.md"

  if [[ ! -f "$findings_file" ]]; then
    echo "PASS"
    return
  fi

  if grep -qiP '(#{2,3}\s+P1\b|\*\*P1\*\*|severity:\s*P1)' "$findings_file"; then
    echo "P1_FOUND"
    return
  fi

  if grep -qiP '(#{2,3}\s+P2\b|\*\*P2\*\*|severity:\s*P2)' "$findings_file"; then
    echo "P2_ACKNOWLEDGED"
    return
  fi

  echo "PASS"
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
run_adversarial_reviewer() {
  local worktree_dir="$1"
  local repo_root="$2"
  local run_id="$3"
  local repo_id="$4"
  local branch="$5"
  local timeout_sec="$6"
  local iteration="$7"

  local issues_dir="$worktree_dir"
  local tsx_loader="${_TSX_LOADER:-tsx}"

  log "  Plan review: invoking adversarial reviewer (iteration ${iteration})..."

  local plan_content=""
  [[ -f "${worktree_dir}/plan.md" ]] && plan_content=$(cat "${worktree_dir}/plan.md")

  REVIEWER_PROMPT="You are an adversarial plan reviewer. Your job is to find design-level errors in the implementation plan.
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
## MANDATORY OUTPUT FILE
Write findings to: ${worktree_dir}/plan-review-findings.md
## STOP RULE
Stop after writing plan-review-findings.md. Do NOT modify any other file.
CRITICAL: Do NOT switch branches (no git checkout, git switch, git stash branch). All work must stay on branch ${branch}."

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

  local findings_content=""
  [[ -f "${worktree_dir}/plan-review-findings.md" ]] && findings_content=$(cat "${worktree_dir}/plan-review-findings.md")

  FIXER_PROMPT="You are a plan fixer. Your job is to address adversarial review findings in the implementation plan.
## CONTEXT
You are working in: ${worktree_dir}
Plan file: plan.md
Findings file: plan-review-findings.md
## YOUR TASK
1. Read plan-review-findings.md.
2. For each P1 finding: update plan.md to fix the incorrect or incomplete behavior. Quote what changed and why.
3. For each P2 finding: add a '## Known Limitations' section to plan.md (if not present) and acknowledge the limitation.
4. Do NOT change any file other than plan.md.
## RULES
- Do NOT switch branches.
- Do NOT edit source files (*.ts, *.js, *.sh, *.py, etc.).
- Stop after updating plan.md.
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

    run_adversarial_reviewer "$worktree_dir" "$repo_root" "$run_id" "$repo_id" "$branch" "$timeout_sec" "$iteration"
    local reviewer_ec=$?
    if [[ $reviewer_ec -ne 0 ]]; then
      warn "Adversarial reviewer agent failed (exit ${reviewer_ec}) on iteration ${iteration}"
      emit_event "plan-review" "error" "plan_review.reviewer_failed" \
        "Reviewer agent failed on iteration ${iteration}" iteration="$iteration" exit_code="$reviewer_ec"
      orchestrator_fail "Adversarial reviewer agent failed (exit ${reviewer_ec}) on iteration ${iteration} — agent invocation error, not plan non-convergence"
    fi
    _check_review_worktree_violations "$worktree_dir"

    if [[ ! -f "${worktree_dir}/plan-review-findings.md" ]]; then
      warn "Reviewer agent completed successfully but plan-review-findings.md is missing"
      emit_event "plan-review" "error" "plan_review.findings_file_missing" \
        "Reviewer agent did not produce plan-review-findings.md on iteration ${iteration}" iteration="$iteration"
      orchestrator_fail "Reviewer agent completed but plan-review-findings.md not found — agent contract violation"
    fi

    status=$(parse_review_findings "$worktree_dir")
    local p1_count=0 p2_count=0
    if [[ -f "${worktree_dir}/plan-review-findings.md" ]]; then
      p1_count=$(grep -ciP '(#{2,3}\s+P1\b|\*\*P1\*\*|severity:\s*P1)' "${worktree_dir}/plan-review-findings.md" 2>/dev/null || echo 0)
      p2_count=$(grep -ciP '(#{2,3}\s+P2\b|\*\*P2\*\*|severity:\s*P2)' "${worktree_dir}/plan-review-findings.md" 2>/dev/null || echo 0)
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

    if [[ "$status" == "P1_FOUND" ]]; then
      run_plan_fixer "$worktree_dir" "$repo_root" "$run_id" "$repo_id" "$branch" "$timeout_sec" "$iteration"
      local fixer_ec=$?
      if [[ $fixer_ec -ne 0 ]]; then
        warn "Plan fixer agent failed (exit ${fixer_ec}) on iteration ${iteration}"
        emit_event "plan-review" "error" "plan_review.fixer_failed" \
          "Plan fixer failed on iteration ${iteration}" iteration="$iteration" exit_code="$fixer_ec"
        orchestrator_fail "Plan fixer agent failed (exit ${fixer_ec}) on iteration ${iteration} — agent invocation error, not plan non-convergence"
      fi
      _check_review_worktree_violations "$worktree_dir"
      continue
    fi
  done

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
