---
title: Atomic config loading — Zod + two try/catch pattern
date: 2026-05-22
category: domain
module: packages/shared
problem_type: pattern
component: config-loader
symptoms:
  - Cryptic parse errors when config file missing or malformed
  - No field-level validation error messages
root_cause: missing_validation_layer
resolution_type: pattern
severity: medium
related_components:
  - packages/shared/src/config/loader.ts
  - packages/shared/src/config/schema.ts
  - packages/shared/src/config/errors.ts
tags:
  - zod
  - config
  - validation
  - error-handling
---

# Atomic Config Loading — Zod + Two Try/Catch Pattern

## Problem

Config loading needs to distinguish three failure modes with distinct error messages:

1. File missing → "Missing .ai-orchestrator.json at /path"
2. Bad JSON → "Invalid JSON in .ai-orchestrator.json: ..."
3. Schema validation failure → "validation.timeout: Number must be greater than 0"

A single `JSON.parse(readFileSync(...))` expression cannot cleanly distinguish case 1 from case 2.

## Solution

### Two separate try/catch blocks

```typescript
// packages/shared/src/config/loader.ts

export function loadConfig(repoRoot: string): OrchestratorConfig {
  const path = join(repoRoot, CONFIG_FILENAME);

  // Block 1: file read
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new ConfigError(`Missing ${CONFIG_FILENAME} at ${path}`, err);
  }

  // Block 2: JSON parse
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`Invalid JSON in ${CONFIG_FILENAME}: ${(err as Error).message}`, err);
  }

  // Block 3: Zod validation
  const parsed = orchestratorConfigSchema.safeParse(json);
  if (!parsed.success) {
    throw new ConfigError(formatZodError(parsed.error), parsed.error);
  }

  return parsed.data;
}
```

### Why not a single try/catch?

If the file is missing, `readFileSync` throws with `ENOENT`. If you catch that and re-throw with a custom message, you're fine. But `JSON.parse` also throws on malformed JSON — and if you catch both in one block, you can't distinguish the error type without inspecting the message or `cause`.

Two blocks make the distinction unambiguous.

## Zod Schema Design

### No `strict()` on the schema

Unknown keys pass through. This keeps the schema permissive during early iteration. Revisit when a `version` field is introduced.

### Use `.default()` for optional arrays

```typescript
const phasesSchema = z.object({
  skip: z.array(z.string()).default([]),
});
```

The default applies when the key is absent. If `phases` is present but `skip` is omitted, Zod applies the default `[]`. If `phases` is absent entirely, validation fails (because `phases` is required as an object).

### Field-level validation with path in error

```typescript
function formatZodError(err: ZodError): string {
  return err.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
}
```

Produces: `validation.timeout: Number must be greater than 0; validation.commands: Array must have at least 1 element`

When `issue.path` is empty (e.g., root-level union discriminator failure), falls back to `<root>`.

## ConfigError Class

```typescript
// packages/shared/src/config/errors.ts

export class ConfigError extends Error {
  constructor(
    message: string,
    public override cause?: unknown,
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}
```

`cause` is stored as `public override cause` so it is accessible both as `err.cause` and via `Error.cause` in environments that support it.

## Schema File Layout

```
packages/shared/src/config/
├── errors.ts          ← ConfigError class (no I/O)
├── schema.ts           ← pure Zod schema (no I/O)
├── loader.ts           ← loadConfig(repoRoot), reads file
└── __tests__/
    └── loader.test.ts  ← five cases, uses mkdtempSync
```

`schema.ts` has zero imports from `node:fs` or `node:path` — fully testable without I/O.

## Testing Five Cases

| Case           | Setup                             | Assert                                                  |
| -------------- | --------------------------------- | ------------------------------------------------------- |
| Happy path     | All fields present                | Returns correct typed object                            |
| Missing file   | File doesn't exist                | `ConfigError`, message contains `.ai-orchestrator.json` |
| Malformed JSON | Invalid JSON                      | `ConfigError`, message starts with `Invalid JSON`       |
| Invalid values | Empty commands + negative timeout | Error mentions both fields                              |
| Defaulting     | `phases.skip` omitted             | Returns `[]`                                            |

## Modifying This Code

### To add a new top-level config section

Add a new subschema in `schema.ts` and add it to `orchestratorConfigSchema`. Do not use `.strict()` unless a version field exists.

### To change error message format

Modify `formatZodError` in `loader.ts`. The error message format is not part of a public API contract.

### To read config from a non-standard path

Pass a different `repoRoot` to `loadConfig()`. There is no CLI flag or environment variable override — that was explicitly deferred.

## Gotchas

- **Wrong `repoRoot` produces "file missing"** — if caller passes incorrect path, error is `Missing .ai-orchestrator.json at <wrong/path/.ai-orchestrator.json>`. Loader does not walk parent directories.
- **No `strict()` — typos silently ignored** — extra key like `"validaton": {...}` passes through without error.
- **`.min(1)` on `validation.commands`** — empty array fails validation. Intentional.
