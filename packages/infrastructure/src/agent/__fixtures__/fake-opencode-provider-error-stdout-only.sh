#!/usr/bin/env bash
set -euo pipefail
# Emits provider error text on stdout (not stderr) and clean stderr.
# Should NOT be classified as provider_error — only stderr should be scanned.
echo 'Task complete. Note: AI_APICallError should be handled with retry logic.'
echo 'no errors' >&2
exit 0