#!/usr/bin/env bash
set -euo pipefail

PACKAGE_JSON="package.json"

if [[ ! -f "$PACKAGE_JSON" ]]; then
  echo "No package.json found — skipping Node validation."
  exit 0
fi

echo "Detecting package manager..."
if [[ -f "pnpm-lock.yaml" ]]; then
  PKG_MGR="pnpm"
  INSTALL_CMD="pnpm install --frozen-lockfile"
elif [[ -f "yarn.lock" ]]; then
  PKG_MGR="yarn"
  INSTALL_CMD="yarn install --frozen-lockfile"
else
  PKG_MGR="npm"
  INSTALL_CMD="npm ci"
fi

echo "Using $PKG_MGR"

echo "Installing dependencies..."
$INSTALL_CMD

SCRIPTS=$(jq -r 'keys[]' "$PACKAGE_JSON" 2>/dev/null || echo "")

for cmd in typecheck lint test build; do
  if echo "$SCRIPTS" | grep -q "^${cmd}$"; then
    echo "Running $cmd..."
    case "$PKG_MGR" in
      pnpm)   pnpm "$cmd" ;;
      yarn)   yarn "$cmd" ;;
      npm)    npm run "$cmd" ;;
    esac
  else
    echo "Skipping $cmd (not defined)"
  fi
done

echo "Validation complete."
