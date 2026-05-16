# ai-run-issue-v2: collapse review.md + swap to ce:review skill

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the duplicate `review.md` artifact and replace the hand-rolled inline review prompt with an invocation of the `compound-engineering:ce-review` skill in `mode:report-only`.

**Architecture:**

1. Drop the in-place `cp code-review.md review.md` duplication; use `code-review.md` as the single canonical filename everywhere (it already survives worktree teardown via the archive step at the end of the script, since `ISSUES_DIR == WORKTREE_DIR`).
2. Replace the inline `REVIEW_PROMPT` (lines 1247–1281) with a wrapper that has the agent read `issue.md` + `design.md` for intent context, invoke `compound-engineering:ce-review` with `mode:report-only base:origin/${BASE_BRANCH} plan:./plan.md`, then write the structured envelope to `./code-review.md`.
3. Update the severity grep in the PR-summary section (lines 1575–1582) to match ce:review's `P0`/`P1`/`P2`/`P3` scale.
4. Update the `RE_REVIEW_PROMPT` (fix-review loop, lines 1388–1417) to reference `code-review.md` directly and remain compatible with the P0-P3 envelope format.

**Tech Stack:** bash, grep, ce:review skill (markdown spec at `~/.claude/plugins/cache/compound-engineering-plugin/compound-engineering/2.63.1/skills/ce-review/`).

---

### Task 1: Collapse `review.md` into `code-review.md` (mechanical refactor)

This task removes the in-place duplication. It is independent of the ce:review swap and lower risk, so we do it first.

**Files:**

- Modify: `scripts/ai-run-issue-v2` (single file, multiple line ranges below)

- [ ] **Step 1: Baseline grep — capture every current reference to `review.md`**

Run: `grep -n 'review\.md' scripts/ai-run-issue-v2`
Expected output (record this — we will compare against post-change state):

```
415:  elif [[ -f "${ISSUES_DIR}/review.md" ]]; then
523:review.md
1287:    cp "${WORKTREE_DIR}/code-review.md" "${ISSUES_DIR}/review.md"
1288:    info "Review saved to ${ISSUES_DIR}/review.md"
1292:      cp "$REVIEW_FILE" "${ISSUES_DIR}/review.md"
1317:  if [[ ! -f "${ISSUES_DIR}/review.md" ]]; then
1318:    info "No review.md found. Skipping fix loop."
1328:Review findings: ./review.md
1348:- code-review.md, review.md, validation.md
1393:Original review: ./review.md
1423:    cp "${WORKTREE_DIR}/code-review.md" "${ISSUES_DIR}/review.md"
1429:    "${ISSUES_DIR}/review.md" \
1579:  elif [[ -f "${ISSUES_DIR}/review.md" ]]; then
1580:    crit_high=$(grep -ciE 'severity.*(critical|high)' "${ISSUES_DIR}/review.md" 2>/dev/null || echo 0)
1581:    medi_low=$(grep -ciE 'severity.*(medium|low)' "${ISSUES_DIR}/review.md" 2>/dev/null || echo 0)
1674:    review.md review-fix-log.md code-review.md \
```

- [ ] **Step 2: Resume-detection — point at code-review.md (line 415)**

Edit line 415 from:

```bash
  elif [[ -f "${ISSUES_DIR}/review.md" ]]; then
```

to:

```bash
  elif [[ -f "${ISSUES_DIR}/code-review.md" ]]; then
```

- [ ] **Step 3: info/exclude list — remove the now-orphan entry (line 523)**

In the heredoc starting at line 519, remove the standalone `review.md` line. `code-review.md` (line 522) stays. After edit, the relevant block should read:

```
*.log
*.result
code-review.md
design.md
plan.md
```

- [ ] **Step 4: Review-phase copy step — delete the duplicate `cp` (lines 1286–1294)**

The review agent already writes `${WORKTREE_DIR}/code-review.md`, and `WORKTREE_DIR == ISSUES_DIR`, so the entire copy-and-fallback block is a no-op. Replace the whole block:

```bash
  # Copy review from worktree
  if [[ -f "${WORKTREE_DIR}/code-review.md" ]]; then
    cp "${WORKTREE_DIR}/code-review.md" "${ISSUES_DIR}/review.md"
    info "Review saved to ${ISSUES_DIR}/review.md"
  else
    REVIEW_FILE=$(find "${WORKTREE_DIR}" -name "code-review.md" 2>/dev/null | head -1)
    if [[ -n "$REVIEW_FILE" && -f "$REVIEW_FILE" ]]; then
      cp "$REVIEW_FILE" "${ISSUES_DIR}/review.md"
    fi
  fi
```

With:

```bash
  if [[ -f "${ISSUES_DIR}/code-review.md" ]]; then
    info "Review saved to ${ISSUES_DIR}/code-review.md"
  else
    info "WARN: review agent did not produce code-review.md"
  fi
```

- [ ] **Step 5: Fix-review loop entry guard (lines 1317–1318)**

Edit lines 1317–1318 from:

```bash
  if [[ ! -f "${ISSUES_DIR}/review.md" ]]; then
    info "No review.md found. Skipping fix loop."
```

to:

```bash
  if [[ ! -f "${ISSUES_DIR}/code-review.md" ]]; then
    info "No code-review.md found. Skipping fix loop."
```

- [ ] **Step 6: Fix prompt — point fixer at code-review.md (line 1328)**

Edit line 1328 from:

```
Review findings: ./review.md
```

to:

```
Review findings: ./code-review.md
```

- [ ] **Step 7: Orchestrator artifacts list (line 1348)**

Edit line 1348 from:

```
- code-review.md, review.md, validation.md
```

to:

```
- code-review.md, validation.md
```

- [ ] **Step 8: Re-review prompt — point re-reviewer at code-review.md (line 1393)**

Edit line 1393 from:

```
Original review: ./review.md
```

to:

```
Original review: ./code-review.md
```

Note: the re-review agent is already instructed to _write_ its updated review to `./code-review.md` (line 1402), overwriting it in place. That stays.

- [ ] **Step 9: Re-review copy-back — delete the duplicate `cp` (lines 1422–1424)**

Replace:

```bash
  # Copy updated review
  if [[ -f "${WORKTREE_DIR}/code-review.md" ]]; then
    cp "${WORKTREE_DIR}/code-review.md" "${ISSUES_DIR}/review.md"
  fi
```

With:

```bash
  # Re-review agent overwrites ${WORKTREE_DIR}/code-review.md in place; no copy needed.
  :
```

- [ ] **Step 10: `resolve_result` extractor argument (line 1429)**

The `resolve_result` call passes the review file as a fallback source for status extraction. Edit line 1429 from:

```bash
    "${ISSUES_DIR}/review.md" \
```

to:

```bash
    "${ISSUES_DIR}/code-review.md" \
```

- [ ] **Step 11: PR summary severity grep fallback (lines 1579–1582)**

The block currently has a primary path on `code-review.md` (lines 1575–1578) and a fallback on `review.md` (lines 1579–1582). After this task the two files are the same, so collapse to one path. Delete lines 1579–1582 entirely (the `elif` block). The remaining structure should be:

```bash
  PR_REVIEW=""
  if [[ -f "${ISSUES_DIR}/code-review.md" ]]; then
    crit_high=$(grep -ciE 'severity.*(critical|high)' "${ISSUES_DIR}/code-review.md" 2>/dev/null || echo 0)
    medi_low=$(grep -ciE 'severity.*(medium|low)' "${ISSUES_DIR}/code-review.md" 2>/dev/null || echo 0)
    PR_REVIEW="- Critical/High: ${crit_high}"$'\n'"- Medium/Low: ${medi_low}"
  else
    PR_REVIEW="No code review performed"
  fi
```

(Note: the `critical|high|medium|low` regex stays for now — Task 4 updates it to P0-P3.)

- [ ] **Step 12: Archive list (line 1674)**

Edit line 1674 from:

```
    review.md review-fix-log.md code-review.md \
```

to:

```
    review-fix-log.md code-review.md \
```

- [ ] **Step 13: Verify — re-grep, confirm zero `review.md` references**

Run: `grep -n 'review\.md' scripts/ai-run-issue-v2`
Expected: **no matches** (exit code 1). If any match remains, return to the corresponding step above.

Run: `grep -n 'code-review\.md' scripts/ai-run-issue-v2`
Expected: multiple matches (this is the canonical filename now). Spot-check that no path mentions `${ISSUES_DIR}/review.md` or `${WORKTREE_DIR}/review.md`.

- [ ] **Step 14: Shellcheck the script**

Run: `shellcheck scripts/ai-run-issue-v2 2>&1 | head -40`
Expected: no new errors versus the pre-change baseline. If shellcheck flags the empty `:` no-op from Step 9, that's acceptable — it's an intentional placeholder; you may instead delete the surrounding `# Re-review agent overwrites…` comment block entirely.

- [ ] **Step 15: Commit**

```bash
git add scripts/ai-run-issue-v2
git commit -m "refactor(ai-run-issue-v2): collapse review.md into code-review.md

The script was writing both code-review.md and review.md to the same directory
(ISSUES_DIR == WORKTREE_DIR). The duplication served no purpose: the final
archive step already copies code-review.md, and the worktree never moves out
from under it. Standardize on code-review.md as the single canonical filename."
```

---

### Task 2: Replace inline review prompt with ce:review skill invocation

**Files:**

- Modify: `scripts/ai-run-issue-v2:1241-1297` (the `PHASE == "review"` block)

- [ ] **Step 1: Read the existing review block to confirm the current shape**

Run: `sed -n '1238,1297p' scripts/ai-run-issue-v2`
Expected: the `# PHASE: review` block. Confirm `REVIEW_PROMPT="You are reviewing code changes...."` is intact and that Task 1's Step 4 edit has already simplified the post-prompt copy logic.

- [ ] **Step 2: Replace the `REVIEW_PROMPT` body**

Replace the entire `REVIEW_PROMPT="..."` heredoc-string (lines 1247–1281 in the original file) with the new wrapper. The new content delegates to the ce:review skill:

```bash
  REVIEW_PROMPT="You are running the code review phase for issue #${ISSUE_NUM}.

## CONTEXT
- Working directory: ${WORKTREE_DIR}
- Branch under review: ${BRANCH}
- Base branch: ${BASE_BRANCH}
- Intent sources (read these BEFORE invoking the review skill):
  - ./issue.md       — the GitHub issue this branch implements
  - ./design.md      — the design document for this change
  - ./plan.md        — the task-by-task implementation plan

## TASK
1. Read ./issue.md and ./design.md to ground yourself in what this branch is trying to accomplish. This intent context is what the review skill's persona subagents will inherit through your invocation.
2. Invoke the compound-engineering:ce-review skill with these arguments:
     mode:report-only base:origin/${BASE_BRANCH} plan:./plan.md
   - mode:report-only ensures the skill performs no mutations (no autofix, no commits, no branch switches).
   - base:origin/${BASE_BRANCH} pins the diff scope.
   - plan:./plan.md enables explicit requirements-completeness verification (R1, R2, etc.) and marks unaddressed requirements as blocking P1 findings rather than advisory.
3. The skill will return a structured text envelope ending with the line 'Review complete'. Capture that envelope verbatim and write it to ./code-review.md (overwriting any existing file). Do not summarize, paraphrase, or reformat.

## CRITICAL RULES
- Do NOT ask questions. The skill itself is configured to infer intent in report-only mode.
- Do NOT switch branches (no git checkout, git switch, git stash branch). All work must stay on branch ${BRANCH}.
- Do NOT edit project files. The skill is read-only in report-only mode; your only write is ./code-review.md.
- Stop after writing ./code-review.md.

Write ./code-review.md now."
```

- [ ] **Step 3: Verify the heredoc still terminates correctly**

Run: `sed -n '1238,1300p' scripts/ai-run-issue-v2`
Expected: the closing `"` after `Write ./code-review.md now.` is followed by a blank line and then `  echo "$REVIEW_PROMPT" | run_agent_raw "review" "$TIMEOUT_REVIEW"`. If the structure broke, re-edit.

- [ ] **Step 4: Shellcheck**

Run: `shellcheck scripts/ai-run-issue-v2 2>&1 | head -40`
Expected: no new errors. Any pre-existing warnings are out of scope.

- [ ] **Step 5: Commit**

```bash
git add scripts/ai-run-issue-v2
git commit -m "feat(ai-run-issue-v2): use ce:review skill for code review phase

Replace the hand-rolled inline review prompt with an invocation of the
compound-engineering:ce-review skill in mode:report-only. The skill provides
tiered persona review (correctness, testing, maintainability, security,
performance, etc.), confidence-gated dedup, and explicit requirements
verification via plan:./plan.md.

issue.md and design.md are read by the wrapper agent first so the intent
summary propagated to persona subagents is grounded in the actual issue
context, not just the diff and branch name."
```

---

### Task 3: Update severity regex for P0-P3 scale

The ce:review skill emits findings tagged `P0`/`P1`/`P2`/`P3`, not `critical`/`high`/`medium`/`low`. The PR-summary grep in the script still uses the old scale and will silently return zero counts after Task 2 ships.

**Files:**

- Modify: `scripts/ai-run-issue-v2:1575-1578` (PR summary grep block, post-Task 1 line numbers)

- [ ] **Step 1: Confirm current state**

Run: `grep -n 'crit_high\|medi_low' scripts/ai-run-issue-v2`
Expected: two assignments using `severity.*(critical|high)` and `severity.*(medium|low)`.

- [ ] **Step 2: Update the regex pair**

Edit the block to:

```bash
  PR_REVIEW=""
  if [[ -f "${ISSUES_DIR}/code-review.md" ]]; then
    crit_high=$(grep -cE '\[P[01]\]' "${ISSUES_DIR}/code-review.md" 2>/dev/null || echo 0)
    medi_low=$(grep -cE '\[P[23]\]' "${ISSUES_DIR}/code-review.md" 2>/dev/null || echo 0)
    PR_REVIEW="- P0/P1: ${crit_high}"$'\n'"- P2/P3: ${medi_low}"
  else
    PR_REVIEW="No code review performed"
  fi
```

Rationale for the regex: the ce:review headless/report-only envelope uses bracket-prefixed severity tags like `[P0][gated_auto -> downstream-resolver]`. Anchoring on `\[P0\]`, `\[P1\]`, etc., avoids matching prose mentions of "P0" inside a finding's description.

- [ ] **Step 3: Verify against a sample envelope**

Create a temp file representing the kind of output ce:review produces, then verify the counts:

```bash
cat > /tmp/sample-cr.md <<'EOF'
### P0 -- Critical

| # | File | Issue |
[P0][gated_auto -> downstream-resolver] File: src/auth.ts:42 -- Missing ownership check (security, confidence 0.92)

[P2][advisory -> human] File: src/util.ts:10 -- Naming nit (maintainability, confidence 0.65)
[P3][advisory -> human] File: README.md:1 -- Typo (project-standards, confidence 0.7)
EOF
grep -cE '\[P[01]\]' /tmp/sample-cr.md
grep -cE '\[P[23]\]' /tmp/sample-cr.md
rm /tmp/sample-cr.md
```

Expected: first grep outputs `1`, second outputs `2`.

- [ ] **Step 4: Commit**

```bash
git add scripts/ai-run-issue-v2
git commit -m "fix(ai-run-issue-v2): update PR summary severity grep for P0-P3

ce:review uses P0/P1/P2/P3 severity tags (bracket-prefixed in the headless
envelope), not critical/high/medium/low. The old regex would silently return
zero counts for every PR summary."
```

---

### Task 4: Update fix-review and re-review prompts for ce:review envelope

The fix prompt and re-review prompt currently assume a free-form review format with `severity: critical|high|medium|low` lines. ce:review's report-only envelope is structured differently (bracket tags, distinct sections by `autofix_class`, separate "Pre-existing" section). The fixer and re-reviewer need to know the new shape.

**Files:**

- Modify: `scripts/ai-run-issue-v2:1322-1359` (FIX_PROMPT)
- Modify: `scripts/ai-run-issue-v2:1388-1417` (RE_REVIEW_PROMPT)

- [ ] **Step 1: Update FIX_PROMPT to describe the envelope shape**

Find the existing `FIX_PROMPT="You are fixing code review findings...."` block. After the existing `## TASK` section (which says "Read the code review findings. Fix ALL legitimate review findings across all severities."), insert an envelope-shape primer immediately before the `Rules:` line:

```
## REVIEW FORMAT
The review in ./code-review.md was produced by the compound-engineering:ce-review skill.
Findings are tagged with bracketed severity (P0–P3) and autofix routing, for example:
  [P0][gated_auto -> downstream-resolver][needs-verification] File: src/foo.ts:42 -- <title>
    Why: <reason>
    Suggested fix: <fix>
    Evidence: <observation>

Sections you will see:
- 'Gated-auto findings' — concrete fix exists, apply it.
- 'Manual findings' — actionable, apply the suggested fix.
- 'Advisory findings' — report-only, do NOT change code for these; note them in review-fix-log.md and skip.
- 'Pre-existing issues' — NOT introduced by this branch; do NOT fix, note as 'pre-existing, out of scope' in review-fix-log.md.

Fix all P0–P3 findings in the Gated-auto and Manual sections.
Skip Advisory and Pre-existing sections entirely.
```

- [ ] **Step 2: Verify FIX_PROMPT integrity**

Run: `sed -n '1320,1365p' scripts/ai-run-issue-v2`
Expected: the heredoc-string opens with `You are fixing code review findings.` and closes cleanly with `Start now."` followed by `  echo "$FIX_PROMPT" | run_agent_raw ...`.

- [ ] **Step 3: Update RE_REVIEW_PROMPT to expect the same envelope**

In the `RE_REVIEW_PROMPT` block, find the line:

```
For each original finding, note whether it is: **fixed** | **partially fixed** | **not fixed** | **invalid**
```

Immediately before it, insert:

```
The original review (./code-review.md) was produced by compound-engineering:ce-review and uses bracketed P0–P3 severity tags grouped under Gated-auto, Manual, Advisory, and Pre-existing sections. When you write the updated review to ./code-review.md, preserve the same bracketed tag format so downstream tooling can parse it consistently.

Only re-evaluate findings from the Gated-auto and Manual sections. Advisory and Pre-existing items do not factor into ALL_RESOLVED vs HAS_UNRESOLVED.
```

- [ ] **Step 4: Verify RE_REVIEW_PROMPT integrity**

Run: `sed -n '1386,1425p' scripts/ai-run-issue-v2`
Expected: the heredoc-string is well-formed and closes with `Write code-review.md and review-findings-status.txt now."`.

- [ ] **Step 5: Shellcheck**

Run: `shellcheck scripts/ai-run-issue-v2 2>&1 | head -40`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add scripts/ai-run-issue-v2
git commit -m "feat(ai-run-issue-v2): teach fix-review loop the ce:review envelope

The fixer and re-reviewer prompts previously assumed a free-form review with
critical/high/medium/low severity prose. ce:review produces a structured
envelope with bracketed P0–P3 tags and explicit Gated-auto / Manual /
Advisory / Pre-existing sections. Prime both prompts on the new shape and
restrict the action queue to Gated-auto + Manual; Advisory is report-only
and Pre-existing is out of scope."
```

---

### Task 5: End-to-end smoke test against a real issue

The bash-level changes are mechanical, but the only true verification is running the full pipeline against a real GitHub issue and confirming:

- ce:review produces a `code-review.md` envelope with bracketed `[P0]`/`[P1]`/etc. tags.
- The PR summary block shows non-zero counts when findings exist (or zero counts when clean).
- The fix-review loop reads `code-review.md`, ignores Advisory + Pre-existing, and terminates.

**Files:**

- No code changes in this task. Manual run + post-run inspection.

- [ ] **Step 1: Pick a low-stakes test issue**

Either a real low-priority issue with `ai:run` label, or a synthetic one created for this purpose. Note the issue number (call it `${TEST_ISSUE}`).

- [ ] **Step 2: Dry-run on a worktree**

Run: `bash scripts/ai-run-issue-v2 ${TEST_ISSUE}`
Expected: completes through the `review` phase without error. The orchestrator log should show:

- A `=== Phase: review ===` banner.
- An agent invocation named `review` that takes notably longer than the old inline prompt (the skill spawns multiple persona subagents).
- A message `Review saved to ${ISSUES_DIR}/code-review.md` (per Task 1, Step 4).

If the agent fails to invoke the skill or writes garbage to `code-review.md`, return to Task 2 and revise the wrapper prompt before continuing.

- [ ] **Step 3: Inspect the produced code-review.md**

Run: `head -60 ai/issues/${TEST_ISSUE}/code-review.md`
Expected: a structured envelope that starts with `Code review complete (headless mode).` or the report-only equivalent, and contains at least one bracket-tagged finding line like `[P2][advisory -> human] File: ...`. The final line should be `Review complete`.

If the format is freeform markdown (severity prose), the skill did not actually run — likely the agent ignored the `Skill` invocation. Return to Task 2.

- [ ] **Step 4: Confirm severity counts in the PR body**

Run: `grep -E '^- P[0-3]/P[0-3]:' ai/issues/${TEST_ISSUE}/pr-summary.md`
Expected: two lines, `- P0/P1: <count>` and `- P2/P3: <count>`.

- [ ] **Step 5: Confirm fix loop terminated correctly**

Run: `grep -c 'Phase: fix-review' ai/issues/${TEST_ISSUE}/orchestrator.log`
Expected: between 1 and 10 (the loop cap). If it hit 10, the re-reviewer is likely not recognizing the updated envelope as resolved — revisit Task 4, Step 3.

- [ ] **Step 6: Confirm no `review.md` was produced**

Run: `find ai/issues/${TEST_ISSUE} -name 'review.md'`
Expected: no output. If `review.md` exists, Task 1 missed a `cp` somewhere.

- [ ] **Step 7: Final commit (only if the smoke test surfaced any tweaks)**

If any prompt adjustments were needed during the smoke test, commit them with:

```bash
git add scripts/ai-run-issue-v2
git commit -m "fix(ai-run-issue-v2): post-smoke-test adjustments to ce:review wrapper"
```

Otherwise this task ends with no commit — the smoke test itself is the deliverable.

---

## Self-review notes

- **Spec coverage:** the four agreed-on changes (delete review.md duplication, swap to ce:review, update severity regex, update fix-review prompts) map to Tasks 1–4 respectively. Task 5 is the end-to-end validation we cannot perform statically.
- **Ordering rationale:** Task 1 is the lowest-risk mechanical refactor and lands first so a partial implementation still leaves the script working with the old inline prompt. Task 2 swaps the prompt. Tasks 3 and 4 fix the downstream consumers that depended on the old free-form format. Task 5 validates end-to-end.
- **Reversibility:** every task is one commit. If Task 2 fails the smoke test, `git revert` cleanly rolls back just that commit and the script returns to the hand-rolled review prompt with `code-review.md` as the only filename (Task 1 changes stay in place because they were correct in isolation).
- **Out of scope:** alternate ce:review modes (headless, autofix), parallelizing review with browser tests, and persona tuning. Those can be follow-up plans if report-only proves insufficient.
