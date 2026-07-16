# Issue #636 Operational Documentation Design

## Goal

Make the repository's primary documentation accurately describe the implemented TypeScript orchestrator, including centralized multi-repository operation, scheduling, recovery, shutdown, and current single-host limits.

## Editorial model

The documentation will have a clear authority hierarchy:

1. `README.md` gives the current product overview, architecture, operating model, and links to deeper guides.
2. `docs/quickstart.md` is the executable operator path from installation through repository registration, starting services, creating runs, managing runs, and recovery.
3. `CONTEXT.md`, current ADRs, `docs/design-decisions-report.md`, and focused operations guides remain the detailed sources for domain language and decisions.
4. `docs/prd.md` and `docs/milestone-stories.md` remain historical records. They receive prominent archive banners and links to current documentation, but their historical bodies are not rewritten.

This avoids presenting old plans as current behavior without erasing the record of how the system evolved.

## Changes

### README

- Replace M1/M2-only and "planned architecture" language with implemented-system language.
- Describe the current TypeScript pipeline and runtime adapters.
- Explain registered repositories, queued jobs, worker leases, fair scheduling, repository isolation, recovery, and graceful shutdown.
- State the single-tenant and single-host boundaries precisely.
- Keep the overview concise and route operational detail to the quickstart and recovery guide.

### Quickstart

- Verify prerequisites, package commands, CLI flags, API/dashboard startup, and worker modes against the current code.
- Provide a clean-checkout path for a local single-repository setup.
- Provide centralized multi-repository registration, selection, run creation, filtering, and management examples.
- Explain configuration precedence, phase profiles, storage locations, run states, resume/cancel/execute/merge-readiness operations, and recovery entry points.
- Remove unsafe operational advice such as direct database mutation when a supported command or recovery procedure exists.

### Historical and supporting documents

- Add archive banners to the PRD and milestone stories.
- Update product-direction or ADR wording only where a passage claims to describe current behavior and conflicts with the implementation.
- Update CLI help strings only where inspection shows stale Bash-default or obsolete behavior.

## Verification

- Compare every documented command and flag with CLI definitions and existing CLI tests.
- Compare phase order and run states with application/domain definitions.
- Check links and referenced paths.
- Run focused CLI tests after any CLI help change.
- Run the repository's mandatory gates: `pnpm -r build`, `pnpm -r typecheck`, `pnpm lint`, and `pnpm -r test`.
- Run `pnpm depcruise` if any package/application imports change; documentation-only work should not require it.

## Scope boundaries

- No new orchestration behavior.
- No distributed scheduling, multi-tenant authorization, quotas, billing, or automatic merge claims.
- No wholesale rewriting of historical planning documents.
- No invented commands or examples that cannot be verified against the current implementation.
