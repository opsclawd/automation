# Triage Labels

This repo uses automation-state labels, not the generic triage labels from the default skill set.

| Repo label | Meaning |
| --- | --- | --- |
| `ai:in-progress` | The issue run is actively running |
| `ai:blocked` | The run cannot continue without human input |
| `ai:failed` | The run failed |
| `ai:needs-human-review` | The run reached a state that needs manual review before continuing |
| `ai:pr-ready` | The PR is ready for review / follow-up |

When a skill mentions a generic triage role, map it to the closest repo label only if it truly reflects workflow state. Do not add generic labels unless the repo explicitly adopts them later.
