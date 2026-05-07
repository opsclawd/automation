#!/usr/bin/env bash
set -euo pipefail

LABELS=(
  "ai:plan-ready"
  "ai:in-progress"
  "ai:failed"
  "ai:pr-opened"
  "ai:done"
  "ai:blocked"
)

for label in "${LABELS[@]}"; do
  gh label create "$label" --description "AI automation label" 2>/dev/null || true
  echo "✓ $label"
done

echo "Labels setup complete."
