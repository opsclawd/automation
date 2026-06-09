#!/usr/bin/env bash
set -euo pipefail
# Simulates a SUCCESSFUL agent run (exit 0, makes a commit) whose transcript —
# captured by opencode on the process stderr — includes a `git log` line that
# happens to contain "429" (e.g. commit #245's title). This must NOT be
# misclassified as a provider/quota error and discard the completed work (#250).
echo "fake opencode success"
git commit --allow-empty -q -m "feat: do the thing (#250 task)"
echo "9252bab fix: scope 429 error pattern to HTTP contexts to avoid bats false positives (#245)" >&2
exit 0
