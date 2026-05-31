#!/usr/bin/env bash
# no set -euo pipefail — fixture deliberately ignores SIGTERM and trap + set -e
# can interfere with the exec'd sleep process and signal disposition
trap '' SIGTERM
echo "starting"
exec sleep 300

