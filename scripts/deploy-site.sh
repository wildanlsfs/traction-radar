#!/usr/bin/env bash
# Upload the dashboard to the stack's S3 bucket and point it at the API.
# Usage: scripts/deploy-site.sh [stack-name]
set -euo pipefail
STACK="${1:-traction-radar}"
out() { aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
BUCKET="$(out SiteBucketName)"
API="$(out ApiUrl)"
API="${API%/}"
TMP="$(mktemp -d)"
cp -r web/. "$TMP/"
# Bake the API address in as the default, so the hosted dashboard works without opening Settings.
sed -i.bak "s#store.get(\"tr_api\", \"\")#store.get(\"tr_api\", \"$API\")#" "$TMP/app.js" && rm -f "$TMP/app.js.bak"
aws s3 sync "$TMP" "s3://$BUCKET" --delete
echo "Dashboard: $(out SiteUrl)"
echo "API:       $API"
