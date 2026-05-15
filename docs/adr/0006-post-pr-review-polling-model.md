# Post-PR review polling model

We keep PR review handling inside the same Run and treat polling as a managed phase so comment processing remains observable and resumable.

## Considered Options

**Lifecycle placement**: End the Run at PR creation vs. continue through PR review. We chose a single issue-to-merged-PR Run that extends into a `pr-review-poll` phase.

**Polling mechanism**: Webhooks only vs. polling only vs. polling first with webhook compatibility later. We chose timer-based polling for MVP, with the abstraction left open for webhook support later.

**Comment deduplication**: Re-process every poll vs. track handled comments. We chose to store processed/replied comment tracking so the same comment is not handled twice.

**Review visibility**: Treat review handling as invisible background work vs. managed job with status. We chose a managed job so users can see whether review handling is still active.

## Consequences

- The Run lifecycle matches the actual user journey from issue to merged PR
- Review comments stay auditable across polls
- Duplicate handling is prevented by explicit tracking
- The system can evolve toward webhook-driven notifications without changing the model
