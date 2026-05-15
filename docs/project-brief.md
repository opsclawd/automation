# Product Requirements Document: AI SDLC Orchestrator

## Problem Statement

The current AI SDLC automation is powerful but hard to operate. The workflow spans Bash scripts, Git worktrees, GitHub operations, agent invocations, validation, review loops, and post-PR review handling, but the state of a run is mostly implicit.

When something fails, it is difficult to answer basic questions like what phase was running, what artifacts exist, whether the failure was caused by the agent or the infrastructure, and whether the work can safely resume. The result is slow debugging, unsafe retries, and a system that is useful but not yet trustworthy.

## Solution

Build a local-first orchestration platform that wraps the existing Bash workflow first, then migrates orchestration into TypeScript in small slices.

The first version should make runs observable, resumable, and recoverable without replacing the current scripts. It should capture run state, events, logs, artifacts, and failure classifications, then present them in a web UI and API so users can see what happened and what to do next.

Over time, the platform should move phase logic from Bash into TypeScript while keeping the same domain model: Run, Phase, Step, Loop, Agent Invocation, and Artifact.

## User Stories

1. As a developer, I want to start an issue-to-PR run, so that I can automate delivery from a GitHub issue.
2. As a developer, I want each run to have a unique ID, so that I can trace it across logs, artifacts, and database records.
3. As a developer, I want to see which phase is running, so that I can understand the current progress of the workflow.
4. As a developer, I want to see which phase completed last, so that I can identify where a run stopped.
5. As a developer, I want to see structured failure reasons, so that I can tell whether a failure came from a command, an agent, Git, GitHub, or validation.
6. As a developer, I want the system to capture stdout and stderr, so that I can inspect failures without rerunning the workflow.
7. As a developer, I want prompts to be stored as artifacts, so that I can audit what the agent was asked to do.
8. As a developer, I want agent outputs to be stored as artifacts, so that I can inspect what the agent produced.
9. As a developer, I want validation results to be captured separately, so that I can see build, lint, typecheck, and test outcomes clearly.
10. As a developer, I want internal review findings to be preserved, so that I can understand why a fix loop repeated.
11. As a developer, I want PR review comments to be tracked, so that I can see which comments were handled and which remain open.
12. As a developer, I want processed PR comments to be skipped on later polls, so that the same comment is not handled twice.
13. As a developer, I want the system to tell me whether a failure is safe to retry, so that I do not accidentally duplicate commits or comments.
14. As a developer, I want to resume from the last safe point, so that I do not need to restart a long run from scratch.
15. As a developer, I want to retry a failed run, so that transient problems do not require manual reconstruction.
16. As a developer, I want to cancel an active run, so that I can stop work that is no longer wanted.
17. As a developer, I want a run list view, so that I can see all recent runs at a glance.
18. As a developer, I want a run detail view, so that I can inspect logs, artifacts, events, and failures for one run.
19. As a developer, I want a phase timeline, so that I can see the workflow structure visually.
20. As a developer, I want a log view filtered by phase, so that I can focus on the part of the run I care about.
21. As a developer, I want an artifact browser, so that I can inspect generated files without searching the filesystem manually.
22. As a developer, I want a PR review polling status view, so that I can see whether comment handling is still active.
23. As a developer, I want the system to enforce one active run per issue, so that concurrent runs do not fight over the same worktree.
24. As a developer, I want branch drift to fail fast, so that I do not continue from an unexpected Git state.
25. As a developer, I want missing required artifacts to fail fast, so that agent contract violations are visible immediately.
26. As a developer, I want invalid result files to fail fast, so that malformed agent output is not treated as success.
27. As a developer, I want review/fix loops to be visible as attempts, so that I can see how many times the workflow tried to resolve feedback.
28. As a developer, I want the system to support the current Bash scripts first, so that I get value before a full rewrite.
29. As a developer, I want orchestration logic to be split from infrastructure adapters, so that the core workflow can be tested in isolation.
30. As a developer, I want the codebase to use the project’s domain language consistently, so that run state and workflow behavior stay easy to reason about.

## Implementation Decisions

- Build a local-first system that runs on one machine and stores state on that machine.
- Treat the current Bash scripts as infrastructure adapters during the first phase.
- Use a Node/TypeScript API and worker to orchestrate runs.
- Use a web UI for run list, run detail, logs, artifacts, and failure reporting.
- Persist structured orchestration state separately from large artifact content.
- Keep SQLite for structured state in the MVP and filesystem storage for large artifacts.
- Model the domain around Run, Phase, Step, Loop, Agent Invocation, Artifact, Failure, Validation Result, and PR Review Comment.
- Enforce one active Run per GitHub issue.
- Record the start commit before each agent invocation so cancellation can restore the worktree safely.
- Capture structured events for run start, phase start, phase completion, artifact creation, failure detection, and run completion.
- Classify failures into explicit categories such as command failure, timeout, missing artifact, invalid result, branch drift, validation failure, GitHub failure, Git failure, and polling failure.
- Keep `opencode` as the initial and only agent runtime.
- Make post-PR review polling a managed job rather than an invisible background process.
- Migrate phase handlers from Bash into TypeScript gradually rather than rewriting everything at once.
- Use the project’s glossary terms consistently, especially Run, Phase, Step, Loop, Agent Invocation, and Artifact.
- Keep the core orchestration logic independent from GitHub CLI, Git, filesystem layout, and the UI.
- Favor deep modules that encapsulate workflow rules, failure classification, and resume safety behind small testable interfaces.

## Testing Decisions

- Good tests should verify external behavior: state transitions, failure classification, artifact handling, and resume/cancel safety.
- Good tests should avoid asserting internal implementation details like specific helper calls or file ordering unless that ordering is part of the contract.
- Test the run orchestration use cases, because they hold the workflow rules.
- Test failure classification, because users depend on accurate recovery guidance.
- Test agent contract validation, because missing artifacts and invalid results must fail deterministically.
- Test PR review comment tracking, because duplicate processing would create user-facing errors.
- Test resume and cancellation behavior, because these are the main recovery paths.
- Test adapter boundaries with fixtures where possible, especially filesystem artifacts and Git worktree behavior.
- Prior art should come from the existing Bash workflow and the project’s design decisions, then be reshaped into isolated TypeScript tests.

## Out of Scope

- Replacing GitHub.
- General-purpose workflow engine behavior.
- Distributed workers.
- Multi-tenant SaaS hosting.
- Automatic merging of pull requests.
- Fully rewriting all Bash logic before the MVP delivers value.
- Support for every possible agent runtime.
- Complex RBAC in the initial release.

## Further Notes

The near-term product goal is observability first, rewrite second.

The most valuable first slice is a wrapper that can start a run, persist its state, capture logs and artifacts, classify failures, and show a useful run detail view without changing the underlying Bash behavior yet.

## Agent skills

### Issue tracker

GitHub Issues via `gh` are the intake surface for automation work. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the automation labels: `ai:in-progress`, `ai:blocked`, `ai:failed`, `ai:needs-human-review`, `ai:pr-ready`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context. Read `CONTEXT.md`, relevant ADRs, and `docs/design-decisions-report.md`. See `docs/agents/domain.md`.
