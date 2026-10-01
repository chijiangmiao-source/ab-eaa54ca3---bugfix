#!/usr/bin/env bash
# Thin wrapper so the smoke suite can run both locally (npm run smoke) and
# inside the Compose verify container.  BASE_URL selects the target.
set -euo pipefail
BASE_URL="${BASE_URL:-http://localhost:8080}"
exec node "$(dirname "$0")/smoke.js"
