# University EmDash: infrastructure

Source of truth for the Cloudflare side of eTop University on EmDash. `docs/BUILD.md` (owned by
the QA/docs lane) pulls its "Where it runs", "Deploy", "Rebuild from zero" and "Access" sections from here.

## Where it runs

EmDash 1.x deploys as a **Cloudflare Worker** (Astro `output: "server"` + `@astrojs/cloudflare`), not
Pages. Config: `wrangler.jsonc` at the repo root. Account: **eTop Technology** `44c7bfb7295ae9cd6050e09af901a4de`.

| | Production | Preview |
|---|---|---|
| Worker | `university-emdash` | `university-emdash-preview` (`--env preview`) |
| URL | `university-emdash.williampote.workers.dev`; `university.etop.tech` after cutover | `https://university-emdash-preview.williampote.workers.dev` |
| D1 (`DB`) | `university-emdash-db` `627de272-335b-45c0-b8a8-92b7063c6fe3` | `university-emdash-db-preview` `a0c481d0-42ef-4ddb-92eb-9aaa97b3aabd` |
| R2 (`MEDIA`) | `university-emdash-media` | `university-emdash-media-preview` |
| KV (`SESSION`, Astro sessions) | `university-emdash-session` `1b71a62ab53a43a0b55248bca303c933` | `university-emdash-session-preview` `7f9b5ba93b574bac9c318cb2c357a5a5` |
| `EMDASH_SITE_URL` (var) | `https://university.etop.tech` | the preview URL |
| Cron | `* * * * *` (scheduled publishing) | same |

All created 2026-10-02 (D1 location hint `wnam`). The old Pages project `etop-university` keeps serving
`university.etop.tech` until the lead's cutover; nothing here touches that DNS or custom domain.

Not used in v1: KV object cache (`CACHE`), the `LOADER` binding and sandboxed plugins, Hyperdrive, a public R2 domain
(media goes through EmDash's authenticated media route), Workers Cache.

## Secrets

Names only. Values live in Worker secrets, never in git, `wrangler.jsonc` or `astro.config.mjs`.

| Name | Envs | Source | Set with |
|---|---|---|---|
| `CF_ACCESS_AUDIENCE` | prod, preview (different values) | AUD tag of that env's Access app | `npx wrangler secret put CF_ACCESS_AUDIENCE [--env preview]` |
| `EMDASH_ENCRYPTION_KEY` | prod, preview | `npx emdash secrets generate` | `npx wrangler secret put EMDASH_ENCRYPTION_KEY [--env preview]` |
| `CLOUDFLARE_API_TOKEN` | operator shell / CI only | Scoped token: D1 Edit + Workers Scripts Edit on the eTop account | shell env, never a file |

`EMDASH_ENCRYPTION_KEY` only protects plugin settings of type `secret`; v1 installs no such plugin, so a lost key
loses nothing today. Once a plugin stores a secret, keep a recovery copy of the key outside Cloudflare.

## Access (editor and admin)

EmDash runs in **Cloudflare Access mode** (`access()` from `@emdash-cms/cloudflare`): in production Access is the
only way in, and EmDash re-validates the Access JWT on every `/_emdash` request (issuer, signature, audience).

- Team domain: **`etoptech.cloudflareaccess.com`**
- IdP: existing **Azure AD** (Entra) IdP `4d4216f7-e1e2-4a13-a848-5d94920ae2bc`
- Protected path: **`/_emdash`** and everything below it (admin UI *and* REST API; protecting only `/_emdash/admin` breaks the API).
- Public pages stay public: no Access app covers `/`.
- Policy (same as eTop Portal Admin): allow `email_domain = etoptechnology.com`, require login method = the Entra IdP. Session 12h, auto-redirect to Entra.
- Apps, one per env so a preview token cannot open prod:
  - **University EmDash admin (staff)**: `university.etop.tech/_emdash`, `university-emdash.williampote.workers.dev/_emdash`
  - **University EmDash admin PREVIEW (staff)**: `university-emdash-preview.williampote.workers.dev/_emdash`.
    Second policy on this app ONLY: **Service Auth**, include service token `university-e2e`, for the QA lane's
    editor E2E (sends `CF-Access-Client-Id/Secret` plus an EmDash admin API token as Bearer). The token secret goes
    in a GitHub Actions secret or Hudu, never in git. The prod app has no service-token policy.
- **Status 2026-10-02: NOT CREATED.** The create call was blocked by a permission check; it is waiting on BJ
  (ask `426fbe`). Until then the preview admin fails closed (EmDash rejects any request without a valid JWT).
- `preview_urls: false` in both envs: version-preview hostnames would be outside the Access app.
- New users are auto-provisioned on first Access login with EmDash's default role (Author, 30); the lead sets `roleMapping` in `astro.config.mjs`.

## Deploy

```bash
export CLOUDFLARE_API_TOKEN=...          # D1 Edit + Workers Scripts Edit
bash scripts/infra/deploy.sh preview      # build -> emdash migrate -> wrangler deploy --env preview -> verify
bash scripts/infra/deploy.sh production   # lead only, at cutover; asks you to type 'production'
```

**The D1 trap:** `wrangler deploy` never runs migrations. The script applies EmDash's core migrations explicitly
(`emdash migrate --wrangler-env …`) before deploying, then `emdash migrate --check` after. EmDash would also
auto-migrate on the first request, but the pipeline does not rely on that. For CI, run
`emdash migrate --status` once, review the target, and pass the printed fingerprint as `EMDASH_TARGET_FINGERPRINT`.
Content-model changes (collections and fields) are a separate step: see EmDash "Evolving a Deployed Site".

Build vs env: if the lead's build uses the `@cloudflare/vite-plugin` path (Astro writes a flattened
`dist/server/wrangler.json`), select the env at BUILD time with `CLOUDFLARE_ENV=preview` and drop `--env` at deploy.
Confirm on the first preview deploy and adjust `deploy.sh`.

Any binding added later (`CACHE`, `LOADER`, `IMAGES`) must be repeated under `env.preview`; bindings are not inherited.

Node: EmDash 1.1's registry-verification package wants Node `^22.22.2 || ^24.15 || >=26`; 22.22.0 warns.

## Health check

- `GET <url>/` returns 200 (public site, no login).
- `GET <url>/_emdash/admin` without a login returns 302 to `etoptech.cloudflareaccess.com`. A 200 here means Access is off: stop.
- `GET <url>/_emdash/api/content/docs` without a login: 302 to Access (or 401/403), never 200. This proves the Access path covers the API, not just the admin UI.
- `deploy.sh` runs all three and prints `VERIFY OK` / `VERIFY FAILED`. It fails until the Access apps exist, by design.
- `npx emdash migrate --check --wrangler-config wrangler.jsonc [--wrangler-env preview]` exits 0.
- `npx wrangler tail [--env preview]` shows the cron line `"* * * * *" … Ok` each minute.

## Rebuild from zero

```bash
export CLOUDFLARE_ACCOUNT_ID=44c7bfb7295ae9cd6050e09af901a4de
npx wrangler d1 create university-emdash-db --location wnam            # put the new UUID in wrangler.jsonc
npx wrangler d1 create university-emdash-db-preview --location wnam
npx wrangler r2 bucket create university-emdash-media
npx wrangler r2 bucket create university-emdash-media-preview
npx wrangler kv namespace create university-emdash-session             # put the new id in wrangler.jsonc
npx wrangler kv namespace create university-emdash-session-preview
# Access: create the two apps above (Zero Trust > Access > Applications), copy each AUD tag
npx wrangler secret put CF_ACCESS_AUDIENCE                 # prod AUD
npx wrangler secret put CF_ACCESS_AUDIENCE --env preview   # preview AUD
npx emdash secrets generate        # copy the emdash_enc_v1_... line, then paste it at each prompt:
npx wrangler secret put EMDASH_ENCRYPTION_KEY
npx wrangler secret put EMDASH_ENCRYPTION_KEY --env preview   # use a different generated key
bash scripts/infra/deploy.sh preview
# content: scripts/emdash/apply.mjs (content lane), then scripts/emdash/parity.mjs
```
