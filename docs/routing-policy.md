# Default Routing Policy

> **Status:** Initial — tune after collecting invocation telemetry.
> **Last updated:** 2026-05-26

## Overview

This document defines the default model routing policy for the AI SDLC orchestrator.
Routing is configured via `.ai-orchestrator.json` under the `agent.phaseProfiles` key.

## Phase-to-Profile Assignment

| Phase             | Default Profile     | Fallback Profile    | Rationale                                              |
| ----------------- | ------------------- | ------------------- | ------------------------------------------------------ |
| `plan-design`     | `opencode-frontier` | —                   | Requires strongest reasoning to decompose tasks        |
| `plan-write`      | `opencode-frontier` | —                   | Plan quality determines implementation success         |
| `implement`       | `pi-qwen-local`     | `opencode-frontier` | Mechanical task; fallback if local model fails         |
| `spec-review`     | `opencode-frontier` | —                   | Needs frontier to evaluate spec correctness            |
| `quality-review`  | `opencode-frontier` | —                   | Per-task code quality review inside the implement loop |
| `fix-review`      | `pi-qwen-local`     | `opencode-frontier` | Mechanical fixes are bounded; fallback for ambiguity   |
| `whole-pr-review` | `opencode-frontier` | —                   | Once-per-PR whole-branch diff review before merge      |
| `post-pr-review`  | `opencode-frontier` | —                   | Assessment of PR comments needs frontier reasoning     |
| `compound`        | `pi-qwen-local`     | `opencode-frontier` | Docs generation; cheap model sufficient                |
| `create-pr`       | `opencode-frontier` | —                   | PR creation requires correct formatting and content    |

## Fallback Triggers

Each phase profile entry can specify a `fallbackTriggers` array. Default triggers (when unset):

| Trigger              | Description                                          |
| -------------------- | ---------------------------------------------------- |
| `timeout`            | Agent exceeded the profile's `timeoutMinutes`        |
| `contract_violation` | Agent returned an invalid result or missing artifact |

Additional opt-in triggers (recommended for cheap-model phases):

| Trigger                     | Description                                 |
| --------------------------- | ------------------------------------------- |
| `missing_required_artifact` | Agent failed to produce a required artifact |
| `prompt_budget_exceeded`    | Agent exceeded prompt budget                |
| `invalid_result_json`       | Agent produced unparseable result.json      |

## Profile Tiers

| Tier               | Profiles                           | Use Case                                                              |
| ------------------ | ---------------------------------- | --------------------------------------------------------------------- |
| Frontier reasoning | `opencode-frontier` (Minimax-M2.7) | Planning, design, high-stakes review                                  |
| Frontier fast      | `opencode-fast` (MiniMax-T1)       | Review tasks needing frontier reliability but not strongest reasoning |
| Local bounded      | `pi-qwen-local` (Qwen 3.6-27B)     | Mechanical implementation, fixes, docs generation                     |

## Customizing Routing

To override per-repo, edit `.ai-orchestrator.json`:

```json
{
  "agent": {
    "phaseProfiles": {
      "implement": {
        "profile": "opencode-frontier",
        "fallbackTriggers": ["timeout", "contract_violation", "missing_required_artifact"]
      }
    }
  }
}
```

## Measuring Impact

Use the compare-runs CLI to compare routing strategies:

```
pnpm run compare-runs <run-id-a> <run-id-b>
```

Compare per-phase: model used, prompt tokens, duration, outcome.
