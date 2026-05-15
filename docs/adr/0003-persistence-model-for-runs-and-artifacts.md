# Persistence model for runs and artifacts

We split orchestration metadata from artifact content so the system stays fast to inspect while keeping generated files easy to recover.

## Considered Options

**Storage shape**: Event sourcing only vs. mutable tables only vs. hybrid. We chose a hybrid model: mutable status columns for quick reads, plus append-only events for history and observability.

**Database**: Postgres vs. SQLite. We chose SQLite for the MVP and local-first workflow.

**Artifact storage**: Store everything in the DB vs. store large files on disk vs. split metadata and file content. We chose filesystem storage for large artifacts and SQLite for structured state and references.

**Source of truth**: Events as the truth vs. tables as the truth. We chose mutable tables as the source of truth for orchestration state, with events as an audit trail.

## Consequences

- Reads stay simple and local
- Artifacts remain inspectable with normal filesystem tools
- Backup and debugging are straightforward on one machine
- A future storage swap stays possible behind repository ports, but is not a current goal
