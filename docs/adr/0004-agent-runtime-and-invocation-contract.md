# Agent runtime and invocation contract

We treat `opencode` as the single agent runtime and require each invocation to produce a bounded, validated result.

## Considered Options

**Runtime support**: Multiple agent CLIs vs. one runtime. We chose `opencode` only. The current workflow already depends on it, and extra runtime abstraction adds indirection without near-term value.

**Invocation boundary**: Let phases talk directly to tools vs. wrap agent calls in a dedicated contract. We chose a clear `Agent Invocation` contract with prompt path, stdout/stderr capture, result validation, and structured exit metadata.

**Result shape**: Free-form output vs. typed result + artifact files. We chose typed `InvocationResult` plus filesystem artifacts. Prompt and result files remain inspectable and auditable.

**Start commit tracking**: Record the baseline only if cancellation is needed vs. record it at invocation start. We chose to capture `startCommitSha` before each invocation so cancellation can safely restore the worktree.

## Consequences

- Runtime changes are deliberate and explicit
- Invalid or missing artifacts fail fast instead of drifting silently
- Cancellation can restore a known-good worktree state
- Agent behavior stays easy to audit from files on disk
