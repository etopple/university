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
| `EMDASH_SITE_URL` (var) | `https://university.etop.tech` (the prod Worker is first deployed at cutover, so it never runs on another origin) | the preview URL |
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
- Protected paths: **`/_emdash` and `/_emdash/*`** on every hostname. Both entries are needed: a bare `/_emdash` entry
  matches only that exact path (verified 2026-10-02: `/_emdash/admin` returned 404 unprotected until `/*` was added).
  Covering the API too matters; protecting only `/_emdash/admin` breaks the API.
- Public pages stay public: no Access app covers `/`.
- Policy (same as eTop Portal Admin): allow `email_domain = etoptechnology.com`, require login method = the Entra IdP. Session 12h, auto-redirect to Entra.
- Apps, one per env so a preview token cannot open prod:
  - **University EmDash admin (staff)** `39ca3545-7a40-4047-85c2-ab42a4b817d9`: `university.etop.tech/_emdash[/*]`, `www.university.etop.tech/_emdash[/*]` (added before cutover so `www` is never open), `university-emdash.williampote.workers.dev/_emdash[/*]`
  - **University EmDash admin PREVIEW (staff)** `ad705bef-5c98-49aa-80cc-e40fe3bd0d2b`: `university-emdash-preview.williampote.workers.dev/_emdash[/*]`.
    Second policy on this app ONLY: **Service Auth**, include service token `university-e2e`, for the QA lane's
    editor E2E (sends `CF-Access-Client-Id/Secret` plus an EmDash admin API token as Bearer). The token secret goes
    in a GitHub Actions secret or Hudu, never in git. The prod app has no service-token policy.
- **Status 2026-10-02: both apps CREATED** (BJ approved). Checked on the live hostname: `/_emdash`, `/_emdash/admin` and
  `/_emdash/api/...` all 302 to `etoptech.cloudflareaccess.com`; `/` stays 200. The AUD tags are not secret but are set as the
  `CF_ACCESS_AUDIENCE` Worker secret per env (read them from the app in Zero Trust). E2E service token
  `university-e2e` (id `b07a8b64-e2dc-4665-99e0-40b13f61d48e`, expires 2027-10-03) is CREATED (BJ approved) with policy
  "E2E service token (preview only)" (Service Auth) on the preview app; the prod app has only the staff policy (checked via API).
  Credentials: GitHub Actions secrets `UNIVERSITY_E2E_ACCESS_CLIENT_ID` / `UNIVERSITY_E2E_ACCESS_CLIENT_SECRET` on etopple/university.
  Renew before 2027-10-03 (Zero Trust > Access > Service credentials > Refresh) and update both secrets.
- `preview_urls: false` in both envs: version-preview hostnames would be outside the Access app.
- New users are auto-provisioned on first Access login with EmDash's default role (Author, 30); the lead sets `roleMapping` in `astro.config.mjs`.

## Deploy

```bash
bash scripts/infra/deploy.sh production                  # everyday code deploy (= --code-only)
bash scripts/infra/deploy.sh preview                     # same, preview
bash scripts/infra/deploy.sh <env> --migrate             # EmDash upgrade with new core migrations (CLOUDFLARE_API_TOKEN, D1 Edit)
bash scripts/infra/deploy.sh <env> --load-content        # empty D1 only: schema + migrations + all seed pages
```
`--code-only` refuses unless the build's migration set equals the D1's `_emdash_migrations` rows and the build's EmDash
version equals the `emdash=<version>` message on the deployed Worker version. Full detail: `docs/BUILD.md` > Deploy.

**The env is picked at build time.** `@astrojs/cloudflare` writes a flattened `dist/server/wrangler.json` for
`CLOUDFLARE_ENV` and `wrangler deploy` follows it, so deploy takes no `--env` (the script sets `CLOUDFLARE_ENV` and
checks the built Worker name). Commands that read `wrangler.jsonc` directly (`d1 execute`, `secret put`) need
`--config wrangler.jsonc --env preview`.

**The D1 trap:** `wrangler deploy` never runs migrations. The script puts the schema in place before deploying:
- `--load-content` runs the content lane's `scripts/emdash/out/d1-load.sql` (full migrated schema, all 90
  `_emdash_migrations` records, 118 pages, menu, FTS; idempotent). It overwrites pages with the seed, so use it pre-cutover only.
- The default runs `emdash migrate` (status, apply, check). EmDash's migrator ignores the wrangler login and needs
  `CLOUDFLARE_API_TOKEN` (D1 Edit). For CI, pass the reviewed fingerprint as `EMDASH_TARGET_FINGERPRINT`.
Content-model changes (collections and fields) are a separate step: see EmDash "Evolving a Deployed Site".

**First admin:** the first person through Access to open `/_emdash` becomes EmDash Admin. Make that a named eTop
person, not the E2E service token. Unauthenticated probes stop at Access and create no user.

**Preview deployed 2026-10-02** by this script (version `9caf3338`), from `emdash/infra` merged with `emdash/core`:
D1 holds 118 docs, 90 migrations, 0 users; `/` 200, `/about-us/values` 308 then 200, `/api/search?q=vpn` 200 with
results, `/_emdash/admin` and `/_emdash/api/...` 302 to Access. `VERIFY OK`. Secrets `CF_ACCESS_AUDIENCE` and
`EMDASH_ENCRYPTION_KEY` are set on the preview Worker; prod secrets get set at cutover.

Any binding added later (`CACHE`, `LOADER`) must be repeated under `env.preview`; bindings are not inherited.
The adapter adds `IMAGES` and `ASSETS` itself.

Node: EmDash 1.1's registry-verification package wants Node `^22.22.2 || ^24.15 || >=26`; 22.22.0 warns but works.

## Cutover runbook (infra side; the lead runs the cutover)

Everything runs from the repo root on the branch being shipped, after `npm ci`, logged in with `npx wrangler login`.
`ACC=44c7bfb7295ae9cd6050e09af901a4de`. Expect 1 to 2 minutes when `university.etop.tech` is not served (step 5 to step 6).

**Required before editors upload images:** an Access **Bypass (Everyone)** app for `/_emdash/api/media/file/*` on
`university.etop.tech`, `university-emdash.williampote.workers.dev` and the preview host. EmDash serves uploaded media
from that path and treats it as public. Without the bypass, new images are broken for readers. **Status: waiting on BJ.**
Verify: anonymous `GET /_emdash/api/media/file/does-not-exist` gives EmDash's 404 (not 302), and `/_emdash/admin` still gives 302.

1. **Load prod D1, then deploy the prod Worker (still on workers.dev only).** No request has hit prod yet, so the
   content goes in first:
   ```bash
   bash scripts/infra/deploy.sh production --load-content   # type 'production'; ends in VERIFY OK
   ```
2. **Prod secrets** (the prod Access AUD is `6bf410d5…027d`, from the app `University EmDash admin (staff)`):
   ```bash
   npx wrangler secret put CF_ACCESS_AUDIENCE --config wrangler.jsonc       # paste the prod AUD
   npx emdash secrets generate                                              # copy the emdash_enc_v1_… line
   npx wrangler secret put EMDASH_ENCRYPTION_KEY --config wrangler.jsonc    # paste it; NOT the preview key
   ```
3. **First admin:** a named eTop person (BJ) opens `https://university-emdash.williampote.workers.dev/_emdash/admin`
   through Entra and picks "Empty site" in the wizard, so the loaded content stays. They become Admin; others are Editors (40).
4. **Parity gate against the prod Worker:** `node scripts/emdash/parity.mjs --candidate https://university-emdash.williampote.workers.dev` exits 0.
5. **Take the hostnames off the Pages project** (the old site stops serving here):
   ```bash
   # Cloudflare dashboard: Workers & Pages > etop-university > Custom domains > remove university.etop.tech and www.university.etop.tech
   # DNS > etop.tech: delete the CNAMEs university and www.university (both point at etop-university.pages.dev)
   ```
6. **Attach them to the Worker.** Add to the TOP level of `wrangler.jsonc` (not `env.preview`), commit, and deploy:
   ```jsonc
   "routes": [
     { "pattern": "university.etop.tech", "custom_domain": true },
     { "pattern": "www.university.etop.tech", "custom_domain": true }
   ],
   ```
   ```bash
   npm run build && npx wrangler deploy     # wrangler creates the DNS records + certs; it refuses if a CNAME still exists
   ```
   `www` is served by the same Worker, and the prod Access app already covers `www.university.etop.tech/_emdash[/*]`.
   Any NEW hostname must be added to that Access app BEFORE it is attached. Optionally add a Single Redirect `www.university.etop.tech/*` to `https://university.etop.tech/${1}`.
7. **Verify on the real domain:** `/` 200, `/about-us/values` 308 then 200, `/api/search?q=vpn` 200, `/_emdash/admin` 302 to
   `etoptech.cloudflareaccess.com`, then the parity gate with `--candidate https://university.etop.tech`.
8. **Leave the Pages project `etop-university` in place for a week** as the rollback, then delete it.

**Rollback** (any step after 5): remove `routes` from `wrangler.jsonc` and deploy (or delete the Worker's custom domains
in the dashboard), then re-add `university.etop.tech` and `www.university.etop.tech` under the Pages project's Custom
domains, which recreates the CNAMEs. The prod D1 and Worker can stay; nothing on the Pages side was changed.

## Health check

- `GET <url>/` returns 200 (public site, no login).
- `GET <url>/_emdash/admin` without a login returns 302 to `etoptech.cloudflareaccess.com`. A 200 here means Access is off: stop.
- `GET <url>/_emdash/api/content/docs` without a login: 302 to Access. A 401 from EmDash does not count: it means Access is not in front. This proves the Access path covers the API, not just the admin UI.
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
bash scripts/infra/deploy.sh preview --load-content   # a fresh D1 has no tables; load schema + content first
# content: scripts/emdash/apply.mjs (content lane), then scripts/emdash/parity.mjs
```
