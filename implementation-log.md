# Implementation Log - Task 8

## HTTP API routes for `/api/repositories`

Implemented the Fastify HTTP API routes for repository management in `apps/api/src/routes/repositories.ts` and registered them in `apps/api/src/server.ts`.

### Routes Added
- `GET /api/repositories` - List repositories (supports `all=1` query parameter).
- `GET /api/repositories/:id` - Inspect a repository by ID (sha256 hex) or full name (owner/name).
- `POST /api/repositories` - Register a repository by local path (with optional full name and config metadata).
- `PATCH /api/repositories/:id` - Update branch, remote URL, config metadata, or toggle enabled status.
- `POST /api/repositories/:id/refresh` - Refresh repository metadata.
- `DELETE /api/repositories/:id` - Remove a repository (fails with 409 if active runs exist).

### TypeScript Compliance
Adjusted input objects in POST and PATCH routes to construct properties dynamically. This avoids sending explicit `undefined` values to `RegisterRepositoryInput` and `UpdateRepositoryInput`, adhering to the strict `exactOptionalPropertyTypes` TS compiler setting configured in the workspace.
