# eTop University (EmDash) - build guide
Last verified: 2026-10-02 by Claude (emdash-qa-docs lane), pre-cutover  
Change history: https://github.com/eTop-Technology/etop-changes/issues?q=label%3Atool%3Auniversity

> **Status: pre-cutover.** `university.etop.tech` is still served by the old static Pages project
> `etop-university` (Starlight built from markdown). Everything below describes the EmDash build on the
> `emdash/integration` branch. Lines marked **(pending)** were not yet true on the verified date.

## What it is

eTop University is eTop's public help and learning site: self-help guides for clients, eTop process
pages, policies and the team page. It runs **Astro + Starlight** for the look and navigation, with
**EmDash** (Cloudflare's open-source CMS, built on Astro) as the content store. eTop staff edit pages
in a browser at `/_emdash/admin` and publish without touching git.

It is **not** a client portal, it holds no client data, and nothing on it needs a login to read.
Only the editor (`/_emdash`) is behind a login.

## Where it runs

All on Cloudflare, account **eTop Technology** (`44c7bfb7295ae9cd6050e09af901a4de`). EmDash needs
server rendering, so it is a **Worker** (Astro `output: "server"` + `@astrojs/cloudflare`), not Pages.
Config: `wrangler.jsonc` at the repo root.

| | Production | Preview |
|---|---|---|
| Worker | `university-emdash` | `university-emdash-preview` (`--env preview`) |
| URL | `university.etop.tech` after cutover; `university-emdash.williampote.workers.dev` until then | `https://university-emdash-preview.williampote.workers.dev` |
| D1 database (binding `DB`) | `university-emdash-db` `627de272-335b-45c0-b8a8-92b7063c6fe3` | `university-emdash-db-preview` `a0c481d0-42ef-4ddb-92eb-9aaa97b3aabd` |
| R2 bucket (binding `MEDIA`) | `university-emdash-media` | `university-emdash-media-preview` |
| KV (binding `SESSION`, Astro sessions) | `university-emdash-session` `1b71a62ab53a43a0b55248bca303c933` | `university-emdash-session-preview` `7f9b5ba93b574bac9c318cb2c357a5a5` |
| `EMDASH_SITE_URL` (var) | `https://university.etop.tech` | the preview URL |
| Cron | `* * * * *` (runs scheduled publishing) | same |

Resources created 2026-10-02 (D1 location hint `wnam`). Not used in v1: KV object cache (`CACHE`),
the `LOADER` binding and sandboxed plugins, Hyperdrive, a public R2 domain, Workers Cache.

The legacy Pages project `etop-university` keeps serving `university.etop.tech` until the cutover.
Its setup is in `CLOUDFLARE_PAGES_SETUP.md`. Retire both after the cutover.

## How it is built

| Path | What it is | Owner lane |
|---|---|---|
| `astro.config.mjs`, `src/` | Astro 7 + Starlight 0.42 + `emdash` 1.1. Starlight renders pages that EmDash supplies (collection `docs`, `urlPattern: /{slug}`) and the sidebar from the EmDash menu `docs-sidebar`. | core (emdash/core) **(pending merge)** |
| `src/worker.ts`, `wrangler.jsonc` | Worker entry (incl. the scheduled handler for timed publishing), bindings above | core / infra |
| `.emdash/seed.json` | Schema (collection `docs` and its fields), sidebar menu, all 118 pages. Generated, never hand-edited. | content |
| `scripts/emdash/` | Markdown to EmDash migration, `apply.mjs` loader, `parity.mjs` cutover gate. Own `package.json`. See `scripts/emdash/README.md`. | content |
| `scripts/infra/deploy.sh` | Build, migrate D1, deploy, verify | infra |
| `tests/e2e/` | Editor E2E (Playwright) and the live-vs-preview visual diff. Own `package.json`. See `tests/e2e/README.md`. | qa-docs |
| `public/.gitbook/assets/` | Images, still served as static files. Not moved into R2 in v1. | - |
| `src/content/docs/**/*.md` | The old markdown. After cutover it is the **migration source only**; edits made here no longer reach the site. | - |

**Content model** (collection `docs`): `title`, `description`, `body` (Portable Text), `sidebar_label`,
`template` (`doc` or `splash`), `frontmatter_extra`, `legacy_source`, `migration_hash`. The slug is the full
page path (`education/self-help-guides/backups`; home is `index`), so every URL kept its old address.

**Secrets** (names only; values are Worker secrets, never in git, `wrangler.jsonc` or `astro.config.mjs`):

| Name | Where | Source |
|---|---|---|
| `CF_ACCESS_AUDIENCE` | Worker secret, prod and preview (different values) | AUD tag of that env's Access app |
| `EMDASH_ENCRYPTION_KEY` | Worker secret, prod and preview | `npx emdash secrets generate`. Only protects plugin settings of type secret, and v1 has none. Once a plugin stores one, keep a recovery copy outside Cloudflare. |
| `CLOUDFLARE_API_TOKEN` | operator shell or CI only | Scoped: D1 Edit + Workers Scripts Edit on the eTop account |
| `EMDASH_TOKEN` | E2E and `apply.mjs` runner only | Admin-scope EmDash API token, created in the preview admin. Store it in Hudu or as a GitHub secret. |
| `E2E_CF_ACCESS_CLIENT_ID` / `E2E_CF_ACCESS_CLIENT_SECRET` | E2E runner only | Access service token `university-e2e`, allowed on the **preview** app only **(pending)** |

## Deploy

```bash
export CLOUDFLARE_API_TOKEN=...          # D1 Edit + Workers Scripts Edit
bash scripts/infra/deploy.sh preview     # build -> emdash migrate -> wrangler deploy --env preview -> verify
bash scripts/infra/deploy.sh production  # lead only, at cutover, under a Change issue; asks you to type 'production'
```

`wrangler deploy` never runs D1 migrations. The script runs `emdash migrate --wrangler-env …` before it
deploys and `emdash migrate --check` after. Changes to the content model (collections and fields) are a
separate step. See EmDash's "Evolving a Deployed Site".

If the build uses the `@cloudflare/vite-plugin` path (Astro writes a flattened `dist/server/wrangler.json`), pick the
env at build time with `CLOUDFLARE_ENV=preview` and drop `--env` at deploy. Any binding added later (`CACHE`, `LOADER`,
`IMAGES`) must be repeated under `env.preview`: bindings are not inherited.

**Confirm it worked:**

1. `GET <url>/` returns 200 with no login.
2. `GET <url>/_emdash/admin` with no login returns **302 to `etoptech.cloudflareaccess.com`**. A 200 here means Access is off: stop.
   `GET <url>/_emdash/api/content/docs` with no login is also a 302 (or 401/403), never 200: Access covers the API too.
   `deploy.sh` runs these checks and prints `VERIFY OK` or `VERIFY FAILED`.
3. `npx emdash migrate --check --wrangler-config wrangler.jsonc [--wrangler-env preview]` exits 0.
4. `npx wrangler tail [--env preview]` shows the cron line `"* * * * *" … Ok` once a minute.
5. Preview only, before cutover, all from `tests/e2e/` and `scripts/emdash/`:
   - `node parity.mjs --candidate <preview>`: every URL, title and main text matches the live site.
   - `npm run visual -- --candidate <preview>`: home plus 5 docs, light and dark, within 0.5% of the live pixels.
   - `npm run test:editor` with `E2E_BASE_URL=<preview>`: edit, publish and render work end to end.

## Rebuild from zero

```bash
export CLOUDFLARE_ACCOUNT_ID=44c7bfb7295ae9cd6050e09af901a4de
npx wrangler d1 create university-emdash-db --location wnam            # put the new UUID in wrangler.jsonc
npx wrangler d1 create university-emdash-db-preview --location wnam
npx wrangler r2 bucket create university-emdash-media
npx wrangler r2 bucket create university-emdash-media-preview
npx wrangler kv namespace create university-emdash-session             # put the new id in wrangler.jsonc
npx wrangler kv namespace create university-emdash-session-preview
# Access: create the two apps under "Access" below; copy each AUD tag
npx wrangler secret put CF_ACCESS_AUDIENCE                 # prod AUD
npx wrangler secret put CF_ACCESS_AUDIENCE --env preview   # preview AUD
npx emdash secrets generate        # copy the emdash_enc_v1_... line, paste it at the next prompt
npx wrangler secret put EMDASH_ENCRYPTION_KEY
npx wrangler secret put EMDASH_ENCRYPTION_KEY --env preview   # a different generated key
bash scripts/infra/deploy.sh preview
cd scripts/emdash && npm install && EMDASH_TOKEN=... node apply.mjs --url <preview>   # load the 118 pages + sidebar
node parity.mjs --candidate <preview>                                                # must exit 0
```

**Content is the part you cannot rebuild from git** once editors start working in the CMS. The markdown in
`src/content/docs/` is frozen at the migration. After cutover, the D1 database is the only copy of
edited pages. Cloudflare D1 Time Travel restores any minute in the last 30 days on Workers Paid (7 on Free)
(`npx wrangler d1 time-travel restore university-emdash-db --timestamp <ISO>`). Anything older needs an
export (`npx wrangler d1 export university-emdash-db --remote --output university.sql`). Scheduling that
export is open (see Known traps).

## Access

- **Editors** sign in at `<site>/_emdash/admin` through **Cloudflare Access**:
  - Team `etoptech.cloudflareaccess.com`, Entra IdP `4d4216f7-e1e2-4a13-a848-5d94920ae2bc`.
  - Policy: allow `email_domain = etoptechnology.com`, require the Entra login method. Session 12h.
  - EmDash re-checks the Access JWT on every `/_emdash` request.
  - First login auto-creates the EmDash user as **Author** (role 30) unless `roleMapping` in `astro.config.mjs` says otherwise.
  - An Admin can raise a user's role under *Users* in the admin.
- **Two Access apps, one per env**, so a preview credential cannot open production:
  - *University EmDash admin (staff)* `39ca3545-7a40-4047-85c2-ab42a4b817d9`: `university.etop.tech/_emdash[/*]` + `university-emdash.williampote.workers.dev/_emdash[/*]`
  - *University EmDash admin PREVIEW (staff)* `ad705bef-5c98-49aa-80cc-e40fe3bd0d2b`: `university-emdash-preview.williampote.workers.dev/_emdash[/*]`
  - Each app lists both `/_emdash` and `/_emdash/*`. Covering only `/_emdash/admin` breaks the API.
  - Created 2026-10-02 (BJ approved). Checked live: `/_emdash`, `/_emdash/admin` and `/_emdash/api/...` all 302 to Access, and `/` stays 200.
  - Each app's AUD tag goes into that env's `CF_ACCESS_AUDIENCE` Worker secret. Read it from the app in Zero Trust.
- **Automation** (E2E, `apply.mjs`): Access service token `university-e2e` under a *Service Auth* policy on the
  **preview app only**, plus an admin-scope EmDash API token. EmDash checks the `Authorization: Bearer` header
  before Access, in every mode. **(pending)**
- **Cloudflare account**: eTop Technology account admins (BJ). Grant through Cloudflare *Manage Account > Members*.
- **GitHub** `etopple/university`: default branch `starlight`. EmDash work merges into `emdash/integration`.
  Production cutover belongs to the lead and needs a Change issue.

## Known traps

- **2026-10-02** EmDash needs `output: "server"`, so it cannot run on the existing Pages project. It is a new
  Worker, and the cutover moves the custom domain from Pages to the Worker.
- **2026-10-02** `wrangler deploy` does not migrate D1. Use `scripts/infra/deploy.sh`, which does. A new table
  without its migration returns 500s.
- **2026-10-02** An Access path of `/_emdash` matches only that exact path. `/_emdash/admin` was reachable without a
  login until `/_emdash/*` was added. List both.
- **2026-10-02** `preview_urls: false` in both envs. Cloudflare's per-version preview hostnames would sit outside
  the Access app and expose the admin.
- **2026-10-02** The Access policy that requires the Entra login method rejects service tokens. Automation needs
  its own *Service Auth* policy, on the preview app only.
- **2026-10-02** EmDash's `dev-bypass` sign-in exists only under `astro dev`. It returns 403 on any deployed Worker.
  That is why the E2E uses a service token + API token against the preview.
- **2026-10-02** Editing `src/content/docs/*.md` after cutover changes nothing on the site. Re-running
  `apply.mjs --overwrite` after cutover would **overwrite editors' work**. `apply.mjs` refuses to touch pages edited in
  the CMS unless you pass `--overwrite`.
- **2026-10-02** 34 internal links already 404 on the live site (old GitBook `.md` links). They are listed in
  `scripts/emdash/out/parity-report.md` and do not block cutover.
- **2026-10-02** Node: EmDash 1.1 wants `^22.22.2 || ^24.15 || >=26`. 22.22.0 only warns.
- **Open**: no scheduled D1 export beyond Time Travel's window.
