#!/usr/bin/env bash
# no set -euo pipefail — exec sleep will exit on SIGTERM regardless; the
# fixture is intentionally minimal to verify timeout behavior
echo "starting"
exec sleep 30

