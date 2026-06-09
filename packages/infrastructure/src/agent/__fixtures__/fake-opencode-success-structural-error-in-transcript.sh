#!/usr/bin/env bash
set -euo pipefail
# Simulates a SUCCESSFUL agent run (exit 0, makes a commit) that was working on
# error-handling code/fixtures, so its transcript — captured by opencode on the
# process stderr — contains a *structurally valid* opencode error log line
# (`ERROR …T… AI_APICallError …`). No session-log file is written (this is agent
# transcript content, not a real runtime diagnostic). It must NOT be classified
# as a provider error and discard the completed work (#250 layer 3).
echo "fake opencode success"
git commit --allow-empty -q -m "feat: update provider-error fixtures (#250 task 3)"
echo 'ERROR 2026-05-28T22:51:15.000Z +0ms service=llm {"name":"AI_APICallError","url":"https://crof.ai/v1/chat/completions","statusCode":500}' >&2
exit 0
