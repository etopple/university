#!/usr/bin/env bash
# Build -> (schema step) -> deploy -> verify, for one environment.
#   bash scripts/infra/deploy.sh preview|production                 # = --code-only, the everyday deploy
#   bash scripts/infra/deploy.sh preview|production --migrate       # EmDash upgrade with new core migrations
#   bash scripts/infra/deploy.sh preview|production --load-content  # EMPTY database only (first load / cutover)
#
# Wrangler deploys never run D1 migrations, so every mode decides the schema question explicitly:
#   --code-only (default)  Ships code only. REFUSES unless the build's EmDash migration set equals the
#                          `_emdash_migrations` rows already in that D1, and the EmDash version equals the
#                          one recorded on the currently deployed Worker version. Touches no data.
#   --migrate              `emdash migrate` (status -> apply -> check) before deploy. Needs CLOUDFLARE_API_TOKEN
#                          (D1 Edit): EmDash's migrator does not use the wrangler login. Optional
#                          EMDASH_TARGET_FINGERPRINT for a non-interactive apply (CI).
#   --load-content         Builds the content lane's d1-load.sql (full migrated schema + migration records +
#                          every seed page, idempotent) and runs it with `wrangler d1 execute`. Overwrites seed
#                          pages: an EMPTY database only (preview before cutover, production once at cutover).
#                          Never touches users or API tokens. On production it refuses once the docs
#                          table exists (FORCE_RELOAD=1 overrides, to rebuild from zero only).
# Every deploy is tagged with the EmDash version (--message "emdash=<version> ..."); --code-only reads it back.
#
# The env is chosen at BUILD time (CLOUDFLARE_ENV): @astrojs/cloudflare writes a flattened
# dist/server/wrangler.json for that env and `wrangler deploy` follows it, so deploy takes
# no --env. Commands that read wrangler.jsonc directly get --config + --env.
set -euo pipefail

ENV="${1:?usage: deploy.sh preview|production [--code-only|--migrate|--load-content]}"
MODE="${2:---code-only}"
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
    read -r -p "Deploy PRODUCTION ($MODE)? type 'production' to continue: " ok
    [[ "$ok" == "production" ]] || { echo "aborted"; exit 1; } ;;
  *) echo "unknown env: $ENV" >&2; exit 2 ;;
esac

echo "== build ($ENV)"
npm run build
built=$(node -e "console.log(require('./dist/server/wrangler.json').name)")
want=$([[ "$ENV" == preview ]] && echo university-emdash-preview || echo university-emdash)
[[ "$built" == "$want" ]] || { echo "build targeted $built, expected $want" >&2; exit 1; }

EMDASH_VERSION=$(node -p "require('./.emdash/migrations.json').emdashVersion")
d1json() { npx wrangler d1 execute DB "${CFG[@]}" --remote --json --command "$1" 2>/dev/null; }

case "$MODE" in
  --code-only)
    echo "== code-only guard ($ENV): EmDash $EMDASH_VERSION"
    # 1. Migration set in the build vs rows in the target D1.
    d1json "SELECT name FROM _emdash_migrations" > .wrangler-migrations.json       || { echo "REFUSED: could not read _emdash_migrations (empty database? use --load-content)" >&2; exit 1; }
    node -e "
      const built = require('./.emdash/migrations.json').migrationSet.names;
      const inDb = JSON.parse(require('fs').readFileSync('.wrangler-migrations.json','utf8'))[0].results.map(r => r.name);
      const pending = built.filter(n => !inDb.includes(n)), unknown = inDb.filter(n => !built.includes(n));
      const list = a => a.slice(0, 5).join(', ') + (a.length > 5 ? ' (+' + (a.length - 5) + ' more)' : '');
      console.log('migrations: build ' + built.length + ', database ' + inDb.length);
      if (pending.length) console.error('REFUSED: ' + pending.length + ' pending migration(s): ' + list(pending) + ' -> use --migrate');
      if (unknown.length) console.error('REFUSED: database has ' + unknown.length + ' migration(s) this build does not know (' + list(unknown) + ') -> older EmDash than what migrated it?');
      process.exit(pending.length || unknown.length ? 1 : 0);"
    rm -f .wrangler-migrations.json
    # 2. EmDash version on the currently deployed Worker version (from its deploy message).
    deployed_ver=$(CFGS="${CFG[*]}" node -e "
      const {execSync} = require('child_process');
      const sh = c => execSync(c, {stdio: ['ignore', 'pipe', 'ignore']}).toString();
      try {
        const deps = JSON.parse(sh('npx wrangler deployments list --json ' + process.env.CFGS));
        const vid = deps[deps.length - 1].versions[0].version_id;
        const v = JSON.parse(sh('npx wrangler versions view ' + vid + ' --json ' + process.env.CFGS));
        const m = (v.annotations || {})['workers/message'] || '';
        const hit = /emdash=(\S+)/.exec(m); console.log(hit ? hit[1] : 'untagged');
      } catch { console.log('none'); }")
    echo "deployed EmDash version: $deployed_ver"
    case "$deployed_ver" in
      none)     echo "REFUSED: no deployed version found; first deploy goes through --load-content or --migrate" >&2; exit 1 ;;
      untagged) echo "note: the deployed version predates version tagging; relying on the migration-set check" ;;
      "$EMDASH_VERSION") ;;
      *)        echo "REFUSED: build has EmDash $EMDASH_VERSION, deployed is $deployed_ver -> use --migrate" >&2; exit 1 ;;
    esac ;;
  --load-content)
    if [[ "$ENV" == production ]]; then
      # After cutover, editors own the content: a reload would overwrite their edits.
      # Refuse while the prod database already holds pages (set FORCE_RELOAD=1 only to rebuild from zero).
      pages=$(npx wrangler d1 execute DB "${CFG[@]}" --remote --json --command "SELECT count(*) AS n FROM sqlite_master WHERE name = 'ec_docs'" 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(String(JSON.parse(s)[0].results[0].n))}catch{process.stdout.write('?')}})")
      if [[ "$pages" != "0" && "${FORCE_RELOAD:-}" != "1" ]]; then
        echo "production D1 already has content (or could not be checked: '$pages'); refusing --load-content. FORCE_RELOAD=1 overrides." >&2
        exit 1
      fi
    fi
    echo "== load schema + content into D1 ($ENV)"
    rm -f data.db data.db-shm data.db-wal   # seed mints fresh IDs; start clean so the menu re-points by slug
    npx emdash seed --on-conflict update
    node scripts/emdash/d1-sql.mjs
    npx wrangler d1 execute DB "${CFG[@]}" --remote --yes --file scripts/emdash/out/d1-load.sql ;;
  --migrate)
    : "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN (D1 Edit) for --migrate}"
    echo "== migration status ($ENV)"
    # --status may exit non-zero when work is pending; the apply step decides.
    npx emdash migrate --status --wrangler-config wrangler.jsonc ${MENV[@]+"${MENV[@]}"} || true
    echo "== apply migrations ($ENV)"
    if [[ -n "${EMDASH_TARGET_FINGERPRINT:-}" ]]; then
      npx emdash migrate --wrangler-config wrangler.jsonc ${MENV[@]+"${MENV[@]}"}         --expected-target-fingerprint "$EMDASH_TARGET_FINGERPRINT"
    else
      npx emdash migrate --wrangler-config wrangler.jsonc ${MENV[@]+"${MENV[@]}"}
    fi ;;
  *) echo "unknown option: $MODE (use --code-only, --migrate or --load-content)" >&2; exit 2 ;;
esac

echo "== deploy ($ENV)"
npx wrangler deploy --message "emdash=$EMDASH_VERSION mode=${MODE#--} commit=$(git rev-parse --short HEAD)"

echo "== verify"
if [[ "$MODE" == --migrate ]]; then
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
