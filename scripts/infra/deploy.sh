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
  production) WENV=();              MENV=();                       URL="https://university-emdash.williampote.workers.dev"
    read -r -p "Deploy PRODUCTION (lead only, at cutover)? type 'production' to continue: " ok
    [[ "$ok" == "production" ]] || { echo "aborted"; exit 1; } ;;
  *) echo "unknown env: $ENV" >&2; exit 2 ;;
esac

: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN (D1 Edit + Workers Scripts Edit)}"

echo "== build"
npm run build

echo "== migration status ($ENV)"
# --status may exit non-zero when work is pending; the apply step below decides.
npx emdash migrate --status --wrangler-config wrangler.jsonc ${MENV[@]+"${MENV[@]}"} || true

echo "== apply migrations ($ENV)"
if [[ -n "${EMDASH_TARGET_FINGERPRINT:-}" ]]; then
  npx emdash migrate --wrangler-config wrangler.jsonc ${MENV[@]+"${MENV[@]}"} \
    --expected-target-fingerprint "$EMDASH_TARGET_FINGERPRINT"
else
  npx emdash migrate --wrangler-config wrangler.jsonc ${MENV[@]+"${MENV[@]}"}
fi

echo "== deploy ($ENV)"
npx wrangler deploy ${WENV[@]+"${WENV[@]}"}

echo "== verify"
npx emdash migrate --check --wrangler-config wrangler.jsonc ${MENV[@]+"${MENV[@]}"}
# Fresh workers.dev routes can 404 for a few seconds after deploy: retry.
probe() { # url -> "status location"
  curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "$1"
}
fail=0
for i in 1 2 3 4 5 6; do
  read -r code _ <<<"$(probe "$URL/")"
  [[ "$code" == "200" ]] && break; sleep 5
done
echo "public /                -> $code (want 200)"; [[ "$code" == "200" ]] || fail=1
# Admin UI must bounce to Access; the API must too (or be refused outright), never 200.
read -r st loc <<<"$(probe "$URL/_emdash/admin")"
echo "unauthenticated /_emdash/admin -> $st ${loc:-} (want 302 to etoptech.cloudflareaccess.com)"
[[ "$st" == "302" && "$loc" == *etoptech.cloudflareaccess.com* ]] || fail=1
read -r st loc <<<"$(probe "$URL/_emdash/api/content/docs")"
echo "unauthenticated /_emdash/api/content/docs -> $st ${loc:-} (want 302 to Access, or 401/403)"
[[ ( "$st" == "302" && "$loc" == *etoptech.cloudflareaccess.com* ) || "$st" == "401" || "$st" == "403" ]] || fail=1
if [[ $fail -ne 0 ]]; then echo "VERIFY FAILED: see lines above" >&2; exit 1; fi
echo "VERIFY OK"
