#!/usr/bin/env bash
# Store secrets in SSM Parameter Store (SecureString, standard tier = free).
# Usage: scripts/set-secrets.sh [stage]   -- prompts for each value, never echoes it.
set -euo pipefail
STAGE="${1:-prod}"
for NAME in META_API_KEY ADMIN_TOKEN THREADS_TOKEN OPEN_WEIGHTS_API_KEY; do
  read -r -s -p "$NAME (empty = skip): " VALUE; echo
  [ -z "$VALUE" ] && continue
  aws ssm put-parameter --name "/traction-radar/$STAGE/$NAME" --type SecureString --value "$VALUE" --overwrite >/dev/null
  echo "  saved /traction-radar/$STAGE/$NAME"
done
