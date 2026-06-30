# Implementation Log - Task 3: SQLite Job Queue Adapter

## Progress Summary
Implemented and verified Task 3: Add SQLite Job Queue Adapter. Persisted jobs to SQLite to replace the `NoOpJobQueue` behaviour and enable API retry/resume workflows to queue work dynamically for workers.

## Details of Implementation

### Migration 15 (`packages/infrastructure/src/sqlite/migrations/0015-add-jobs.ts`)
- Added the schema migration that creates the `jobs` table and relevant indexes:
  - `idx_jobs_status_priority_created` for optimal claiming order (`status`, `priority DESC`, `created_at ASC`, `id ASC`).
  - `idx_jobs_repo_id` and `idx_jobs_run_id` for quick lists.
- Registered the migration in `packages/infrastructure/src/sqlite/migrations.ts`.

### Job Queue Repository (`packages/infrastructure/src/sqlite/job-queue-repository.ts`)
- Implemented `JobQueueRepository` implementing `JobQueuePort`:
  - `enqueue` verifies that the target repository is approved/registered and enabled, throwing a `RepositoryNotApprovedError` otherwise. It also guards against duplicate IDs by throwing a `DuplicateJobIdError`.
  - `claimNext` selects and claims the highest priority queued job, ordering by priority (descending), earliest `createdAt` (ascending), and alphabetically by ID (ascending), while ignoring skipped IDs. The claim, attempts increment, and update are processed within a database transaction.
  - State mutation methods (`releaseClaim`, `resetToQueued`, `markRunning`, `markSucceeded`, `markFailed`, `markCancelled`) load the job record, transition it using domain helper functions, and persist the update atomically.
  - Queries (`listForRepo`, `listForRun`, `findById`) correctly deserialize SQLite stored strings/dates back into domain `Job` objects with typed IDs and `Date` properties.
  - Handled `exactOptionalPropertyTypes: true` compiler rules in `toJob` to avoid setting optional job properties (`claimedBy`, `claimedAt`, `startedAt`, `completedAt`) explicitly to `undefined`.
- Exported `JobQueueRepository` from `packages/infrastructure/src/index.ts`.

### Test Coverage & Verification
- **Migration Tests:** Verified columns, constraints, index presence, and schema version 15 update in `packages/infrastructure/src/sqlite/__tests__/migrations-0015.test.ts`.
- **Idempotency/Count Updates:** Updated existing tests (`migrations-0002.test.ts`, `migrations-0005.test.ts`, `migrations.test.ts`) that were hard-coded to expect exactly 14 migrations to expect 15 migrations.
- **Adapter Tests:** Covered enqueue functionality, duplicate ID rejection, missing/disabled repository rejection, claim sorting order, skipped job filters, transactional state transitions, release/reset behavior, and list/find lookups in `packages/infrastructure/src/sqlite/__tests__/job-queue-repository.test.ts`.
- **Type Checking:** Verified that the workspace compiles with zero type errors by running `pnpm -r typecheck`.
- **All Tests Pass:** Verified that all 1963 tests in the workspace pass successfully.
