# M8-11: Retire / Quarantine Legacy Bash Scripts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Now that the TypeScript `RunExecutor` (M8-10) drives the happy path, quarantine the legacy Bash orchestration scripts under `scripts/legacy/` with deprecation banners, update all references, and document the cutover in ADR-0002 + README/quickstart. Preserve (don't delete) for emergency use.

**Architecture:** This is a migration/cleanup story, not feature code. The TDD here is mostly "move + update references + run the full suite green," plus a guard that the default documented workflow doesn't invoke legacy scripts.

**Tech Stack:** Bash, docs, CI config, `pnpm test` + `pnpm test:bash`.

---

## Critical context (read first)

- A `scripts/legacy/` and `scripts/legacy-poll` convention **already exists** — extend it.
- **Do not hard-delete** (PRD §28 Risk 1 — avoid destabilizing by removing too much). Quarantine with banners; preserve history.
- Quarantine **orchestration control flow**, not legitimate tool adapters. `scripts/lib/emit_event.sh`, `scripts/lib/run-bash-script` helpers, etc. may still back an adapter — keep what is still referenced.
- `scripts/ai-pr-review-poll` may already be a shim (M6-05). Check before moving.
- Many bats tests under `scripts/lib/__tests__/` reference the scripts; moving paths will break them. Update or retire those tests deliberately.
- **Sequencing:** this story depends on M8-10 being merged and the default workflow being TS. Confirm `apps/api` exposes the worker/executor path as the documented default before quarantining.

## File structure

- Move: `scripts/ai-run-issue-v2` → `scripts/legacy/ai-run-issue-v2`
- Possibly move: orphaned `scripts/lib/*` helpers → `scripts/legacy/lib/`
- Modify: `README.md`, `docs/quickstart.md`, `docs/adr/0002-*.md` (create if absent)
- Modify: CI workflow + `package.json` scripts referencing old paths
- Create: a guard test/CI check

---

### Task 1: Reference audit (no moves yet)

- [ ] **Step 1: Enumerate every caller of the legacy scripts:**

```bash
cd <repo>
grep -rn "ai-run-issue-v2\|ai-pr-review-poll" \
  apps packages scripts .github package.json docs README.md \
  | grep -v node_modules | grep -v '/legacy/' > /tmp/legacy-callers.txt
cat /tmp/legacy-callers.txt
```

- [ ] **Step 2: Classify** each caller: (A) production code path that must move to the TS workflow; (B) test (bats) to update or retire; (C) docs to update; (D) CI/package script to update. Record the list in the PR description.

- [ ] **Step 3:** Confirm `scripts/ai-pr-review-poll` current state (full loop vs shim). If M6-05 already reduced it, note that.

This task produces the move-plan; no commit needed (or commit the audit notes to the PR description).

---

### Task 2: Quarantine `ai-run-issue-v2` with a deprecation banner

**Files:**
- Move: `scripts/ai-run-issue-v2` → `scripts/legacy/ai-run-issue-v2`

- [ ] **Step 1: Move the script** preserving git history:

```bash
git mv scripts/ai-run-issue-v2 scripts/legacy/ai-run-issue-v2
```

- [ ] **Step 2: Add a deprecation banner** at the top (after the shebang):

```bash
echo '⚠️  DEPRECATED: legacy Bash orchestrator. The default workflow is the TypeScript' >&2
echo '    RunExecutor (apps/api worker). This script is retained for emergency use only.' >&2
echo '    See docs/adr/0002-*.md for the cutover.' >&2
```

- [ ] **Step 3: Update every production reference** found in Task 1 to point at the TS workflow (or remove). Update `package.json` scripts and CI to not invoke the moved path in the default flow.

- [ ] **Step 4: Update or retire the bats tests** that referenced the old path. For tests asserting legacy behavior that is now owned by TS, either repoint them at `scripts/legacy/...` (if still meaningful) or remove them with a note in the PR.

- [ ] **Step 5: Run both suites:**

```bash
pnpm test && pnpm test:bash
```
Expected: green (after reference/test updates).

- [ ] **Step 6: Commit** `git add -A && git commit -m "chore(scripts): quarantine ai-run-issue-v2 under scripts/legacy with deprecation banner"`

---

### Task 3: Prune genuinely-orphaned helpers

**Files:**
- Move: orphaned `scripts/lib/*` → `scripts/legacy/lib/` (only those with zero live callers)

- [ ] **Step 1: For each `scripts/lib/*` helper, check for live callers:**

```bash
for f in scripts/lib/*.sh; do
  base=$(basename "$f")
  echo "== $base =="
  grep -rn "$base" apps packages scripts | grep -v node_modules | grep -v "/legacy/" | grep -v "$f"
done
```

- [ ] **Step 2:** Keep `scripts/lib/emit_event.sh` (and any helper) **only if** a live adapter still sources it. Move the rest to `scripts/legacy/lib/`. Update bats test paths accordingly.

- [ ] **Step 3:** `pnpm test:bash` → green.

- [ ] **Step 4: Commit** `git add -A && git commit -m "chore(scripts): move orphaned helpers to legacy; keep adapter-backing helpers"`

---

### Task 4: Cutover docs + ADR + default-workflow guard

**Files:**
- Modify: `README.md`, `docs/quickstart.md`
- Create/Modify: `docs/adr/0002-*.md`
- Create: a guard check

- [ ] **Step 1:** Rewrite the README quickstart and `docs/quickstart.md` to document the TS workflow as the default (start the API/worker, enqueue a run). Remove `ai-run-issue-v2` invocations from the happy-path instructions.

- [ ] **Step 2:** Write/extend ADR-0002 documenting the cutover: what moved, why, the new default workflow, and the emergency procedure for the legacy script.

- [ ] **Step 3: Add a guard** — a small test or CI grep that fails if the documented default workflow (README quickstart code block / package.json default scripts) references a `scripts/legacy/` path:

```bash
# CI step
if grep -n "scripts/legacy/ai-run-issue-v2" README.md docs/quickstart.md package.json; then
  echo "default workflow must not reference legacy scripts"; exit 1
fi
```

- [ ] **Step 4:** Full sweep: `pnpm -r typecheck && pnpm lint && pnpm test && pnpm test:bash`.

- [ ] **Step 5: Commit** `git add -A && git commit -m "docs: cutover to TypeScript workflow (ADR-0002) + legacy quarantine"`

---

## Self-review checklist

- [ ] Acceptance → checks: default documented workflow invokes no legacy script (Task 4 guard); `ai-run-issue-v2` under `scripts/legacy/` with banner (Task 2); no live code references the quarantined scripts (Task 1/2 grep clean); `emit_event.sh` kept only if referenced (Task 3); README/quickstart/ADR-0002 updated (Task 4).
- [ ] Nothing hard-deleted — everything is moved/preserved.
- [ ] Both `pnpm test` and `pnpm test:bash` green.

## Definition of done

Merged with green CI; default workflow is TS-only; cutover documented in ADR-0002; legacy preserved under quarantine, not deleted.
