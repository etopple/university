#!/usr/bin/env bash
# Build -> migrate D1 explicitly -> deploy -> verify, for one environment.
#   scripts/infra/deploy.sh preview      # university-emdash-preview Worker
#   scripts/infra/deploy.sh production   # university-emdash Worker (lead only, at cutover)
#
# Wrangler deploys never run D1 migrations, so this script applies EmDash's core
# migrations itself before the new code takes traffic, then checks nothing is pending.
#
# Needs: CLOUDFLARE_API_TOKEN (D1 Edit, Workers Scripts Edit) in the environment.
# Optional: EMDASH_TARGET_FINGERPRINT for a non-interactive apply (CI). Without it the
# apply is interactive and shows the target database before asking to confirm.
set -euo pipefail

ENV="${1:?usage: deploy.sh preview|production}"
export CLOUDFLARE_ACCOUNT_ID="44c7bfb7295ae9cd6050e09af901a4de"
cd "$(dirname "$0")/../.."

case "$ENV" in
  preview)    WENV=(--env preview); MENV=(--wrangler-env preview); URL="https://university-emdash-preview.williampote.workers.dev" ;;
  production) WENV=();              MENV=();                       URL="https://university-emdash.williampote.workers.dev" ;;
  *) echo "unknown env: $ENV" >&2; exit 2 ;;
esac

: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN (D1 Edit + Workers Scripts Edit)}"

echo "== build"
npm run build

echo "== migration status ($ENV)"
npx emdash migrate --status --wrangler-config wrangler.jsonc "${MENV[@]}"

echo "== apply migrations ($ENV)"
if [[ -n "${EMDASH_TARGET_FINGERPRINT:-}" ]]; then
  npx emdash migrate --wrangler-config wrangler.jsonc "${MENV[@]}" \
    --expected-target-fingerprint "$EMDASH_TARGET_FINGERPRINT"
else
  npx emdash migrate --wrangler-config wrangler.jsonc "${MENV[@]}"
fi

echo "== deploy ($ENV)"
npx wrangler deploy "${WENV[@]}"

echo "== verify"
npx emdash migrate --check --wrangler-config wrangler.jsonc "${MENV[@]}"
code=$(curl -s -o /dev/null -w '%{http_code}' "$URL/")
echo "public / -> $code (want 200)"
admin=$(curl -s -o /dev/null -w '%{http_code}' "$URL/_emdash/admin")
echo "/_emdash/admin unauthenticated -> $admin (want 302 to etoptech.cloudflareaccess.com, never 200)"
[[ "$code" == "200" && "$admin" != "200" ]]
