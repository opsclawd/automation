---
title: Fastify afterEach hangs 10s when undici keep-alive races forceCloseConnections 'idle'
date: 2026-05-16
category: test-failures
module: apps/api
problem_type: test_failure
component: testing_framework
symptoms:
  - 'Hook timed out in 10000ms in afterEach for routes > serves combined.log as text/plain'
  - Pino access log shows request completing in <5ms; the 10s wait is entirely in server.stop()
  - Test passes locally but fails reproducibly on CI (timing-sensitive)
root_cause: async_timing
resolution_type: test_fix
severity: medium
related_components:
  - tooling
tags:
  - fastify
  - undici
  - keep-alive
  - force-close-connections
  - vitest
  - shutdown
---

# Fastify afterEach hangs 10s when undici keep-alive races forceCloseConnections 'idle'

## Problem

`apps/api`'s route tests time out in `afterEach` with `Hook timed out in 10000ms` whenever a test issues a streamed response (e.g. `GET /api/runs/:id/artifacts/combined.log` via `fs.createReadStream`). The request itself completes in a few ms; the hang is entirely in `server.stop()` → `app.close()` waiting for keep-alive sockets that undici (Node's global `fetch`) has not yet released. Manifests as a CI red on `pnpm --filter @ai-sdlc/api test` and `pnpm -r test`, blocking M2 work that depends on CI gating.

## Symptoms

- `× routes > serves combined.log as text/plain 10023ms → Hook timed out in 10000ms`
- Test body succeeds: HTTP 200, body assertions pass, response time ~3ms in Pino logs
- Local: 18/18 pass in ~1.1s. CI: same test reproducibly hangs the `afterEach` for ~10s

## What Didn't Work

- **`forceCloseConnections: true`** (initial #26 fix) — closed the test hang, but Codex's review on PR #28 ([discussion r3254037992](https://github.com/opsclawd/automation/pull/28#discussion_r3254037992)) correctly flagged it as a production regression: SIGINT/SIGTERM during a real artifact download would mid-stream destroy the socket and the client gets a truncated file. Same hazard for the SSE endpoint planned in M2-04.
- **`forceCloseConnections: 'idle'`** (PR #28 follow-up) — production-safe, but `closeIdleConnections()` is a one-shot snapshot taken inside `app.close()`. Whether the streaming test's socket is "idle" at that exact moment depends on undici's keep-alive release timing. Passes locally, races on CI. Flake, not fix.
- **Relying on `await r.text()` to drain the body** — the body is fully consumed, but undici returns the socket to its keep-alive pool rather than closing it. From Fastify's side the connection still looks alive at the close-snapshot moment.

## Solution

Split test vs. production shutdown semantics. Production keeps `'idle'` (no truncation hazard); tests opt in to `closeAllConnections()` via an explicit flag.

`apps/api/src/server.ts`:

```ts
export interface ServerOptions {
  container: Container;
  port?: number;
  // Test-only: destroy all sockets (including in-flight responses) on stop.
  // Production leaves this false so SIGINT/SIGTERM does not truncate artifact
  // downloads or future SSE streams; tests set it so afterEach does not block
  // on keep-alive sockets undici has not yet released.
  forceCloseAllOnStop?: boolean;
}

export async function startServer(opts: ServerOptions) {
  const app = Fastify({ logger: true, forceCloseConnections: 'idle' });
  // ... routes, listen ...
  return {
    stop: async () => {
      if (opts.forceCloseAllOnStop) app.server.closeAllConnections();
      await app.close();
    },
    address,
  };
}
```

`apps/api/src/__tests__/routes.test.ts` (in `bootServer`):

```ts
const server = await startServer({ container, port: 0, forceCloseAllOnStop: true });
```

The CLI (`apps/api/src/cli.ts`) does not pass the flag, so production shutdown is unchanged.

## Why This Works

Fastify's `forceCloseConnections: 'idle'` calls Node's `server.closeIdleConnections()` once when `app.close()` runs — a snapshot. Sockets that are still in undici's keep-alive pool but momentarily flagged "in use" at that instant aren't dropped; `app.close()` then waits for them, hitting Vitest's 10s hook timeout. `server.closeAllConnections()` destroys every socket regardless of state, so `close()` returns immediately. The hazard of destroying mid-stream sockets is real but only matters under SIGINT/SIGTERM with a real long-lived client — which tests never have — so gating it behind an explicit opt-in is safe.

## Prevention

- **Treat any new streaming endpoint (SSE, chunked transfer, long polls) as a test-shutdown hazard.** Use the `forceCloseAllOnStop: true` opt-in in any test that hits one. M2-04's SSE endpoint will need this from day one.
- **Don't loosen production shutdown to fix a test hang.** If `'idle'` isn't enough for the test but `true` would truncate real clients, separate the two paths instead of regressing prod safety.
- **When a fix passes locally but fails on CI, suspect a timing/scheduler race**, not a missing env var. The CI runner is slower and serializes work differently; that's enough to flip a keep-alive race.
- Consider adding a `pnpm test --reporter=verbose --hookTimeout=2000` smoke run on CI for `apps/api` so future hook-blocking regressions surface at 2s instead of taking the full 10s budget per failing test.

## Related Issues

- Issue [#26](https://github.com/opsclawd/automation/issues/26) — original bug report
- PR [#28](https://github.com/opsclawd/automation/pull/28) — first attempt (`true` → `'idle'`), partially fixed
- PR [#31](https://github.com/opsclawd/automation/pull/31) — this fix (test-side opt-in)
- Codex review [discussion r3254037992](https://github.com/opsclawd/automation/pull/28#discussion_r3254037992) — production truncation concern
