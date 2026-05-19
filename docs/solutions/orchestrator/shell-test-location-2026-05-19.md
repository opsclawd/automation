---
title: Shell tests placed in scripts/__tests__/*.test.sh are silently ignored by CI
date: 2026-05-19
category: orchestrator
module: scripts
problem_type: test_orphaned_from_ci
component: testing_framework
symptoms:
  - New test files added under scripts/__tests__/ as *.test.sh
  - Tests run and pass when invoked directly with bash
  - pnpm test:bash reports the same number of tests as before — new tests not included
  - PR ships with "validated tests pass" claim despite tests never running in CI
root_cause: wrong_test_location_or_format
resolution_type: convention_alignment
severity: medium
related_components:
  - tooling
  - ci
tags:
  - bats
  - shell-tests
  - test-discovery
  - pnpm-test
  - orchestrator-script
  - agent-convention-drift
---

# Shell tests placed in scripts/**tests**/\*.test.sh are silently ignored by CI

## Problem

`package.json` defines:

```json
"test:bash": "bats scripts/lib/__tests__"
```

`pnpm test:bash` runs **only** `.bats` files under **`scripts/lib/__tests__/`**. Anything outside that path or with a non-bats extension is invisible to CI.

Multiple agent-authored PRs (e.g. PR #53, PR #56) have added shell tests under `scripts/__tests__/*.test.sh` instead. The tests are well-written and pass when invoked directly — but `pnpm test:bash` doesn't pick them up, so they never run in CI. The PR ships with a "tests pass" claim that's true only for manual invocation, not for the gate that actually blocks merges.

## Symptoms

- `git diff --stat` shows new `scripts/__tests__/*.test.sh` files
- `pnpm test:bash` output count is unchanged from the prior commit
- `bash scripts/__tests__/foo.test.sh` runs the tests successfully when invoked directly
- The validate phase log shows `pnpm test` passing (vitest, not bash), but the new bash tests are nowhere

## What Didn't Work

- **Trusting the agent's "validated tests pass" claim** — the agent runs tests manually as part of its workflow and reports success, but doesn't notice that the CI hook doesn't run them.
- **Renaming `.sh` → `.bats` in place** — still doesn't help because the path is wrong; `bats` only scans the configured directory.
- **Adding a separate `test:shell` script pointing at `scripts/__tests__/`** — possible, but fragments the test convention and adds a script every developer/agent has to remember. The single-location convention is the simpler fix.

## Solution

**Always place shell tests at `scripts/lib/__tests__/<name>.bats`.** Convert anything in the wrong location to this layout:

1. Rewrite `scripts/__tests__/foo.test.sh` as `scripts/lib/__tests__/foo.bats` using bats syntax (`@test "name" { ... }` blocks, `setup`/`teardown` hooks, `run <cmd>` + `[ "$status" -eq N ]` assertions).
2. Delete the original `.test.sh` and remove the `scripts/__tests__/` directory if empty.
3. Verify: `bats scripts/lib/__tests__/` should report the new tests in its count.

When a test needs to extract a single bash function from a host script for isolation, use `awk` brace-counting rather than a `sed` range — `sed` breaks the moment the function contains a `}` inside a heredoc:

```bash
eval "$(awk '
  /^my_function\(\)/ { found=1 }
  found { print; if (/\{/) depth+=gsub(/{/,"{"); if (/\}/) depth-=gsub(/}/,"}"); if (depth==0 && found) exit }
' "$SCRIPT_PATH")"
```

See `scripts/lib/__tests__/validate_review_artifacts.bats` (this PR) and `scripts/lib/__tests__/seed-excludes.bats` (PR #53) for working references.

## Why This Works

`bats` is a directory scanner with a fixed file extension (`.bats`). It only sees files matching `<dir>/*.bats`. By pinning the convention to one path + one extension, there's exactly one place to look and exactly one decision the agent has to get right. Anything else falls into the silent-ignore trap.

## Prevention

- **Mention the convention in `AGENTS.md`** so agent runs see it before writing the first shell test (this PR adds a pointer here).
- **CI guardrail (future):** add a check that fails if any file matches `scripts/__tests__/**/*` or `scripts/**/*.test.sh` outside the canonical location. A 3-line `find` in `package.json`'s `lint` or a new `test:bash-discovery` script would catch it next time.
- **In the validate phase**, the `pnpm test:bash` output should include the test count. When an agent adds a test, the expected count should go up; if it doesn't, that's a signal to investigate before claiming "tests pass".

## Related Issues

- PR [#53](https://github.com/opsclawd/automation/pull/53) — first occurrence; final commit `bd7b4a6` moved `seed-excludes.bats` from `scripts/__tests__/` to `scripts/lib/__tests__/`
- PR [#56](https://github.com/opsclawd/automation/pull/56) — second occurrence; commit `e3d4e0a` relocated `validate_review_artifacts.bats` and `resolve_result.bats`, and added this solution doc
