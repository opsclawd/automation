# Product Requirements Document: AI Agent SDLC Orchestrator

**Document status:** Draft  
**Generated:** 2026-05-13  
**Owner:** Gary Poon Tip  
**Initiative:** AI-agent SDLC orchestration, observability, and recovery platform

---

## 1. Product Overview

### Product Name

**AI Agent SDLC Orchestrator**

### Summary

AI Agent SDLC Orchestrator is a single-tenant local/VPS AI SDLC orchestrator for manually starting issue-to-PR runs across approved GitHub repositories. It runs as a Node/TypeScript backend with a browser UI, executes multiple Repositories concurrently while enforcing one active Worker per Repository, and supports interchangeable agent runtime adapters (initially OpenCode and Pi) behind a single `AgentPort` contract.

The system will evolve the current Bash-based automation into a structured, observable, resumable workflow that takes a GitHub issue through design, planning, implementation, validation, review/fix loops, PR creation, and post-PR review response automation.

It is not SaaS, not multi-user, not multi-machine, and not a generic workflow engine. Runs are always started manually by selecting a registered Repository and an issue number; the orchestrator never discovers issues automatically and never operates against unregistered repositories. See ADR-0001 and ADR-0008.

The existing workflow currently includes two Bash scripts:

1. `ai-run-issue-v2.sh` — a GitHub issue-to-PR orchestrator that handles issue intake, planning, implementation, validation, review/fix loops, compound documentation, PR creation, issue label updates, artifact archiving, and starting the post-PR review poller.
2. `ai-pr-review-poll.sh` — a PR review poller that checks for PR review comments, asks an agent to address them, pushes fixes, replies to review threads, and verifies the result.

---

## 2. Background

The current system automates a significant portion of the software delivery lifecycle using AI agents, GitHub issues, Git worktrees, GitHub CLI, `pnpm`, `opencode`, and Superpowers-style skills such as brainstorming, writing plans, subagent-driven development, requesting code review, and receiving code review.

The current issue-to-PR script follows this broad lifecycle:

```text
read_issue
→ plan-design
→ plan-write
→ implement
→ validate
→ review
→ fix-review
→ compound
→ create-pr
→ done
```

The current PR review poller extends the lifecycle after PR creation:

```text
poll PR
→ fetch review comments
→ filter already-processed comments
→ invoke receiving-code-review agent
→ fix valid comments
→ push commits
→ reply to review threads
→ verify commits/replies/build
→ repeat until max polls
```

Although powerful, the current Bash scripts are unstable and difficult to debug. Failures can occur prematurely, and diagnosing them requires manually inspecting logs, generated files, result files, branch state, validation output, review output, GitHub state, and agent behavior.

---

## 3. Problem Statement

The current AI SDLC automation is difficult to operate reliably because orchestration, state management, process execution, prompt construction, result extraction, GitHub integration, Git operations, validation, review loops, polling, and recovery logic are tightly coupled inside Bash scripts.

When a run fails, the user often needs to manually answer:

- Which phase was running?
- Which command failed?
- Did the agent fail, timeout, or violate its expected contract?
- Did the agent write the required artifact?
- Did validation fail?
- Did review findings remain unresolved?
- Did the agent switch branches?
- Did GitHub API calls fail?
- Did the PR review poller process comments correctly?
- Did the agent push commits and post replies?
- Can the run be resumed, retried, or must it be restarted?

The lack of structured run state, failure classification, artifact organization, and first-class workflow boundaries creates a slow feedback loop and makes the automation difficult to trust.

---

## 4. Product Vision

Build a user-friendly orchestration platform that makes AI-agent software delivery workflows observable, debuggable, resumable, and extensible.

The product should answer, at any point:

> What is running, what has completed, what failed, why did it fail, what artifacts exist, and what can I safely do next?

The long-term vision is an **AI-assisted issue-to-reviewed-PR lifecycle orchestrator** with visibility, verification, and recovery at every stage.

---

## 5. Goals

### 5.1 Primary Goals

1. **Improve debuggability**
   - Provide structured visibility into every run, phase, command, agent invocation, artifact, validation result, review finding, PR comment, and failure.

2. **Reduce premature-exit confusion**
   - Replace opaque Bash exits with classified failure reports and clear recovery guidance.

3. **Preserve existing workflow value**
   - Keep the existing Bash scripts usable initially.
   - Migrate orchestration incrementally to Node/TypeScript.

4. **Enable a web UI**
   - Provide real-time run status, logs, review output, validation output, prompts, stdout/stderr, artifacts, and retry/resume controls.

5. **Support resumability**
   - Persist explicit run state instead of relying only on inferred file presence.

6. **Make agent behavior auditable**
   - Store rendered prompts, stdout, stderr, exit codes, generated artifacts, result files, git diffs, validation logs, review outputs, PR review responses, and verification results.

7. **Support post-PR review automation**
   - Treat PR review polling, comment fixing, reply posting, and verification as first-class workflow stages.

8. **Create an extensible architecture**
   - Use Clean Architecture and lightweight Domain-Driven Design to separate workflow policy from infrastructure mechanisms.

---

### 5.2 Non-Goals

The initial product will not:

- replace GitHub;
- replace all existing agent tooling;
- become a general-purpose CI/CD platform;
- fully eliminate AI nondeterminism;
- guarantee every issue becomes a successful PR;
- support enterprise multi-tenant SaaS hosting;
- support complex RBAC in MVP;
- migrate all Bash logic before delivering value;
- automatically merge PRs;
- implement a full generic workflow engine before domain-specific orchestration is stable.

---

## 6. Target Users

### 6.1 Primary User: Automation Owner / Developer

A developer who runs AI-agent issue-to-PR automation and needs to diagnose failures quickly.

Needs:

- clear run timeline;
- phase-level logs;
- agent prompt/output visibility;
- failure classification;
- artifact browser;
- retry/resume guidance.

### 6.2 Secondary User: Reviewer

A developer or lead reviewing AI-generated PRs.

Needs:

- review findings;
- fix-loop history;
- validation status;
- PR review comment handling;
- final PR summary.

### 6.3 Secondary User: Prompt and Workflow Maintainer

A maintainer improving prompts, agent contracts, phase behavior, and workflow reliability.

Needs:

- prompt history;
- run comparison;
- structured agent results;
- failure patterns;
- model/skill performance visibility.

---

## 7. Current Workflow Summary

### 7.1 Issue-to-PR Workflow

The current `ai-run-issue-v2.sh` script performs the following high-level phases:

```text
read_issue
plan-design
plan-write
implement
validate
review
fix-review
compound
create-pr
done
```

The script fetches GitHub issue data, validates issue body sections, creates a branch/worktree, asks agents to generate design and plan documents, runs implementation tasks, validates the build, performs review/fix loops, writes compound documentation, creates a PR, updates issue labels, archives artifacts, and starts the PR review poller in the background.

### 7.2 Post-PR Review Workflow

The current `ai-pr-review-poll.sh` script performs the following high-level flow:

```text
poll PR
→ fetch review comments
→ filter already-processed comments
→ invoke receiving-code-review agent
→ fix valid comments
→ push commits
→ reply to review threads
→ verify commits/replies/build
→ repeat until max polls
```

The script stores processed comment IDs, uses a result file with values such as `ALL_DONE`, `NO_FIXES_NEEDED`, `PARTIAL`, and `BLOCKED`, and verifies that replies were posted and validation commands pass.

---

## 8. Proposed Solution

Build a single-tenant orchestration application backed by a Node/TypeScript backend with a browser UI. The same architecture runs locally on a developer machine (one API process + one Worker process) or on a single VPS (one API process + N Worker processes under systemd). Multi-machine distribution is out of scope.

Initial implementation should wrap the existing Bash scripts and improve observability. Over time, phase orchestration should migrate from Bash into TypeScript modules.

```text
Browser UI (Next.js)
  ↓
API (Fastify)
  ↓
Job Queue (SQLite)
  ↓
Worker Pool (1..N local processes)
  ↓
Repository Lease (one Worker per Repository)
  ↓
Run Executor
  ↓
Ports
    ├─ AgentPort
    │    ├─ OpenCodeAgentAdapter
    │    └─ PiAgentAdapter
    ├─ GitHubPort
    ├─ GitPort
    ├─ ValidationPort
    └─ ArtifactStore
  ↓
SQLite (WAL) + filesystem artifacts
```

Deployment modes:

- **Local mode** — API + one Worker run on the developer machine.
- **VPS mode** — API + N Worker processes run under systemd on a single VPS (`ai-orchestrator-api.service`, `ai-orchestrator-worker@N.service`). Tailscale-only or Cloudflare Access access is recommended. Single approved GitHub identity / token / app installation.

---

## 9. Architectural Approach

### 9.1 Clean Architecture Recommendation

The project should use **Clean Architecture** to separate workflow decisions from infrastructure execution details.

The core problem is not only that the current scripts are written in Bash. The deeper issue is that the scripts mix:

- workflow policy;
- shell command execution;
- GitHub state management;
- Git worktree management;
- prompt construction;
- agent invocation;
- result parsing;
- validation;
- artifact management;
- retry/resume behavior;
- logging and observability.

Clean Architecture should be used to keep the core orchestration model independent from:

- Bash scripts;
- specific agent runtimes (`opencode`, `pi`, …);
- GitHub CLI;
- Git;
- `pnpm`;
- SQLite/Postgres;
- filesystem artifacts;
- web API/UI.

Agent execution is exposed to the application layer as a single runtime-agnostic `AgentPort`. Concrete runtimes (initially OpenCode for frontier work, Pi for local Qwen work) are adapters behind that port. The orchestrator owns state, policy, contracts, validation, retry/resume, and failure classification. Runtime adapters only execute agent processes.

### 9.2 Lightweight DDD Recommendation

The project should use **DDD-lite** to define clear domain concepts, workflow boundaries, state transitions, and invariants.

DDD should be used for:

- naming;
- bounded contexts;
- domain model clarity;
- failure classification;
- state transitions;
- agent contracts;
- workflow invariants.

DDD should not be over-applied in MVP. Avoid premature complexity such as full CQRS, event sourcing, excessive aggregates, abstract factories everywhere, or a generic workflow engine before the domain-specific orchestration is stable.

---

## 10. Bounded Contexts

### 10.1 Issue-to-PR Orchestration

Responsible for:

- reading GitHub issues;
- validating issue structure;
- creating branches/worktrees;
- generating design documents;
- generating implementation plans;
- executing implementation tasks;
- running validation;
- running internal review/fix loops;
- writing compound documentation;
- creating PRs;
- updating issue state.

### 10.2 PR Review Automation

Responsible for:

- polling PR review comments;
- filtering already-processed comments;
- invoking the receiving-code-review agent;
- fixing valid reviewer feedback;
- pushing commits;
- replying to review threads;
- verifying commits, replies, and validation.

### 10.3 Observability and Run History

Responsible for:

- structured events;
- artifacts;
- logs;
- failures;
- metrics;
- timeline display;
- run state;
- retry/resume visibility.

### 10.4 Agent Execution and Contract Validation

Responsible for:

- prompt rendering;
- agent invocation;
- stdout/stderr capture;
- timeout handling;
- required artifact checks;
- result-file validation;
- branch-change detection;
- contract violation classification.

---

## 11. Ubiquitous Language

The project should consistently use the following terms:

- **Repository** — an approved/registered GitHub repository the orchestrator is allowed to run against.
- **Job** — a queued unit of orchestration work claimed by a Worker to execute one Run.
- **Worker** — a long-lived process that claims Jobs and executes Runs. One Worker handles at most one Job at a time.
- **WorkerLease** — a per-Repository lease held by exactly one Worker for the duration of an active Run.
- **Run** — a single workflow execution.
- **Issue Run** — a run that converts a GitHub issue into a PR.
- **PR Review Run** — a run that processes reviewer comments after PR creation.
- **Phase** — a major workflow stage, such as planning, validation, review, or PR creation.
- **Step** — a smaller unit within a phase.
- **Attempt** — one execution of a phase or step.
- **Loop** — a repeated review/fix cycle.
- **Agent Invocation** — one call to an AI agent CLI.
- **Agent Contract** — required outputs and rules an agent must satisfy.
- **Artifact** — a file generated or captured during the workflow.
- **Failure** — a classified issue that prevents normal continuation.
- **Validation Result** — result of build, lint, typecheck, test, or other verification command.
- **Review Finding** — an internal AI review issue.
- **PR Review Comment** — an external GitHub PR review comment.
- **Processed Comment** — a PR review comment already handled by the system.
- **Verification** — confirmation that expected side effects happened, such as commits pushed or replies posted.
- **Resume Point** — the safest state from which a failed run can continue.
- **Retry Policy** — rules defining whether a phase can be safely retried.
- **Human Review Gate** — a state requiring manual intervention before continuation.

---

## 12. Domain Invariants

The system should enforce these domain rules:

0a. A Run may only be started against an approved/registered Repository.
0b. Only one active Run may exist per (Repository, Issue) pair.
0c. Only one active WorkerLease may exist per Repository.
0d. A Worker must acquire the Repository's WorkerLease before preparing a worktree or executing any phase.
0e. Multiple Workers may execute Runs against different Repositories concurrently.
0f. Manual run start enqueues a Job; the API never executes the phase pipeline inline.

1. A run cannot be marked `passed` if any required phase failed.
2. A phase cannot complete without recording a structured result.
3. An agent phase with required artifacts fails if those artifacts are missing.
4. An agent phase with allowed result values fails if the result file contains an invalid value.
5. A branch change caused by the agent blocks automatic continuation.
6. A PR review comment cannot be processed twice unless explicitly retried.
7. A PR review run cannot mark a comment as replied without recording the reply attempt.
8. A validation phase must record each command result.
9. A max-loop-reached result must mark the run as `needs_human_review` or `failed`, not silently continue.
10. A run must retain enough artifacts to diagnose the latest failure.
11. Unsafe retries must require explicit user confirmation.
12. A managed PR review poll job must record poll count, next poll time, and terminal state.

---

## 13. Layered Architecture

### 13.1 Recommended Project Structure

```text
apps/
  web/
    Next.js UI

  api/
    HTTP API / SSE event stream

  worker/
    Executes orchestration jobs

packages/
  domain/
    Pure domain model
    No filesystem, no GitHub CLI, no DB, no agent runtime imports
    (no `opencode`, no `pi`, no `child_process`)

  application/
    Use cases / orchestration services
    Depends on domain interfaces

  infrastructure/
    Git adapter
    GitHub adapter
    Agent adapter
    Validation adapter
    Artifact store
    SQLite/Postgres repositories

  shared/
    Types, utilities, event schemas
```

A simpler MVP may use a single repository structure:

```text
src/
  domain/
  application/
  infrastructure/
  interfaces/
```

### 13.2 Domain Layer

The domain layer contains pure concepts and rules.

It should know about:

- runs;
- phases;
- attempts;
- artifacts;
- failures;
- validation results;
- review findings;
- PR review comments;
- agent contracts.

It should not know about:

- `gh pr view`;
- `git worktree add`;
- `opencode --model` or `pi run`;
- `pnpm test`;
- SQLite;
- Postgres;
- HTTP;
- React.

### 13.3 Application Layer

The application layer coordinates use cases.

Examples:

- `StartIssueRun`
- `ResumeRun`
- `RetryFailedPhase`
- `CancelRun`
- `RunAgentWithContract`
- `RunValidation`
- `ProcessPrReviewComments`
- `CreatePullRequest`

This layer decides:

- when to move from one phase to another;
- when to classify a failure;
- when a run needs human review;
- when retry is safe;
- when PR review comments should be skipped or processed.

### 13.4 Infrastructure Layer

The infrastructure layer contains external mechanisms.

Examples:

- `GitHubCliAdapter`
- `GitCliAdapter`
- `OpenCodeAgentAdapter` (implements `AgentPort`, frontier-model runtime)
- `PiAgentAdapter` (implements `AgentPort`, local Qwen runtime)
- `AgentRuntimeRouter` (resolves `AgentProfile` → adapter; handles fallback)
- `PnpmValidationAdapter`
- `FilesystemArtifactStore`
- `SqliteRunRepository`
- `PostgresRunRepository`
- `BashIssueRunAdapter`
- `BashPrReviewPollAdapter`

### 13.5 Interface Layer

The interface layer contains ways users and systems interact with the application.

Examples:

- REST API;
- Server-Sent Events stream;
- CLI commands;
- React UI;
- webhooks in future versions.

---

## 14. Ports and Adapters

The application layer should depend on interfaces, not concrete external tools.

Example ports:

```ts
// Runtime-agnostic. Concrete adapters (OpenCodeAgentAdapter, PiAgentAdapter)
// implement this interface. The application layer never imports a specific runtime.
export type AgentRuntimeKind = 'opencode' | 'pi';

export interface AgentProfile {
  runtime: AgentRuntimeKind;
  provider: string; // e.g. "anthropic", "local"
  model: string; // e.g. "claude-opus-4.7", "qwen3.6-27b"
  contextLimitTokens?: number;
  promptBudgetTokens?: number;
  outputBudgetTokens?: number;
  timeoutMinutes: number;
}

// Fallback is a routing concern (per-phase), not a profile property.
// See `phaseProfiles` in `.ai-orchestrator.json` (PRD §15.7).
export interface PhaseRoutingEntry {
  profile: string; // resolved AgentProfile name
  fallbackProfile?: string; // profile to escalate to on documented triggers
}

export interface AgentInvocationRequest {
  profile: string; // profile name; resolved via composition root
  promptPath: string;
  expectedArtifacts: string[];
  cwd: string; // worktree path
  // … plus run/phase/step identifiers for audit
}

export interface AgentInvocationResult {
  runtime: AgentRuntimeKind;
  provider: string;
  model: string;
  exitCode: number;
  durationMs: number;
  stdoutPath: string;
  stderrPath: string;
  resultJsonPath?: string;
  contractViolations: string[];
  outcome: 'success' | 'failed' | 'timeout' | 'contract_violation';
}

export interface AgentPort {
  invoke(input: AgentInvocationRequest): Promise<AgentInvocationResult>;
}

export interface GitHubPort {
  getIssue(issueNumber: number): Promise<GitHubIssue>;
  createPullRequest(input: CreatePullRequestInput): Promise<PullRequest>;
  listReviewComments(prNumber: number): Promise<PrReviewComment[]>;
  replyToReviewComment(commentId: number, body: string): Promise<void>;
}

export interface GitPort {
  createWorktree(input: CreateWorktreeInput): Promise<void>;
  currentBranch(cwd: string): Promise<string>;
  diff(input: DiffInput): Promise<string>;
  push(input: PushInput): Promise<void>;
}

export interface ArtifactStore {
  write(input: WriteArtifactInput): Promise<Artifact>;
  read(path: string): Promise<string>;
  list(runId: string): Promise<Artifact[]>;
}

export interface RunRepository {
  save(run: Run): Promise<void>;
  findById(id: string): Promise<Run | null>;
}
```

---

## 15. Core Concepts and Data Model

### 15.1 Run

```ts
type Run = {
  id: string;
  type: 'issue_to_pr' | 'pr_review';
  issueNumber?: number;
  prNumber?: number;
  branch?: string;
  baseBranch?: string;
  status:
    | 'queued'
    | 'running'
    | 'waiting'
    | 'passed'
    | 'failed'
    | 'cancelled'
    | 'blocked'
    | 'needs_human_review';
  currentPhase?: string;
  startedAt: string;
  completedAt?: string;
};
```

### 15.2 Phase

```ts
type Phase = {
  id: string;
  runId: string;
  name: string;
  status: 'pending' | 'running' | 'passed' | 'failed' | 'skipped' | 'blocked';
  attempt: number;
  startedAt?: string;
  completedAt?: string;
};
```

### 15.3 Agent Invocation

```ts
type AgentInvocation = {
  id: string;
  runId: string;
  phaseId: string;
  stepId?: string;
  profile: string; // resolved AgentProfile name
  runtime: 'opencode' | 'pi'; // recorded at invocation time
  provider: string;
  model: string;
  skill?: string;
  promptPath: string;
  stdoutPath: string;
  stderrPath: string;
  startCommitSha: string;
  endCommitSha?: string;
  exitCode?: number;
  durationMs?: number;
  timeoutMs: number;
  outcome?: 'success' | 'failed' | 'timeout' | 'contract_violation';
  contractViolations?: string[];
  resultJsonPath?: string;
  fallbackOfInvocationId?: string; // set when this invocation was a fallback escalation
};
```

### 15.4 Artifact

```ts
type Artifact = {
  id: string;
  runId: string;
  phaseId?: string;
  type:
    | 'prompt'
    | 'stdout'
    | 'stderr'
    | 'combined_log'
    | 'issue'
    | 'design'
    | 'plan'
    | 'implementation_log'
    | 'validation'
    | 'review'
    | 'fix_log'
    | 'diff'
    | 'result'
    | 'summary'
    | 'pr'
    | 'comment'
    | 'reply';
  path: string;
  createdAt: string;
};
```

### 15.5 Failure

```ts
type Failure = {
  runId: string;
  phase: string;
  step?: string;
  attempt?: number;
  kind:
    | 'command_failed'
    | 'timeout'
    | 'missing_artifact'
    | 'invalid_result'
    | 'agent_blocked'
    | 'agent_contract_violation'
    | 'branch_changed'
    | 'validation_failed'
    | 'github_failed'
    | 'git_failed'
    | 'polling_failed'
    | 'unknown';
  message: string;
  canRetry: boolean;
  suggestedAction: string;
  artifacts: string[];
};
```

### 15.6 Agent Contract

```ts
type AgentContract = {
  requiredArtifacts: string[];
  allowedResultValues?: string[];
  mustNotChangeBranch?: boolean;
  mustCreateCommit?: boolean;
  mustPush?: boolean;
  mustPostReplies?: boolean;
};
```

### 15.7 Agent Profile and Phase Routing Config

The `.ai-orchestrator.json` file gains an `agent` section that declares profiles and per-phase routing. The orchestrator resolves each phase to a profile, which resolves to a concrete runtime adapter. Specific provider/model strings are configurable examples, not hardcoded product commitments.

```json
{
  "agent": {
    "defaultProfile": "opencode-frontier",
    "profiles": {
      "opencode-frontier": {
        "runtime": "opencode",
        "provider": "anthropic",
        "model": "claude-opus-4.7",
        "timeoutMinutes": 60
      },
      "pi-qwen-local": {
        "runtime": "pi",
        "provider": "local",
        "model": "qwen3.6-27b",
        "contextLimitTokens": 64000,
        "promptBudgetTokens": 40000,
        "outputBudgetTokens": 8000,
        "timeoutMinutes": 30
      }
    },
    "phaseProfiles": {
      "plan-design": { "profile": "opencode-frontier" },
      "plan-write": { "profile": "opencode-frontier" },
      "implement": { "profile": "pi-qwen-local", "fallbackProfile": "opencode-frontier" },
      "validate": { "profile": "pi-qwen-local", "fallbackProfile": "opencode-frontier" },
      "review": { "profile": "opencode-frontier" },
      "fix-review": { "profile": "opencode-frontier" },
      "compound": { "profile": "pi-qwen-local", "fallbackProfile": "opencode-frontier" },
      "create-pr": { "profile": "opencode-frontier" },
      "pr-review-poll": { "profile": "opencode-frontier" }
    }
  }
}
```

**Phase keys match the shipped phase set.** During M4–M7 the canonical phase names are the ones emitted and consumed by current code — `review` and `fix-review` are two separate phases. Q2 / M8-01 / M8-06 describe a planned domain collapse into a single `review-fix` phase in M8; that rename is a coordinated change across config, code, and tests, **not** a runtime normalization concern. Until M8 lands, `phaseProfiles` keys must match the phase names actually emitted by Bash and consumed by `apps/web/src/lib/timeline.ts`. `resolveProfileForPhase(phaseName)` is therefore a direct lookup with no legacy-name remapping; an unknown phase name raises a typed `ConfigError` (no silent fallback to `defaultProfile`).

#### Routing policy

**Use Pi/Qwen (local, bounded) when all of the following hold:**

- expected change ≤ 3 files;
- context pack ≤ 35k–40k tokens;
- task is mechanical or already planned;
- validation failure is narrow;
- no major architecture decision is required.

**Use OpenCode/frontier for:**

- design and architecture;
- implementation planning;
- high-context review;
- PR review comment handling;
- complex or fuzzy fixes;
- any Pi/Qwen fallback after repeated failure;
- tasks involving reviewer-facing responses.

#### Promotion / fallback triggers

Escalate from Pi/Qwen to the configured `fallbackProfile` when any of the following occurs:

- Pi/Qwen fails twice on the same Step;
- a required artifact is missing;
- `result.json` is invalid;
- timeout;
- context budget exceeded;
- touched files exceed the expected limit;
- validation failure changes category between iterations;
- architectural ambiguity appears;
- reviewer-facing output is required.

Fallback is recorded: the escalated `AgentInvocation` references the failing invocation via `fallbackOfInvocationId`, and the event stream emits a `phase.fallback.escalated` event with the triggering reason.

---

## 16. MVP Scope

### 16.1 MVP Objective

Deliver a web dashboard and Node wrapper that make the current Bash-based workflow observable and easier to debug without requiring a full rewrite.

### 16.2 MVP Features

#### 1. Start Issue Run

Users can start an issue-to-PR run from the UI or CLI.

Inputs:

```json
{
  "issueNumber": 123,
  "baseBranch": "main",
  "agentProfile": "opencode-frontier"
}
```

`agentProfile` references a named profile in `.ai-orchestrator.json → agent.profiles`. The profile carries runtime (`opencode` or `pi`), provider, model, context/prompt/output budgets, and timeout. Specific provider/model strings shown anywhere in this PRD are configurable examples, not product commitments.

Acceptance criteria:

- System creates a unique run ID.
- System creates a run directory.
- System starts the existing issue-to-PR script.
- System captures stdout and stderr.
- System writes run metadata.

#### 2. Run List

The UI shall show recent runs.

Fields:

- run ID;
- type;
- issue number;
- PR number;
- branch;
- status;
- current phase;
- start time;
- duration;
- failure summary.

#### 3. Run Detail Dashboard

The UI shall show:

- run header;
- phase timeline;
- current phase;
- elapsed time;
- validation status;
- review loop count;
- PR link if created;
- post-PR review polling status if active.

#### 4. Structured Events

The system shall persist structured events to `events.jsonl`.

Example:

```json
{
  "runId": "issue-123-20260513-132300",
  "phase": "plan-write",
  "level": "info",
  "message": "Starting plan write phase",
  "timestamp": "2026-05-13T19:23:00.000Z"
}
```

Events should be emitted for:

- run started;
- phase started;
- phase completed;
- command started;
- command completed;
- command failed;
- agent started;
- agent completed;
- artifact created;
- failure detected;
- run completed.

#### 5. Live Logs

The UI shall display logs from:

- orchestrator stdout;
- orchestrator stderr;
- structured events;
- phase-specific logs;
- agent logs;
- validation logs;
- PR polling logs.

Users should be able to:

- filter by phase;
- filter by level;
- search logs;
- jump to latest;
- download logs.

#### 6. Artifact Browser

The UI shall group artifacts by run and phase.

Artifact examples:

- `issue.md`;
- `issue-comments.md`;
- `design.md`;
- `plan.md`;
- `implementation-log.md`;
- `validate.log`;
- `validation-status.txt`;
- `review.md`;
- `review-fix-log.md`;
- `compound.md`;
- `pr-summary.md`;
- `pr-url.txt`;
- `comments.json`;
- `reviews.json`;
- `poll.log`.

#### 7. Failure Report

When a run fails, the UI shall show:

- failed phase;
- failure kind;
- command or agent invocation;
- exit code;
- timeout status;
- missing artifact, if applicable;
- related prompt;
- stdout;
- stderr;
- suggested recovery action.

#### 8. Basic Retry and Resume Guidance

MVP shall provide:

- retry entire run;
- show manual resume command;
- show last known phase;
- show whether the failure appears safe to retry.

Full phase-level retry can be deferred to V2.

#### 9. Post-PR Review Poll Visibility

The UI shall show the status of PR review polling when the parent issue run starts the poller.

Display:

- PR number;
- branch;
- poll count;
- max polls;
- interval;
- next poll time if known;
- processed comment count;
- latest poll status;
- verification status.

---

## 17. V2 Scope

### 17.1 TypeScript Phase Orchestration

Move orchestration from Bash into TypeScript phase handlers.

Recommended migration order:

1. Node wrapper around Bash.
2. Structured event emission.
3. TypeScript agent runner.
4. TypeScript validation runner.
5. Git and GitHub adapters.
6. Review/fix loop.
7. PR review polling job.
8. Implementation task loop.
9. Full issue-to-PR orchestration.

### 17.2 Phase Retry and Resume

The UI shall support:

- retry failed phase;
- resume from last successful phase;
- resume from selected phase;
- cancel active run;
- mark run as needs human review;
- rerun validation;
- rerun review;
- rerun PR review poll.

### 17.3 Review/Fix Loop Visualization

The UI shall display internal review/fix loops as attempts:

```text
Review 1 → failed
Fix 1 → completed
Revalidation 1 → failed
Review 2 → unresolved
Fix 2 → completed
Revalidation 2 → passed
Review 3 → all resolved
```

### 17.4 Post-PR Review Automation

The PR review poller shall become a managed job instead of an unmanaged background process.

The system shall support:

- scheduled polling;
- durable poll state;
- processed comment tracking;
- comment-level status;
- agent assessment capture;
- reply body capture;
- commit verification;
- reply verification;
- build verification;
- retry failed comment processing.

### 17.5 Agent Contract Validation

Each agent phase shall have an explicit contract.

The orchestrator shall verify:

- required files exist;
- result files contain allowed values;
- branch did not change;
- commits were created when required;
- commits were pushed when required;
- replies were posted when required;
- validation passed when required.

---

## 18. Functional Requirements

### FR1: Create Issue Run

The system shall allow a user to start an issue-to-PR run.

Acceptance criteria:

- User can provide issue number.
- System validates required inputs.
- System creates run ID.
- System initializes run directory.
- System starts execution asynchronously.
- System shows run in UI.

### FR2: Create PR Review Run

The system shall allow a PR review poll run to be created manually or automatically after PR creation.

Acceptance criteria:

- PR number is required.
- Issue number is optional but linked when available.
- System records max polls and interval.
- System shows polling status in UI.
- System associates PR review run with parent issue run when applicable.

### FR3: Persist Run State

The system shall persist run state throughout execution.

Acceptance criteria:

- `run.json` or database record is created.
- Current phase is updated.
- Status survives process exit.
- Failure state is preserved.
- Completed runs show final status.

### FR4: Emit Structured Events

The system shall emit structured JSON events.

Acceptance criteria:

- Events include run ID, phase, level, message, timestamp.
- Events are append-only.
- UI can poll or stream events.
- Events exist for phase start, phase completion, artifact creation, command failure, agent failure, and run completion.

### FR5: Capture stdout and stderr Separately

The system shall capture stdout and stderr for every major process.

Acceptance criteria:

- stdout is saved as an artifact.
- stderr is saved as an artifact.
- exit code is recorded.
- duration is recorded.
- UI links logs to the relevant phase.

### FR6: Display Phase Timeline

The UI shall display a timeline of workflow phases.

Acceptance criteria:

- Pending, running, passed, failed, skipped, and blocked phases have distinct visual states.
- Clicking a phase shows related logs and artifacts.
- Failed phase is highlighted.
- Phase duration is visible.

### FR7: Display Failure Details

The UI shall display a structured failure report.

Acceptance criteria:

- Failure kind is shown.
- Phase and step are shown.
- Error message is shown.
- Related artifacts are linked.
- Suggested action is shown.
- Retry/resume options are shown where safe.

### FR8: Display Validation Results

The UI shall display validation results.

Acceptance criteria:

- Build, lint, typecheck, and test are shown separately where available.
- Each command has pass/fail status.
- stdout/stderr are accessible.
- Failed output is easy to find.

### FR9: Display Internal Review Findings

The UI shall display review output from the issue-to-PR workflow.

Acceptance criteria:

- Review markdown is visible.
- Findings can be grouped by severity when structured data is available.
- Fix-loop attempts are visible.
- Final review status is visible.

### FR10: Display PR Review Comments

The UI shall display post-PR review comments.

Acceptance criteria:

- Comment ID is visible.
- File path and line are visible.
- Reviewer username is visible.
- Comment body is visible.
- Processed/unprocessed status is visible.
- Agent action is visible when available.
- Reply status is visible.

### FR11: Track Processed PR Comments

The system shall avoid duplicate processing of PR review comments.

Acceptance criteria:

- Processed comment IDs are persisted.
- Repeated polls skip processed comments.
- UI shows processed status.
- Failed processing can be retried intentionally.

### FR12: Verify PR Review Processing

The system shall verify PR review processing.

Acceptance criteria:

- If code fixes were made, commits are verified.
- Replies are verified.
- Build/lint/test are verified.
- Verification results are visible in UI.

### FR13: GitHub Integration

The system shall integrate with GitHub.

Acceptance criteria:

- Issue metadata can be fetched.
- PR metadata can be fetched.
- Issue labels can be updated.
- PR URL is displayed.
- PR comments can be fetched.
- PR replies can be posted.
- PR state can be checked.

### FR14: Clean Architecture Boundaries

The system shall separate domain/application logic from infrastructure adapters.

Acceptance criteria:

- Domain models do not depend on GitHub CLI, Git, `pnpm`, agent CLIs, database clients, or HTTP frameworks.
- Application use cases depend on ports/interfaces.
- Infrastructure adapters implement those ports.
- Bash scripts are treated as infrastructure adapters during migration.

### FR15: Domain Invariant Enforcement

The system shall enforce core workflow invariants.

Acceptance criteria:

- Missing required artifacts produce `missing_artifact` failures.
- Invalid result files produce `invalid_result` failures.
- Branch changes produce `branch_changed` failures.
- Max loop exhaustion produces `needs_human_review` or `failed` state.
- Duplicate PR review comment processing is prevented by default.

---

## 19. Non-Functional Requirements

### NFR1: Reliability

The orchestrator must not lose run state if a command fails, an agent exits unexpectedly, or a process times out.

### NFR2: Observability

Every failure must produce enough artifacts to diagnose the issue without immediately rerunning.

### NFR3: Recoverability

Failed runs should be resumable or retryable where safe.

### NFR4: Extensibility

New phases, agents, validation commands, and review strategies should be easy to add.

### NFR5: Single-Tenant Local-or-VPS Operation

The orchestrator runs as a single process group on one machine. The deployment may be either local (developer machine, one API process + one Worker process) or VPS (one API process + N Worker processes under systemd). It uses Git, GitHub CLI, `pnpm`, and the configured agent runtimes (`opencode`, `pi`). Multi-machine distribution is out of scope.

### NFR6: Minimal Disruption

The MVP should wrap the current scripts before replacing them.

### NFR7: Auditability

Prompts, outputs, actions, replies, commits, and validation results should be retained for later inspection.

### NFR8: Testability

Application use cases should be testable without invoking real GitHub, Git, `pnpm`, or agent tools.

---

## 20. Storage Decision

### 20.1 MVP Storage

The MVP should use:

```text
SQLite + filesystem artifacts
```

SQLite should store structured metadata:

- repositories (registry of approved repos);
- jobs (queued/claimed/running/succeeded/failed/cancelled);
- workers (registered worker processes + heartbeats);
- worker_leases (one active lease per Repository);
- runs;
- phases;
- events;
- artifacts;
- failures;
- agent invocations (records selected profile, runtime, provider, model);
- validation results;
- PR review comments;
- processed comment IDs;
- retry/resume state.

SQLite runs in WAL mode with short transactions. Repository uniqueness on the active leases table makes the "one Worker per Repository" invariant a database-level guarantee.

The filesystem should store large artifacts:

- prompts;
- stdout logs;
- stderr logs;
- combined logs;
- markdown documents;
- diffs;
- validation logs;
- review outputs;
- JSON payloads.

### 20.2 Future Storage

SQLite remains acceptable while the orchestrator runs as a single process group on one machine (local or one VPS) — even with multiple local Worker processes. Postgres would only be considered if one of the following becomes a real requirement:

- multiple VPS machines (not currently planned);
- many concurrent Workers beyond what one SQLite file can comfortably serve;
- centralised backups / HA;
- remote team access with audit requirements;
- analytics / reporting workloads that contend with orchestrator writes.

These are future triggers, not current commitments. The data layer is implemented behind repository interfaces so SQLite can be replaced with Postgres without changing orchestration logic — but the roadmap does not switch to Postgres now.

---

## 21. Suggested Architecture

```text
Web UI
  React / Next.js
  shadcn/ui
  Tailwind

API / Backend
  Node.js
  TypeScript
  REST or RPC endpoints
  Server-Sent Events for live logs

Worker
  Run queue
  Bash supervisor initially
  TypeScript phase handlers over time

Application Layer
  Use cases
  Workflow orchestration
  Agent contract validation
  Failure classification

Domain Layer
  Runs
  Phases
  Failures
  Artifacts
  Agent contracts
  PR review comments
  Validation results

Infrastructure Layer
  AgentRuntimeRouter + Agent runtime adapters (OpenCode, Pi)
  Git adapter
  GitHub adapter
  Validation adapter
  Artifact adapter
  SQLite repositories (runs, phases, events, jobs, workers, worker_leases, repositories, agent_invocations)

Storage
  Filesystem for large artifacts (per-Repository repo cache + per-Run artifacts)
  SQLite (WAL) for orchestration metadata + job queue + worker leases
  Postgres only if multi-VPS, heavy contention, or HA become real (see §20.2)
```

### 21.1 VPS Filesystem Layout

When deployed under systemd on a VPS, the suggested layout is:

```text
/var/lib/ai-orchestrator/
  repos/
    owner__repo/
      bare.git/
      worktrees/
        issue-123-run-<runId>/
  runs/
    <runId>/
      prompts/
      logs/
      artifacts/
      diffs/
  orchestrator.sqlite
```

- One active worktree per repo lease.
- Repo cache (`bare.git`) and per-Run artifacts are stored in separate trees.
- Completed worktrees may be cleaned or archived.

---

## 22. Storage Layout

### 22.1 MVP Filesystem Layout

```text
.ai-runs/
  issue-123-20260513-132300/
    run.json
    events.jsonl
    failure.json
    stdout.log
    stderr.log

    phases/
      read_issue/
        attempt-1/
          stdout.log
          stderr.log
          result.json

      plan_design/
        attempt-1/
          prompt.md
          stdout.log
          stderr.log
          exit-code.txt
          design.md

      plan_write/
        attempt-1/
          prompt.md
          stdout.log
          stderr.log
          exit-code.txt
          plan.md

      validate/
        build.stdout.log
        build.stderr.log
        lint.stdout.log
        lint.stderr.log
        typecheck.stdout.log
        typecheck.stderr.log
        test.stdout.log
        test.stderr.log
        validation-result.json

      review/
        attempt-1/
          prompt.md
          code-review.md
          review-result.json

      fix_review/
        loop-1/
          fix-prompt.md
          fix.stdout.log
          fix.stderr.log
          revalidate.log
          rereview.md

      create_pr/
        pr-summary.md
        pr-url.txt

      post_pr_review/
        poll-1/
          comments.json
          reviews.json
          pr-diff.diff
          prompt.md
          stdout.log
          stderr.log
          result.json
          verification.json
```

### 22.2 Future Database Tables

Potential tables:

- `runs`
- `phases`
- `events`
- `artifacts`
- `failures`
- `agent_invocations`
- `validation_results`
- `review_findings`
- `pr_review_comments`
- `pr_review_replies`
- `processed_comment_ids`
- `jobs`
- `job_attempts`

---

## 23. API Requirements

### 23.1 Create Issue Run

```http
POST /api/runs
```

Request:

```json
{
  "type": "issue_to_pr",
  "issueNumber": 123,
  "baseBranch": "main",
  "agentProfile": "opencode-frontier"
}
```

Response:

```json
{
  "runId": "issue-123-20260513-132300",
  "status": "queued"
}
```

### 23.2 Create PR Review Run

```http
POST /api/pr-review-runs
```

Request:

```json
{
  "prNumber": 456,
  "issueNumber": 123,
  "parentRunId": "issue-123-20260513-132300",
  "maxPolls": 3,
  "pollIntervalSeconds": 300
}
```

Response:

```json
{
  "runId": "pr-456-review-20260513-140000",
  "status": "queued"
}
```

### 23.3 List Runs

```http
GET /api/runs
```

### 23.4 Get Run

```http
GET /api/runs/:runId
```

### 23.5 Get Run Events

```http
GET /api/runs/:runId/events
```

### 23.6 Stream Run Events

```http
GET /api/runs/:runId/events/stream
```

### 23.7 List Artifacts

```http
GET /api/runs/:runId/artifacts
```

### 23.8 Get Artifact Content

```http
GET /api/runs/:runId/artifacts/:artifactId
```

### 23.9 Cancel Run

```http
POST /api/runs/:runId/cancel
```

### 23.10 Retry Run

```http
POST /api/runs/:runId/retry
```

### 23.11 Resume Run

```http
POST /api/runs/:runId/resume
```

Request:

```json
{
  "fromPhase": "fix_review"
}
```

---

## 24. UX Requirements

### 24.1 Run List Page

The landing page shall show:

- recent runs;
- status;
- current phase;
- issue number;
- PR number;
- branch;
- duration;
- failure summary;
- created time;
- completed time.

### 24.2 Run Detail Page

The run detail page shall include:

#### Header

- run ID;
- run type;
- issue number;
- PR number;
- branch;
- status;
- current phase;
- PR URL.

#### Timeline

- read issue;
- design;
- plan;
- implementation;
- validation;
- review;
- fix review;
- compound;
- create PR;
- post-PR review.

#### Main Panel Tabs

- logs;
- events;
- artifacts;
- prompts;
- validation;
- review findings;
- PR comments;
- failures.

#### Actions

- cancel;
- retry;
- resume;
- open PR;
- open worktree;
- download run bundle;
- mark needs human review.

### 24.3 Failure View

The failure view shall answer:

- What failed?
- Where did it fail?
- Was it a command, agent, artifact, Git, GitHub, validation, or polling failure?
- Which files should be inspected?
- Can this be retried safely?
- What command or UI action should be used next?

### 24.4 PR Review Comment View

Each PR review comment shall display:

- comment ID;
- file path;
- line;
- reviewer;
- body;
- processed status;
- agent assessment;
- fix summary;
- reply body;
- reply posted status;
- verification status.

---

## 25. Failure Classification

The system shall classify failures into known categories.

```text
command_failed
timeout
missing_artifact
invalid_result
agent_blocked
agent_contract_violation
branch_changed
validation_failed
github_failed
git_failed
polling_failed
unknown
```

Each failure should include:

- phase;
- step;
- attempt;
- command if applicable;
- exit code if applicable;
- artifact links;
- suggested action;
- retry safety.

---

## 26. Testing Strategy

Clean Architecture and DDD-lite should make the system testable without shelling out to real external tools.

### 26.1 Unit Tests

Test domain rules and application use cases with fake ports.

Important scenarios:

- agent exits successfully but required artifact is missing;
- agent writes invalid result file;
- validation fails at build/lint/typecheck/test;
- branch changes after agent invocation;
- PR review comment was already processed;
- reply verification fails;
- commit verification fails;
- max fix loops reached;
- GitHub API temporarily unavailable;
- resume requested from unsafe phase.

### 26.2 Integration Tests

Test infrastructure adapters against controlled fixtures.

Examples:

- Git adapter against a temporary repo;
- filesystem artifact store against temporary directories;
- SQLite repository against temporary database;
- Bash wrapper against stub scripts;
- validation runner against fixture package scripts.

### 26.3 End-to-End Tests

Test full local workflows with mocked or sandboxed GitHub interactions where possible.

---

## 27. Success Metrics

### 27.1 Operational Metrics

- Reduce average time to diagnose a failed run by 70%.
- Reduce unknown failures by 80%.
- Increase successful resume rate.
- Reduce manual log spelunking.
- Reduce duplicate PR review replies.
- Increase percentage of failures with structured failure reports.

### 27.2 Product Metrics

- number of runs launched from UI;
- number of successful issue-to-PR runs;
- number of failed runs;
- number of resumed runs;
- number of PR review comments processed;
- number of review/fix loops completed;
- number of PRs created;
- number of runs marked needs human review.

---

## 28. Risks and Mitigations

### Risk 1: Rewriting too much too soon

A full rewrite could delay value and introduce new instability.

Mitigation:

- Start with a Node wrapper around the existing scripts.
- Add observability first.
- Migrate phase by phase.

### Risk 2: AI nondeterminism remains

Agents may ignore instructions, skip files, fail to write result files, or change branches.

Mitigation:

- Add explicit agent contracts.
- Validate required artifacts.
- Capture prompts and outputs.
- Classify contract violations.

### Risk 3: Unsafe retries

Rerunning phases may duplicate commits, PRs, comments, or labels.

Mitigation:

- Use run IDs.
- Track processed comments.
- Persist phase state.
- Mark retry safety per phase.
- Require confirmation for risky retries.

### Risk 4: Background poller invisibility

Unmanaged `nohup` polling processes are difficult to observe and cancel.

Mitigation:

- Convert PR review polling into a managed job.
- Persist poll state.
- Display poll status in UI.

### Risk 5: Artifact sprawl

Runs may generate many logs and files.

Mitigation:

- Standardize artifact layout.
- Add retention policy.
- Add run bundle download.
- Add artifact search/filtering.

### Risk 6: Over-engineering architecture

Applying Clean Architecture or DDD too dogmatically could slow delivery.

Mitigation:

- Use DDD-lite.
- Prioritize domain language, boundaries, ports, and testability.
- Avoid full CQRS/event sourcing/generic workflow engine in MVP.

---

## 29. Milestones

### Milestone 1: Observable Bash Wrapper — **Complete**

Goal:

Improve debugging without replacing current scripts.

Deliverables:

- Node CLI wrapper;
- run ID generation;
- run directory;
- stdout/stderr capture;
- `run.json`;
- `events.jsonl`;
- `failure.json`;
- basic run list UI;
- run detail UI with logs and artifacts.

Out of scope for M1: agent runtime/model metadata is not introduced here. If structured events happen to carry runtime/model labels (because the underlying script reports them), they are passed through; M1 does not own that data shape.

### Milestone 2: Structured Events in Bash — **Complete**

Goal:

Make phase progress visible.

Deliverables:

- Bash `emit_event` helper;
- phase start events;
- phase completion events;
- artifact-created events;
- failure events;
- UI timeline powered by events.

Out of scope for M2: M2 stays focused on observable Bash + structured events. Runtime/model fields may be emitted in events if available, but no runtime abstraction is introduced.

### Milestone 3: Domain/Application Foundation for VPS Workers and Runtime-Agnostic Agents

Goal:

Establish Clean Architecture and DDD-lite boundaries, including the seams required to safely run on a VPS with multiple Worker processes against multiple Repositories, **and** the runtime-agnostic agent abstraction. M3 creates the seams; it does not execute Pi or OpenCode and it does not yet start a real VPS worker pool.

Deliverables:

- domain types for `Repository`, `Job`, `Worker`, `WorkerLease`, `Run`, `Phase`, `Step`, `Loop`, `AgentInvocation`, `Artifact`, `Failure`, `AgentContract`, `AgentProfile`;
- `AgentRuntimeKind` (`opencode | pi`);
- `AgentProfile` (runtime, provider, model, context/prompt/output budgets, timeout). Fallback is a per-phase routing concern declared on `phaseProfiles` entries — not a profile field;
- runtime-agnostic `AgentPort`, `AgentInvocationRequest`, `AgentInvocationResult`;
- application ports: `RepositoryPort`, `JobQueuePort`, `WorkerRegistryPort`, `WorkerLeasePort`, `RunRepository`, `EventBus`, `AgentPort`, `GitHubPort`, `GitPort`, `ValidationPort`, `ArtifactStore`;
- application use case interfaces (StartIssueRun, ResumeRun, RetryFailedPhase, CancelRun, ClaimNextJob, AcquireRepoLease, ReleaseRepoLease);
- fake/in-memory implementations of every port (including `AgentPort`) for use in tests;
- composition root support for later resolution of configured runtime adapters and infrastructure implementations of the queue / worker / lease ports;
- invariants enforced in pure domain code: one active Run per (Repository, Issue), one active WorkerLease per Repository.

Acceptance:

- `packages/domain` and `packages/application` import no concrete runtime and no infrastructure (no `opencode`, no `pi`, no `child_process`, no SQLite, no CLI-specific infra).
- Tests can simulate multiple Repositories, multiple Workers, queued Jobs, and lease acquisition/release end-to-end using fakes only.
- Tests enforce one active Run per (Repository, Issue) and one active lease per Repository.
- Tests can wire fake `AgentPort` implementations end-to-end.

### Milestone 4: TypeScript Agent Runtime Layer

Goal:

Centralise every agent call into a single runtime-agnostic layer that captures prompts, stdout/stderr, exit codes, timeouts, selected profile/runtime/model, and validates the agent contract — regardless of which runtime executed the call.

Deliverables:

- `AgentInvocation` persistence model + DB table (records selected profile, runtime, provider, model, prompt path, stdout/stderr, timeout, artifacts, result, contract violations);
- `AgentRuntimeRouter` (profile lookup, runtime resolution, fallback);
- `OpenCodeAgentAdapter implements AgentPort` (frontier runtime);
- `PiAgentAdapter implements AgentPort` (local Qwen runtime, e.g. Qwen 3.6 27B with 64k context);
- prompt rendering and capture;
- stdout/stderr separation;
- exit code capture;
- timeout handling;
- per-phase `result.json` schemas and parsing;
- agent contract validation;
- missing artifact detection;
- agent failure classification;
- configured fallback from Pi/Qwen to OpenCode/frontier per phase profile.

All agent execution must be auditable through the same `AgentInvocation` record shape regardless of runtime.

### Milestone 5: TypeScript Validation Runner

Goal:

Replace brittle log parsing with structured command results. Validation-fix loops route through `AgentPort` and may use bounded Pi/Qwen profiles for narrow fixes, escalating to OpenCode on repeated failure.

Deliverables:

- command-by-command validation execution;
- build/lint/typecheck/test result JSON;
- validation UI;
- validation failure classification;
- validation-fix invocations called via `AgentPort` using the configured `phaseProfiles["validate"]` (validation-fix is a Loop _within_ the `validate` phase — agent calls inside that loop route through the `validate` entry; there is no separate `validate-fix` phase in the shipped phase set).

### Milestone 6: Managed PR Review Polling

Goal:

Replace unmanaged background PR polling with a visible, durable job. PR-review comment handling defaults to OpenCode/frontier and is invoked through `AgentPort`.

Deliverables:

- PR review run model;
- poll state;
- processed comment tracking;
- comment artifacts;
- reply verification;
- commit verification;
- validation verification;
- PR comment UI;
- PR-review-handling invocations called via `AgentPort` using the configured `phaseProfiles["pr-review-poll"]` (default: OpenCode/frontier).

### Milestone 7: TypeScript Review/Fix Loop

Goal:

Make internal review/fix loops debuggable and resumable, with per-iteration runtime routing.

Deliverables:

- review attempt tracking;
- fix attempt tracking;
- revalidation tracking;
- re-review result tracking;
- loop-level artifacts;
- max-loop failure behavior;
- per-iteration `AgentPort` invocation with phase-profile lookup; bounded fixes may use Pi/Qwen, with fallback to OpenCode on repeated failure or escalation triggers.

### Milestone 8: Full TypeScript Phase Orchestration

Goal:

Replace Bash control flow with a worker-driven TypeScript state machine. Workers claim queued Jobs, acquire repo leases, prepare worktrees, execute phases, persist state, and release leases. All phase handlers call `AgentPort.invoke(...)` and remain runtime-agnostic — they never name a concrete runtime.

Deliverables:

- `RunExecutor` consuming `JobQueuePort`, `WorkerLeasePort`, `RepositoryPort`, `GitPort`, `GitHubPort`, `AgentPort`, `ValidationPort`, `ArtifactStore`;
- worker lifecycle: claim Job → acquire repo lease → prepare worktree → execute phase registry → persist state after every transition → release lease;
- phase handlers (call `AgentPort.invoke(...)`, never `opencode` or `pi` directly);
- persisted phase state;
- resume from phase (respects lease and repo locks);
- retry failed phase;
- cancel run (kills agent process, resets worktree, releases lease);
- GitHub adapter;
- PR creation adapter;
- Bash scripts deprecated or reduced to compatibility wrappers.

---

## 30. Open Questions (Resolved)

1. **Failed validation blocks PR creation.** Validation is deterministic (configured commands in `.ai-orchestrator.json`). If validation fails, the Run stays in validate phase and retries or fails — no draft PRs.

2. **Both structured JSON and markdown.** `result.json` carries the pass/fail decision (orchestrator reads this). `review.md` carries human-readable findings (fix agent reads this). Two artifacts, different audiences.

3. **Split storage.** Orchestration metadata (prompts, result.json, logs) in `.ai-runs/<run-id>/`. Agent-consumable artifacts (design.md, plan.md) in `.ai/` within the worktree. `.ai/` is gitignored.

4. **SQLite immediately with hybrid approach.** Mutable status columns on Run/Phase/Step tables for fast reads. Append-only events table with rich metadata for observability. Filesystem for artifact content.

5. **Domain model supports concurrency (one Run per issue). MVP serializes.** The one-active-Run-per-issue invariant is enforced at domain level. The runner serializes execution as an MVP constraint, not a data model limitation.

6. **Resume from failed Step by default.** Trust prior steps' commits. User can choose "retry phase from scratch" as escape hatch. All failures treated equally for retry purposes (no transient/permanent classification in MVP).

7. **Prompts versioned via filesystem + git.** Prompt template files in a known directory, referenced by phase/step name. Git provides version history. Agent Invocation record stores prompt file path.

8. **Agent commits directly; orchestrator tracks.** `startCommitSha` recorded before each Agent Invocation. Branch safety verified after each invocation. On cancellation, worktree reset to startCommitSha.

9. **Automatic reply within the Run.** The pr-review-poll phase handles review comments automatically. Run reaches READY state when all reviews addressed. READY reactivates on new review activity.

10. **Run continues until PR merged or cancelled.** READY is a resting-but-not-terminal state. New review activity reactivates into RUNNING. Global timeout (configurable, default 7 days) transitions READY → CANCELLED.

11. **Configured explicitly in `.ai-orchestrator.json`.** Validation commands declared in config. Deterministic — same commit always produces same pass/fail. Orchestrator fails fast if config missing.

12. **Until PR merged, with READY resting state and global timeout.** Not bounded by poll count. Run lifecycle extends to merge. Timeout prevents indefinite lingering.

13. **SQLite (WAL). Swappable later via RunRepository port.** Single-tenant single-machine tool (local or one VPS). No planned migration to Postgres; future triggers documented in §20.2. Port abstraction makes it replaceable if needed.

14. **Multi-machine distribution is out of scope.** The orchestrator runs as a single process group on one machine (local or one VPS). A VPS deployment with multiple local Worker processes under systemd is supported because every process shares the same filesystem and SQLite file (see ADR-0008); horizontal scale across machines is not.

15. **Append-only observability events, not full event sourcing.** Mutable tables are source of truth for state. Events are an audit trail with rich metadata (`{ outcome, durationMs, commitSha, reason, loopIteration }`). No projections.

---

## 31. Recommended MVP Decision

Build the first version as a **single-tenant AI SDLC observability dashboard** runnable locally or on a single VPS.

Do not start with a full rewrite.

Recommended MVP architecture:

```text
Next.js UI
Node/TypeScript API
Node Bash supervisor
Existing ai-run-issue-v2.sh
Existing ai-pr-review-poll.sh
Filesystem artifact store
SQLite metadata store
Structured events
Artifact browser
Failure reports
Clean Architecture boundaries
DDD-lite domain vocabulary
```

The immediate value is to make the existing unstable automation understandable:

- launch run;
- see phase progress;
- inspect logs;
- inspect artifacts;
- see failure classification;
- understand what the agent did;
- know what to do next.

After MVP, migrate orchestration out of Bash one phase at a time.

---

## 32. Appendix: Migration Strategy Summary

### Phase 1: Observe Existing Scripts

- Wrap Bash scripts.
- Capture stdout/stderr.
- Persist events.
- Persist run state.
- Display artifacts.

### Phase 2: Establish Domain and Ports

- Define domain language.
- Add application use cases.
- Add ports/interfaces.
- Keep Bash as infrastructure.

### Phase 3: Port Stable Deterministic Work

- Validation runner.
- GitHub metadata fetching.
- Artifact management.
- Failure classification.

### Phase 4: Port Agent Execution

- Centralize agent calls.
- Save prompts and outputs.
- Validate agent contracts.
- Detect missing artifacts and invalid results.

### Phase 5: Port Review Loops and PR Polling

- Internal review/fix loops.
- Managed PR review polling.
- Comment tracking.
- Reply verification.

### Phase 6: Retire Bash Orchestration

- Replace Bash control flow with TypeScript use cases.
- Keep shell commands only as infrastructure adapter implementations.
- Preserve CLI compatibility if useful.
