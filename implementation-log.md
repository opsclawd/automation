# Task 2 Implementation Summary

- Added `apps/api/src/durable-agent-artifacts.ts` with `createArtifactCapturingAgent(...)`.
- The helper wraps an `AgentPort`, waits for the wrapped invocation to resolve, then captures a de-duplicated set of expected, phase, and optional artifact paths into the configured `ArtifactStore`.
- Missing files are skipped on a per-path best-effort basis; read and write errors still surface.
- Added `apps/api/src/__tests__/durable-agent-artifacts.test.ts` covering successful capture, missing optional artifacts, passthrough of the wrapped result, and propagation of agent failures without capture.
- Verified with:
  - `pnpm vitest run apps/api/src/__tests__/durable-agent-artifacts.test.ts --reporter=verbose`
  - `pnpm --filter @ai-sdlc/api typecheck`
