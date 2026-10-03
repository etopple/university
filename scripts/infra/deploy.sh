#!/usr/bin/env bash
# Build -> put the D1 schema in place explicitly -> deploy -> verify, for one environment.
#   bash scripts/infra/deploy.sh preview [--load-content]
#   bash scripts/infra/deploy.sh production [--load-content]   # lead only, at cutover
#
# Wrangler deploys never run D1 migrations, so this script applies EmDash's core schema
# itself before the new code takes traffic. Two ways, pick per run:
#   --load-content   First load (or re-load) of an empty or pre-cutover database: builds the
#                    content lane's d1-load.sql (full migrated schema + migration records +
#                    every page, idempotent) and runs it with `wrangler d1 execute`.
#                    Uses your wrangler login. Overwrites pages with the seed: PRE-CUTOVER ONLY.
#   (default)        `emdash migrate` (status -> apply -> check). Needs CLOUDFLARE_API_TOKEN
#                    (D1 Edit) because EmDash's migrator does not use the wrangler login.
#                    Optional EMDASH_TARGET_FINGERPRINT for a non-interactive apply (CI).
#
# The env is chosen at BUILD time (CLOUDFLARE_ENV): @astrojs/cloudflare writes a flattened
# dist/server/wrangler.json for that env and `wrangler deploy` follows it, so deploy takes
# no --env. Commands that read wrangler.jsonc directly get --config + --env.
set -euo pipefail

ENV="${1:?usage: deploy.sh preview|production [--load-content]}"
MODE="${2:-migrate}"
export CLOUDFLARE_ACCOUNT_ID="44c7bfb7295ae9cd6050e09af901a4de"
cd "$(dirname "$0")/../.."

case "$ENV" in
  preview)
    export CLOUDFLARE_ENV=preview
    CFG=(--config wrangler.jsonc --env preview); MENV=(--wrangler-env preview)
    URL="https://university-emdash-preview.williampote.workers.dev" ;;
  production)
    unset CLOUDFLARE_ENV
    CFG=(--config wrangler.jsonc); MENV=()
    URL="https://university-emdash.williampote.workers.dev"
    read -r -p "Deploy PRODUCTION (lead only, at cutover)? type 'production' to continue: " ok
    [[ "$ok" == "production" ]] || { echo "aborted"; exit 1; } ;;
  *) echo "unknown env: $ENV" >&2; exit 2 ;;
esac

echo "== build ($ENV)"
npm run build
built=$(node -e "console.log(require('./dist/server/wrangler.json').name)")
want=$([[ "$ENV" == preview ]] && echo university-emdash-preview || echo university-emdash)
[[ "$built" == "$want" ]] || { echo "build targeted $built, expected $want" >&2; exit 1; }

case "$MODE" in
  --load-content)
    if [[ "$ENV" == production ]]; then
      # After cutover, editors own the content: a reload would overwrite their edits.
      # Refuse while the prod database already holds pages (set FORCE_RELOAD=1 only to rebuild from zero).
      pages=$(npx wrangler d1 execute DB "${CFG[@]}" --remote --json --command "SELECT count(*) AS n FROM sqlite_master WHERE name = 'ec_docs'" 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s)[0].results[0].n)}catch{console.log('?')}})")
      if [[ "$pages" != "0" && "${FORCE_RELOAD:-}" != "1" ]]; then
        echo "production D1 already has content (or could not be checked: '$pages'); refusing --load-content. FORCE_RELOAD=1 overrides." >&2
        exit 1
      fi
    fi
    echo "== load schema + content into D1 ($ENV)"
    rm -f data.db data.db-shm data.db-wal   # seed mints fresh IDs; start clean so the menu re-points by slug
    npx emdash seed --on-conflict update
    node scripts/emdash/d1-sql.mjs
    npx wrangler d1 execute DB "${CFG[@]}" --remote --yes --file scripts/emdash/out/d1-load.sql
    LOADED=1 ;;
  migrate)
    : "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN (D1 Edit), or use --load-content pre-cutover}"
    echo "== migration status ($ENV)"
    # --status may exit non-zero when work is pending; the apply step decides.
    npx emdash migrate --status --wrangler-config wrangler.jsonc ${MENV[@]+"${MENV[@]}"} || true
    echo "== apply migrations ($ENV)"
    if [[ -n "${EMDASH_TARGET_FINGERPRINT:-}" ]]; then
      npx emdash migrate --wrangler-config wrangler.jsonc ${MENV[@]+"${MENV[@]}"} \
        --expected-target-fingerprint "$EMDASH_TARGET_FINGERPRINT"
    else
      npx emdash migrate --wrangler-config wrangler.jsonc ${MENV[@]+"${MENV[@]}"}
    fi ;;
  *) echo "unknown option: $MODE" >&2; exit 2 ;;
esac

echo "== deploy ($ENV)"
npx wrangler deploy

echo "== verify"
if [[ "$MODE" == migrate ]]; then
  npx emdash migrate --check --wrangler-config wrangler.jsonc ${MENV[@]+"${MENV[@]}"}
fi
# Every sidebar page link must point at a real page (a re-seed mints new IDs; d1-sql.mjs re-points by slug).
counts=$(npx wrangler d1 execute DB "${CFG[@]}" --remote --json --command \
  "SELECT (SELECT count(*) FROM ec_docs) AS docs, (SELECT count(*) FROM _emdash_migrations) AS migrations, (SELECT count(*) FROM _emdash_menu_items WHERE type='page') AS page_links, (SELECT count(*) FROM _emdash_menu_items WHERE type='page' AND reference_id IN (SELECT id FROM ec_docs)) AS page_links_ok")
echo "$counts" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s)[0].results[0];console.log('D1:',JSON.stringify(r));process.exit(r.page_links===r.page_links_ok&&r.page_links>0?0:3)})" \
  || { echo "VERIFY FAILED: sidebar page links do not all resolve" >&2; exit 1; }

probe() { curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "$1"; }
fail=0
# Fresh workers.dev routes can 404 for a few seconds after deploy: retry.
for i in 1 2 3 4 5 6; do
  read -r code _ <<<"$(probe "$URL/")"
  [[ "$code" == "200" ]] && break; sleep 5
done
echo "public /                        -> $code (want 200)"; [[ "$code" == "200" ]] || fail=1
read -r st _ <<<"$(probe "$URL/api/search?q=vpn")"
echo "public /api/search?q=vpn        -> $st (want 200)"; [[ "$st" == "200" ]] || fail=1
# Admin UI and API must both bounce to Access. A 401 from EmDash itself is NOT proof that
# Access is in front, so only a 302 to the eTop team domain passes. Unauthenticated probes
# stop at Access, so they cannot become the first (Admin) EmDash user.
for path in /_emdash/admin /_emdash/api/content/docs; do
  read -r st loc <<<"$(probe "$URL$path")"
  echo "unauthenticated $path -> $st ${loc:0:60}"
  [[ "$st" == "302" && "$loc" == https://etoptech.cloudflareaccess.com/* ]] || fail=1
done
if [[ $fail -ne 0 ]]; then echo "VERIFY FAILED: see lines above" >&2; exit 1; fi
echo "VERIFY OK"
