# Product Direction

**Document status:** Living product direction record  
**Owner:** Gary Poon Tip  
**Last updated:** 2026-06-02

## Product thesis

AI coding agents are becoming capable enough to produce useful pull requests, but they do not reliably operate themselves through real software delivery workflows.

The durable product opportunity is not another coding agent. It is a control plane that governs autonomous software delivery: routing work through explicit phases, assigning the right model/runtime to each phase, preserving state and artifacts, enforcing validation and review gates, and giving the operator safe retry/resume controls when the system fails.

AI SDLC Orchestrator exists to turn approved GitHub issues into reviewed pull requests with bounded human intervention and a complete operational record.

## Product category

AI SDLC Orchestrator is a **single-tenant AI software delivery control plane**.

It is closest to:

```text
Temporal / Buildkite / Airflow for AI coding agents,
focused specifically on GitHub issue-to-reviewed-PR delivery.
```

It is not positioned as:

- a general-purpose coding agent;
- an OpenCode wrapper;
- a generic workflow engine;
- a CI/CD replacement;
- a hosted multi-tenant SaaS product;
- a chat-first IDE assistant.

## Core user

The primary user is a developer/operator managing one or more GitHub repositories who wants to increase approved PR throughput without personally driving every planning, implementation, validation, review, and post-review repair step.

The initial product is built for one trusted operator, not a team, enterprise, or public SaaS environment.

## Core workflow

```text
Approved GitHub issue
→ enqueue run manually
→ acquire repository lease
→ execute configurable phase pipeline
→ plan/design
→ implementation plan
→ implementation
→ validation
→ internal review/fix loop
→ compound learning/documentation
→ PR creation
→ external PR review comment handling
→ ready for merge
```

The user manually chooses which repository and issue may run. After that, execution should be autonomous until the run reaches a terminal state or a human-review gate.

## Product wedge

The strongest wedge is not PR creation. Generic agents can create PRs.

The wedge is reliable operational control over the full lifecycle:

- phase-based pipelines that can evolve over time;
- explicit model/runtime assignment per phase;
- prompt, skill, and pipeline version visibility;
- durable run, phase, step, and attempt state;
- validation gates and review-bot gates;
- bounded review/fix loops;
- retry, resume, cancel, and recovery semantics;
- multi-repository scheduling with one active issue per repository;
- logs, artifacts, diffs, prompts, outputs, and failure records that survive process death.

The product should optimize for:

```text
approved PRs per human intervention hour
```

not raw number of generated PRs.

## Product invariants

These are product-level rules that should remain stable unless deliberately revised.

1. **Manual enqueue, autonomous execution**  
   The system does not discover arbitrary work on its own. The operator explicitly starts an approved repository + issue run. Once started, the system drives the pipeline.

2. **Approved repositories only**  
   The orchestrator only operates against registered repositories. It must never execute against arbitrary repo URLs.

3. **One active issue per repository**  
   Repo-scoped concurrency prevents branch/worktree contamination, merge conflict chaos, duplicate work, stale plans, and unsafe overlapping automation.

4. **Multiple repositories may run concurrently**  
   Scale first by running different repositories in parallel, not multiple issues in the same repository.

5. **The orchestrator owns workflow state**  
   Agent runtimes execute. They do not own lifecycle state, retry policy, phase transitions, recovery semantics, or the source of truth.

6. **Agents are interchangeable execution adapters**  
   OpenCode, Pi, Claude Code, Antigravity, or future runtimes should sit behind explicit ports/adapters. The product value is the control plane around them.

7. **Routing is explicit, not opaque**  
   Model/runtime selection is declared by phase profile and fallback rules. The system should not allow an LLM to silently choose arbitrary runtimes.

8. **Review bots are gates**  
   External code review bots are part of the delivery pipeline. Their comments should be fetched, classified, fixed, replied to, verified, and recorded as first-class orchestration state.

9. **Every phase is auditable**  
   A phase must leave behind enough information to answer what ran, why, with which config/model/prompt, what it changed, what it produced, how it failed, and what can safely happen next.

10. **Retry safety beats blind persistence**  
    Retry/resume actions must be explicit about whether they are safe, risky, idempotent, destructive, or require operator confirmation.

11. **The web UI is an operations console**  
    The UI should prioritize run control, logs, artifacts, diffs, validation output, review state, phase attempts, retry/resume controls, and repo queues. It is not primarily a chat interface.

12. **Commercial optionality is secondary**  
    The first product must accelerate the owner across real repositories. Team, enterprise, hosted, RBAC, and multi-machine versions are future-only considerations.

## Product focus (M1-M8 Implementation)

The system has matured from a Bash-based prototype into a robust TypeScript orchestrator. The core operational foundation is now complete:

1. **Structured Orchestration (RunExecutor)**
   - The TypeScript `RunExecutor` drives the canonical phase pipeline with explicit state transitions and artifact capture.
   - Pipeline configurations (prompts, model profiles, validation commands) are declarative and auditable.

2. **Durable Phase Attempts**
   - Every phase execution is recorded as a durable attempt with detailed metadata, logs, and artifacts.

3. **Repository Lease Scheduler**
   - The orchestrator enforces one active worker per repository via a `WorkerLease`, preventing worktree contamination while allowing cross-repository concurrency.

4. **Review Gate Abstraction**
   - Validation commands, internal review/fix loops, and external PR review comments are implemented as first-class gates.

5. **Failure Taxonomy**
   - Failures are classified into actionable categories (e.g., `validation_failed`, `agent_contract_violation`, `timeout`), providing clear recovery guidance.

6. **Retry and Resume Controls**
   - Precise controls exist for retrying failed phases, resuming from specific steps, and cancelling active runs safely.

7. **Operations UI and CLI**
   - A real-time dashboard and comprehensive CLI provide visibility into every aspect of the delivery pipeline.

## Model and runtime strategy

Model choice matters, but it is not the product.

The product should support cheap/strong/adversarial model assignment by phase:

| Work type                               | Preferred model class                                           |
| --------------------------------------- | --------------------------------------------------------------- |
| Issue intake, extraction, summarization | Cheap / local / small model                                     |
| Planning and architecture               | Strong reasoning model                                          |
| Implementation                          | Capable coding model with good edit reliability                 |
| Internal review                         | Cheap-to-medium reviewer or adversarial model depending on risk |
| PR review comment repair                | Strong implementation model with review context                 |
| Adversarial verification                | Skeptical reviewer model                                        |
| Reply drafting and routine summaries    | Cheap model                                                     |

The orchestrator should measure reliability by phase over time and allow model swaps without changing the core workflow engine.

## Deferred ambitions

Do not build these until the single-tenant control plane is dependable:

- automatic issue discovery;
- automatic merge;
- path-aware parallel issues inside one repository;
- multi-user RBAC;
- multi-tenant hosted SaaS;
- multi-machine distributed workers;
- generic arbitrary workflow engine capabilities;
- marketplace of agent runtimes;
- cost optimization dashboards beyond what is needed for operational decisions.

## Strategic risks

1. **Agent platforms absorb the shallow version**  
   GitHub, OpenCode, Codex, Claude Code, Cursor, Devin, and similar tools can own simple issue-to-PR automation. The product must stay focused on durable orchestration, governance, review gates, and recovery.

2. **Framework trap**  
   The project can drift into a generic workflow framework. That would destroy velocity. Stay anchored to GitHub issue-to-reviewed-PR delivery.

3. **Model-routing distraction**  
   Better routing improves cost and quality, but run reliability, observability, retry safety, and review-gate handling are the durable wedge.

4. **Prompt drift without versioning**  
   Changing prompts and skills without recording versions makes debugging and regression analysis impossible.

5. **Unsafe concurrency**  
   Parallelizing multiple issues in one repo too early will create contaminated branches, stale context, and difficult merge/review failures.

6. **UI as decoration**  
   A dashboard that merely displays logs is weak. The UI must become a control surface for safe operational decisions.

## Decision log

| Date       | Decision                                                              | Rationale                                                                                     | Revisit trigger                                                                                                   |
| ---------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 2026-06-02 | Position the product as an AI SDLC control plane, not a coding agent. | Coding agents commoditize; orchestration, state, gates, retries, and recovery are the wedge.  | If agent runtimes provide durable, configurable, model-routed, review-gated pipelines with equivalent visibility. |
| 2026-06-02 | Keep manual enqueue and autonomous execution.                         | Avoid unsafe arbitrary automation while preserving the leverage of end-to-end delivery.       | When repository policy, issue triage, and risk classification are mature.                                         |
| 2026-06-02 | Enforce one active issue per repository.                              | Prevent worktree/branch contamination, duplicate work, merge conflicts, and stale plans.      | When path-aware concurrency and conflict prediction are reliable.                                                 |
| 2026-06-02 | Scale across repositories before scaling within a repository.         | Multi-repo concurrency provides value with lower coordination risk.                           | When a single repo queue becomes the dominant bottleneck.                                                         |
| 2026-06-02 | Treat agent runtimes as adapters behind orchestration state.          | The orchestrator must own lifecycle state, retry policy, failure semantics, and auditability. | If one runtime becomes mandatory and provides all required control-plane semantics.                               |
| 2026-06-02 | Make review bots first-class gates.                                   | The valuable outcome is reviewed/approved PR throughput, not raw generated diffs.             | If human-only review replaces bot review or PR approval policy changes.                                           |

## Success metrics

The product should be judged by operational leverage, not agent novelty.

Primary metric:

```text
approved PRs per human intervention hour
```

Supporting metrics:

- percentage of runs reaching `READY` without manual fixes;
- average human actions per successful PR;
- average failed-run diagnosis time;
- retry success rate by phase;
- validation failure rate by model/profile;
- review-comment fix success rate;
- max-iteration exhaustion rate;
- stale lease / dead-run recovery count;
- cost per ready PR;
- time from issue enqueue to ready PR.

## Current product stance

Build for the owner first.

The product is worth continuing if it reliably turns well-scoped GitHub issues into reviewed PRs across multiple repositories with far less manual coordination than direct agent use.

External commercialization is optional. If pursued later, the commercial layer should add stronger isolation, policy controls, team permissions, hosted runners, organization-level auditability, and safer execution sandboxes. Those are not required to validate the core product.
