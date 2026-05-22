---
title: Multi-layer path sanitization for artifact content serving
date: 2026-05-17
category: runtime-errors
module: apps/api
problem_type: security
component: artifact-routes
symptoms:
  - Path traversal attacks on artifact endpoints
  - Requests for files outside run directory
root_cause: missing_input_validation
resolution_type: pattern
severity: high
related_components:
  - apps/api/src/routes/artifacts.ts
tags:
  - path-sanitization
  - security
  - fastify
  - path-traversal
---

# Multi-Layer Path Sanitization for Artifact Content Serving

## Problem

Artifact content requests (`GET /api/runs/:runId/artifacts/*`) must prevent path traversal attacks where a malicious caller crafts a URL like `/api/runs/.../artifacts/../../../etc/passwd`.

The artifact route implements four layers of path traversal prevention.

## Four-Layer Implementation

```typescript
// apps/api/src/routes/artifacts.ts

// Layer 1: URL decode + normalize
const decoded = decodeURIComponent(filePath);
const normalized = path.normalize(decoded);

// Layer 2: Prefix and absolute check
if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
  return reply.status(400).send({ error: 'Invalid path' });
}

// Layer 3: Relative path check
const relative = path.relative(rootDir, absTarget);
if (relative.startsWith('..')) {
  return reply.status(400).send({ error: 'Invalid path' });
}

// Layer 4: Symlink resolution
const realRoot = await fs.realpath(rootDir);
const realTarget = await fs.realpath(absTarget);
if (!realTarget.startsWith(realRoot)) {
  return reply.status(400).send({ error: 'Invalid path' });
}
```

## Layer Explanations

| Layer                 | What it catches                                                      |
| --------------------- | -------------------------------------------------------------------- |
| 1. Decode + normalize | `..` segments hidden in encoded URLs                                 |
| 2. Prefix check       | Paths starting with `..` or absolute paths                           |
| 3. Relative check     | Computes where the path resolves relative to root; catches traversal |
| 4. Symlink resolution | Handles symlinks inside run directory pointing outside               |

Layer 4 was added during implementation beyond the original plan. It handles the case where symlinks inside the run directory point outside it.

## Why Four Layers?

Each layer catches different attack vectors:

- Layer 1 catches URL-encoded traversal sequences
- Layer 2 catches obvious `..` prefixes and absolute paths
- Layer 3 catches path traversal that resolves outside root after normalization
- Layer 4 catches symlink-based traversal that layers 1-3 miss

## UUID Validation First

Before any path sanitization, the `runId` parameter is validated as a UUID:

```typescript
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!UUID_RE.test(runId)) {
  return reply.status(400).send({ error: 'Invalid run ID format' });
}
```

This prevents unnecessary repository lookups on malformed input.

## Key Implementation Details

- Uses `path.normalize()` which collapses redundant separators and `..` segments
- `path.relative(root, target)` returns `..` if target is outside root
- `fs.realpath()` resolves symlinks — required because a symlink inside the run directory could point outside
- All layers run before any filesystem access

## Testing Path Traversal

```typescript
it('rejects path traversal attempt', async () => {
  const res = await fetch(`/api/runs/${RUN_ID}/artifacts/../../../etc/passwd`);
  expect(res.status).toBe(400);
});
```

## If You Modify Artifact Routes

Do NOT remove or weaken any of these layers. Any file read in artifact routes must go through this guard. The symlink resolution layer (Layer 4) is especially important — it is the only layer that catches symlink-based traversal.
