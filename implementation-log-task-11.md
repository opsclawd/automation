# Task 11: Multi-repo API Integration Tests

## Scope
Write integration tests for multi-repo API endpoints and verify E2E validations covering multiple repositories.

## Changes

### apps/api/src/__tests__/multi-repo-api-routes.test.ts
- Created integration tests covering all requirements:
  - `GET /api/runs?repositoryId=<A>` filters out repo B runs
  - `GET /api/runs/:uuid` from A returns 404 from B context
  - `POST /api/runs/:uuid/cancel` with wrong repo context returns 404
  - `POST /api/runs` without repositoryId when two repos enabled returns 400
  - `POST /api/runs` with disabled repo returns 409 naming the repo
  - `GET /api/runs?repositoryId=owner/repo-a` (legacy form) resolves to canonical id
  - `POST /api/runs` with header X-Repository-Id: owner/name resolves and creates under correct repo

### apps/api/src/__tests__/helpers/test-server.ts
- Created `buildTestServer` helper setting up test instances of the fastify api server using composed container roots, registerRepository registry helper, disableRepository registry helper, startIssue run execution helper, and HTTP request inject helpers (GET and POST).

### apps/api/src/serializers.ts
- Serialized `repoId` field inside `serializeRun` response mapping to allow validation checks on returned run records from `/api/runs`.

## Verification
- Ran vitest target: `pnpm vitest run apps/api/src/__tests__/multi-repo-api-routes.test.ts`
  **Result**: 7/7 tests passed.
- Ran workspace build: `pnpm -r build` (Passed)
- Ran workspace typecheck: `pnpm -r typecheck` (Passed)
- Ran workspace lint: `pnpm lint` (Passed)
- Ran workspace test: `pnpm -r test` (Passed)
