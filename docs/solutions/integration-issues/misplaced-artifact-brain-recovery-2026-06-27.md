---
title: Misplaced Artifact Remediation and Brain Directory Recovery Fallback
date: 2026-06-27
category: integration-issues
module: packages/infrastructure + packages/application
problem_type: integration_issue
component: agent-adapter
severity: medium
applies_when:
  - Agent writes required artifacts to a central/brain directory instead of the worktree
  - Orchestrator needs a safety net to recover misplaced artifacts from agent session history
tags:
  - missing-artifact
  - brain-recovery
  - path-safety
  - performance-bottleneck
  - stat-overhead
---

# Misplaced Artifact Remediation and Brain Directory Recovery Fallback

## Context

During agent runs (such as the compound phase), the agent runtime may write its output files (e.g., `compound.md`) to a central application-controlled "brain" directory (e.g. `brain/<runId>/compound.md`) instead of the local worktree workspace directory, triggering a `MISSING_REQUIRED_ARTIFACT` contract violation.

To resolve this issue, a two-layer remediation strategy was implemented:
1. **Prompt-based absolute path injection**: Injecting the absolute worktree path (`ctx.cwd`) as a template variable/context parameter (`cwd`) and updating prompt templates to reference `{{var:cwd}}/artifact.md`.
2. **Brain directory recovery fallback**: A safety net in the agent adapter (`AntigravityAgentAdapter`) that scans the central brain directory to recover and copy misplaced artifacts back to the workspace if the agent ignores the prompt instruction.

## Fallback Recovery Gaps & Lessons Learned

While the fallback recovery safety net successfully prevents contract violations, its initial design revealed several critical performance, safety, and correctness gaps:

### 1. Avoid $O(N \times M)$ Stat Overhead Under Load
In the recovery fallback pass, the adapter scans all entries in the brain root and performs `stat` operations to filter and sort directories by modification time (`mtime`). When done per missing artifact, this search scales quadratically as $O(N \times M)$ (where $N$ is the number of historical session directories and $M$ is the number of missing artifacts).
*   **Lesson**: Avoid re-traversing and sorting the entire central directory structure for each missing file. Cache directory listings and directory metadata (like sorted `mtime` maps) once per agent invocation.

### 2. Guard Against Slice Limit Bypasses in Uniqueness Checks
To control execution time under heavy historical load, directory scans are often sliced (e.g., only checking the 1000 most recent folders). However, a uniqueness guard designed to prevent recovering the wrong file might fail if a duplicate candidate exists in the 1001-st directory. Because the slice excludes it, the guard perceives the match as unique and returns it.
*   **Lesson**: Build a complete index of candidate files across all directories *before* applying the slice/limit, or query the global state to ensure the uniqueness constraint holds.

### 3. Standardize Path Safety Verification
Ad-hoc path traversal checks (e.g., checking if `resolvedCandidate.startsWith(resolvedBrainRoot + '/')` versus relative path comparisons checking for `..` or absolute paths) introduce inconsistency and potential security gaps.
*   **Lesson**: Abstract directory traversal and containment checks into a single, unified path verification helper (e.g., `isPathUnderDir(child, parent)`) and reuse it across all adapters, scratch writes, and recovery paths.

### 4. Mitigate Basename Collision Risks
Searching and recovering misplaced artifacts strictly by their filename (e.g., `basename(artifact)`) introduces ambiguity when a run expects multiple files with the same name in different subdirectories (e.g., `docs/readme.md` and `readme.md`). The recovery mechanism risks recovering the wrong file or copying the same candidate to both locations.
*   **Lesson**: Avoid flat basename-only resolution. Either preserve and match the relative subdirectory structure during recovery, or restrict fallback recovery to top-level/specific well-known artifacts.

### 5. Preserve Version Control & Session History
Using `renameSync` or moving files out of the brain/session directory removes them from the agent's internal workspace, which destroys session logs and hampers debugging.
*   **Lesson**: Use copy operations (e.g. `copyFileSync`) rather than moves to recover artifacts. This leaves files intact in the session directory, preserving historical run contexts.

## Related

- `docs/solutions/orchestrator/contract-validation-invariant-traps-2026-05-26.md` — validation of required artifacts
- `docs/solutions/integration-issues/adapter-artifact-paths-vs-orchestrator-expectations-2026-06-04.md` — adapter artifact layout
