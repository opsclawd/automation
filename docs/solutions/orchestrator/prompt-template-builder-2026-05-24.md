---
title: Hybrid prompt template builder — renderPrompt + loadPromptTemplate
date: 2026-05-24
category: orchestrator
module: packages/application
problem_type: templating
component: prompts
symptoms:
  - Legacy Bash prompts built with heredocs are hard to diff, test, and audit
  - No structured way to compose prompts from versioned files and runtime artifacts
  - Rendered prompts are ephemeral with no audit trail
root_cause: missing_prompt_abstraction
resolution_type: implementation
severity: medium
related_components:
  - packages/application/src/prompts/render-prompt.ts
  - packages/application/src/prompts/load-prompt-template.ts
  - packages/application/src/prompts/errors.ts
  - packages/application/src/prompts/index.ts
  - packages/application/src/ports/artifact-store.ts
  - .dependency-cruiser.cjs
  - prompts/
tags:
  - prompt-templating
  - layer-boundary
  - artifact-composition
  - M4-03
---

# Hybrid Prompt Template Builder

## Problem

The orchestrator's Bash scripts build agent prompts via heredocs and `cat` inlines. This makes prompts hard to diff in version control, hard to test in isolation, and impossible to audit at runtime — the actual prompt used during execution is ephemeral.

Issue #93 (M4-03) introduced a hybrid template-plus-code prompt builder that composes prompts deterministically from versioned files in `prompts/` and runtime-injected artifacts, making the rendered prompt itself a versioned artifact on every invocation.

## What Was Decided

**Two-stage prompt composition:**

1. **`loadPromptTemplate(phase, step, opts)`** — synchronous filesystem I/O, reads `prompts/<phase>/<step>.md`
2. **`renderPrompt(template, ctx)`** — pure async substitution, replaces `{{var:name}}` and `{{artifact:path}}` placeholders

**Two placeholder forms:**

- `{{var:<name>}}` — substituted from `ctx.vars[name]` (string). Unknown var → `TemplateError`
- `{{artifact:<relative-path>}}` — substituted with artifact contents via `ctx.artifacts.read(runId, path)`. Missing artifact → `TemplateError`

**Two error types:**

- `TemplateError` — runtime substitution failures (unknown var, missing artifact). Carries `.placeholder` property.
- `TemplateNotFoundError` — file-not-found when loading a template. Carries full resolved path in message.

## Key Implementation Decisions

### `ArtifactStore.read()` signature uses `(runId, relativePath)`

The `ArtifactStore` port from M3-05 defines `read(runId: string, relativePath: string): Promise<string>`. The original plan assumed `read(path)` but the actual port requires `runId` as the first argument. This is why `PromptContext` includes a `runId` field — it flows through to `ctx.artifacts.read(ctx.runId, key)`.

**Key files:**

- Port: `packages/application/src/ports/artifact-store.ts:19`
- Consumer: `packages/application/src/prompts/render-prompt.ts:30`

### Path traversal protection in `loadPromptTemplate`

The implementation added `validatePathSegment()` beyond what the plan specified. Before constructing the file path, it checks that `phase` and `step` contain no `/`, `\`, or `..` — preventing path traversal attacks.

**Key file:** `packages/application/src/prompts/load-prompt-template.ts:9-13`

### Selective ENOENT handling in `loadPromptTemplate`

The `catch` block only wraps errors with `code === 'ENOENT'` into `TemplateNotFoundError`. Other I/O errors (permissions, etc.) are re-thrown as-is, avoiding information loss.

**Key file:** `packages/application/src/prompts/load-prompt-template.ts:34-38`

### Cursor-based string reconstruction in `renderPrompt`

Rather than using `replaceAll`, `renderPrompt` collects all placeholder positions into a replacements array, then reconstructs the string with a cursor walk. This handles cases where replacement values might themselves contain placeholder-like syntax and avoids mutating the string during iteration.

**Key file:** `packages/application/src/prompts/render-prompt.ts:38-45`

### Regex `/g` flag constraint

The `PLACEHOLDER_RE` uses the `/g` flag (required for `matchAll`). A comment explicitly warns: `"do NOT use with .test() or .exec()"` — the `/g` flag causes stateful iteration bugs with those methods.

**Key file:** `packages/application/src/prompts/render-prompt.ts:11`

## Trade-offs Considered

### Layer boundary violation (deliberate leak)

`loadPromptTemplate` imports `node:fs` and `node:path` from `packages/application`, violating the layer boundary rule. The alternative was defining a `PromptTemplateLoaderPort` interface in `ports.ts` and implementing it in `packages/infrastructure`.

**Chosen:** Deliberate exception, allowlisted in depcruise. Reason: for M4-03 scope, the indirection wasn't worth it — only one file does I/O, the render function stays pure, and the exception is narrowly scoped and documented.

**If you need more I/O in `packages/application`:** define a port. Don't add more allowlist entries.

**Allowlist entry:** `.dependency-cruiser.cjs:18-33` (rule name `application-no-io-except-prompt-template`)

### No escape syntax for `{{`/`}}`

Literal `{{` and `}}` outside a placeholder are not legal in this template language. There is no escape mechanism. This was a deliberate simplicity choice — if a template needs literal braces, write the variant in code.

### Synchronous `loadPromptTemplate`

`loadPromptTemplate` uses `readFileSync` rather than async I/O. Rationale: callers can handle blocking I/O at the orchestration level. Caching can be added later if performance becomes a concern.

## Gotchas and Pitfalls

1. **`ArtifactStore.read()` takes `runId` first.** The signature is `read(runId, relativePath)`, not `read(path)`. Forgetting the `runId` argument will cause cryptic test failures.

2. **The `/g` flag on `PLACEHOLDER_RE`.** Never call `.test()` or `.exec()` on this regex — it will advance `lastIndex` and skip matches. Always use `matchAll()`.

3. **`TemplateError` vs `TemplateNotFoundError`** are different error types with different semantics. `TemplateError` = runtime (bad context). `TemplateNotFoundError` = configuration (missing file). Don't catch one when you mean the other.

4. **`prompts/` directory must exist.** `loadPromptTemplate` throws `TemplateNotFoundError` if the prompts directory doesn't exist. The `prompts/.gitkeep` file ensures the directory is tracked in git even when empty.

5. **`PromptContext.runId` is required.** Unlike the original plan, the implemented `PromptContext` interface includes `runId` because `ArtifactStore.read()` needs it. Calling code must always provide it.

6. **Path traversal protection is strict.** `loadPromptTemplate` rejects phase/step names containing `/`, `\`, or `..`. If you need dots in names (e.g. `step.v2`), that works — only `..` as a complete segment is blocked. But `/` and `\` in names are disallowed.

7. **Only `ENOENT` is wrapped.** Other filesystem errors from `loadPromptTemplate` (EACCES, EMFILE, etc.) propagate as-is. Don't assume all errors from this function are `TemplateNotFoundError`.

8. **Cross-package `instanceof` is unreliable.** `ArtifactNotFoundError` is defined in a port file in `packages/application`. When `renderPrompt` catches an error and checks `instanceof ArtifactNotFoundError`, the check can fail across package boundaries if duplicate class instances exist (common in monorepos with linked workspace packages). The fix: always provide a duck-type fallback alongside `instanceof`:

   ```typescript
   export function isArtifactNotFoundError(err: unknown): err is ArtifactNotFoundError {
     return (
       err instanceof ArtifactNotFoundError ||
       (err instanceof Error && err.name === 'ArtifactNotFoundError')
     );
   }
   ```

   Apply this pattern to any custom error type shared across workspace packages.

9. **Depcruise `node:fs`/`node:path` rule must enumerate all import variants.** Node's filesystem/path modules have many import spellings: `node:fs`, `fs`, `node:fs/promises`, `fs/promises`, `node:path/posix`, `node:path/win32`, `path`, etc. The `application-no-io-except-prompt-template` depcruise rule needed four rounds of tightening to cover all variants. A rule that only matches exact specifiers (e.g., `node:fs` but not `fs`) is trivially bypassed. Enumerate all known variants explicitly in the regex alternation.

## What Someone Modifying This Code Should Know

- **Files to modify:**
  - Add new error types → `packages/application/src/prompts/errors.ts`
  - Change substitution logic → `packages/application/src/prompts/render-prompt.ts`
  - Change template loading → `packages/application/src/prompts/load-prompt-template.ts`
  - Add new exports → `packages/application/src/prompts/index.ts` (barrel)
  - Add new ports → `packages/application/src/ports/artifact-store.ts`

- **When M4-06 migrates Bash prompts:** new `.md` files go in `prompts/<phase>/<step>.md`. Snapshot tests for real templates should be added at that point (M4-03 only has inline fixture tests).

- **When adding new placeholder types:** the regex `PLACEHOLDER_RE` captures `kind` (currently `var` or `artifact`). Add new kinds as alternatives in the regex group `(var|artifact)` and handle in the `if/else` chain in `renderPrompt`.

- **When moving `loadPromptTemplate` to infrastructure:** extract a `PromptTemplateLoaderPort` interface into `packages/application/src/ports.ts`, implement in `packages/infrastructure/`, wire in `apps/api/src/compose.ts`, and remove the depcruise allowlist entry.

- **Test pattern:** fake `ArtifactStore` uses a map-based implementation. See `packages/application/src/__tests__/render-prompt.test.ts:6-17` for the pattern. Always pass `runId` to `.read()`.

## Commits

- `8cc51d1` — Initial `renderPrompt` with error handling (Task 1)
- `7acd89d` — `loadPromptTemplate`, barrel exports, `prompts/.gitkeep` (Task 2)
- `7bbf708` — Review fixes for Task 2
- `fd839aa` — Review fixes for Task 1
