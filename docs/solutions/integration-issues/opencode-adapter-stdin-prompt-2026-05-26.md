---
title: Opencode adapter must pipe prompt via stdin, not a CLI flag
date: 2026-05-26
category: integration-issues
module: packages/infrastructure
problem_type: integration_issue
component: tooling
severity: critical
symptoms:
  - Every opencode agent invocation failed immediately with exit code 1
  - opencode stderr showed "Unknown flag: --prompt-file"
  - ~500ms round-trip per call (fast enough to mask the pattern as a timeout)
  - All automated runs blocked (P0)
root_cause: wrong_api
resolution_type: code_fix
tags:
  - opencode-adapter
  - stdin
  - prompt-file
  - cli-integration
  - execa
---

# Opencode Adapter Must Pipe Prompt via Stdin, Not a CLI Flag

## Problem

`OpenCodeAgentAdapter` (`packages/infrastructure/src/agent/opencode-adapter.ts`) passed `--prompt-file <path>` to `opencode run`, but that flag does not exist in the opencode CLI. Every automated agent invocation failed immediately with exit code 1, blocking all automated runs.

## Symptoms

- `OpenCodeAgentAdapter.invoke()` always returned `outcome: 'failed'`, exit code 1
- opencode stderr showed usage help (unknown flag rejection)
- ~500ms round-trip per call — just fast enough to avoid timeouts, masking the pattern
- P0 severity: all automated runs blocked

## What Didn't Work

- **`--prompt-file <path>`** in the execa argv: The flag doesn't exist in opencode. `opencode run` accepts prompt content as a positional `message` arg or via stdin only.

- **Positional argv** (`args.push(promptContent)`): Worked for small prompts, but Linux `MAX_ARG_STRLEN` is only 128 KiB per argv element (`32 × PAGE_SIZE`). Real PR-review prompts (diff + context) routinely exceed 128 KiB, causing `E2BIG` (from `execve`) before opencode even starts. This was discovered during PR review.

## Solution

Pipe the prompt file content via stdin using execa's `input` option (no argv flag at all):

```ts
// Bad — flag doesn't exist:
const child = execa(bin, ['run', '--prompt-file', request.promptPath], {
  cwd: request.cwd,
  reject: false,
});

// Good — stdin piping:
const child = execa(bin, ['run'], {
  cwd: request.cwd,
  reject: false,
  input: readFileSync(request.promptPath, 'utf-8'),
});
```

The args array must contain `'run'` (and optionally `--model` for model selection), but no prompt-path flag. The prompt itself flows through stdin.

## Why This Works

`opencode run` accepts prompt content as a positional `message` arg or reads it from stdin when no message arg is given. Stdin has no per-argument size limitation — bounded only by memory/pipe buffer capacity. execa passes stdin via pipe (not a shell), so shell metacharacters, quotes, and `$` variable references in prompts pass through unmodified.

## Prevention

- **>150KB regression test** (`opencode-adapter.test.ts`): Generates a 160,000-byte prompt file, invokes the adapter with a fake opencode binary that logs stdin, and asserts the full content was received. This test would catch any future attempt to "simplify back to argv."

- **Multi-line/special-chars test**: Verifies content with embedded quotes (`"quotes"`) and shell variables (`$shell`) passes through stdin unmodified.

- **Fixture traces stdin**: `fake-opencode-args-logger.sh` writes stdin to `last-stdin.txt`, enabling content-level assertions in tests (not just exit-code checks).

- **Arg assertions**: Tests explicitly verify `--prompt-file` and the prompt file path do NOT appear in the logged argv.

## Related Issues

- GitHub PR #114 — full review history (stdin → positional → stdin back-and-forth)
- Issue #112 — original bug report
- Linux `MAX_ARG_STRLEN` = 128 KiB (`32 × PAGE_SIZE`) — see `linux/include/linux/binfmts.h`
- ADR 0008 allows ~35-40k token prompt packs
