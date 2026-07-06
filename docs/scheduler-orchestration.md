# Scheduler and Worker Orchestration

This document explains the scheduler topology, concurrency controls, and recovery semantics for multi-repository orchestration.

## Topology

The orchestrator operates as a set of long-lived processes:
- **API/Server**: Handles incoming requests, enqueues jobs, and provides observability.
- **Worker Scheduler**: A long-lived process (started via `orchestrator worker start`) that discovers runnable work and allocates workers.

## Concurrency Controls

Concurrency is enforced at two levels:

1.  **Global Concurrency**: The total number of workers in the pool (configured via `--workers` on the `worker start` command).
2.  **Repository Concurrency**: Each repository has a `max_concurrent_runs` limit (default is 1). The scheduler ensures that no repository exceeds its local limit, even if global workers are available.

## Scheduling Policy

The scheduler uses a **Fair Round-Robin** policy combined with **Oldest-Job-First** within a repository:
1.  Discovers all enabled repositories.
2.  Iterates through them in a round-robin fashion.
3.  For each repository, if it is below its `max_concurrent_runs` limit and an idle worker is available, it claims the oldest queued job for that repository.

This ensures that a high-volume repository cannot indefinitely starve smaller repositories.

## Recovery Semantics

### Process Restart
When the scheduler or worker process restarts:
- **Lease Heartbeats**: Active workers maintain heartbeats on their repository leases. If a process dies, heartbeats stop.
- **Lease Reclamation**: The scheduler periodically reclaims expired leases where the owning worker is no longer alive.
- **Job Re-queuing**: When a lease is reclaimed, the associated job is reset to `queued` (if it was `claimed` or `running`), allowing it to be picked up by another worker.

### Repository Health
- Only `enabled` repositories are considered for scheduling.
- If a repository's worktree path is unavailable or Git operations fail, the worker will fail the job, and the scheduler will move to the next repository. This prevents one unhealthy repository from blocking the entire system.

## Worktree Isolation

Worktrees are isolated by repository full name and issue number:
`.ai-worktrees/{owner}/{repo}/issue-{number}`

This prevents collisions even if multiple repositories use the same branch or issue numbering scheme.
