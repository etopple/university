# University E2E and visual diff

Isolated deps (own `package.json`); does not touch the site's root `package.json`.

```bash
cd tests/e2e && npm install && npx playwright install chromium
```

## Editor E2E (`editor.spec.mjs`)

What it does:
1. Signs in.
2. Makes sure the unlisted page `/e2e-test-page` exists (collection `docs`), creating and publishing it if missing.
3. Opens it in the real EmDash editor, changes the title to a timestamped value, saves, and clicks **Publish**.
4. Loads `/e2e-test-page` as a visitor with no EmDash credentials and waits (up to 90s) for the new title in the `<h1>`.
5. Checks that the sidebar does not link to the page.

| Env var | Needed for | Value |
|---|---|---|
| `E2E_BASE_URL` | always | `http://localhost:4321` or the preview URL |
| `E2E_AUTH` | optional | `dev-bypass` (default for localhost) or `token` (default otherwise) |
| `EMDASH_TOKEN` | `token` | Admin-scope EmDash API token. Admin pages need the `admin` scope. |
| `E2E_CF_ACCESS_CLIENT_ID`, `E2E_CF_ACCESS_CLIENT_SECRET` | preview | Access service token `university-e2e` (preview app, Service Auth policy) |
| `E2E_TEST_SLUG` | optional | default `e2e-test-page` |

**On the preview, run it from GitHub Actions**: `gh workflow run editor-e2e -R etopple/university` (manual only; GitHub offers it only once the workflow file is on the repo's default branch, `website`). First passing editor E2E: run 37103172076 (2026-10-03, from a temporary branch trigger since removed; the run's visual-diff step failed on the pre-fix theme). In CI only the visual-diff output is uploaded: the repo is public, and Playwright's HTML report can log request headers on a failed API call.
The credentials exist only as GitHub secrets: `UNIVERSITY_E2E_ACCESS_CLIENT_ID/SECRET` (Access service token
`university-e2e`) and `UNIVERSITY_E2E_EMDASH_TOKEN`. The workflow maps them onto the variables above. Traces are off in CI
because they record request headers.

```bash
# Local: `npx astro dev` at the repo root first (dev-bypass exists only in dev)
E2E_BASE_URL=http://localhost:4321 npm run test:editor

# Preview (behind Cloudflare Access)
E2E_BASE_URL=https://university-emdash-preview.williampote.workers.dev \
EMDASH_TOKEN=... E2E_CF_ACCESS_CLIENT_ID=... E2E_CF_ACCESS_CLIENT_SECRET=... npm run test:editor
```

Missing credentials fail at once, and the error lists what is missing. No retries: a flaky editor test should
fail where you can see it. Traces and the visitor screenshot go to `out/results/`, the HTML report to `out/report/`.

Why a token rather than a login: EmDash's dev-bypass returns 403 on a deployed Worker, and an Access service
token carries no email, so it cannot become an EmDash user. EmDash does accept `Authorization: Bearer <API token>`
on admin pages and the API in every auth mode. The Access service token gets the request through
Cloudflare's edge, and the Bearer token identifies the EmDash user.

## Real-editor round-trip (`roundtrip.mjs`)

Opens pages in the real EmDash editor on a LOCAL `astro dev`, types two characters into the first
paragraph and deletes them, then Saves and Publishes, so the editor writes back its own version of the
stored Portable Text. Compare the site before and after with `scripts/emdash/parity.mjs` (text AND list
structure, including screenshots per step). A text-only check misses split lists.

```bash
node roundtrip.mjs --base http://localhost:4321 --all            # or --slugs a/b,c/d
# results: out/roundtrip/results.json (+ <slug>.before/after.json): which fields the editor dropped or added
```

- Refuses anything but localhost: it publishes every page it opens. Sign-in is EmDash's dev-bypass.
- It aborts a page (nothing saved) if the typed text does not land at the caret or the image count changes:
  a block the editor still holds selected (e.g. an image at the top) would otherwise be replaced by the typing.
- A second run on an already-saved page reports "save stayed disabled": the editor's output is a fixed point.
- Pages with an empty body (section index pages) have nothing to save.
- Proof run 2026-10-04 (local, starlight + this fix): 108 pages saved through the editor (the 11 others have an
  empty body); parity against an untouched reference instance: PASS, 270 pages, 0 differences. With the old theme,
  the same saved content failed on 23 pages (list structure).
- Gotcha: `astro dev` inside `.claude/worktrees/<name>` of a checkout with no `node_modules` fails with
  "Tsconfig not found astro/tsconfigs/strict" (Vite reads the outer checkout's tsconfig). Run it from a copy
  outside the checkout, with its own `npm ci` and a local D1 loaded from `scripts/emdash/out/d1-load.sql`
  (`npx wrangler d1 execute DB --local --config wrangler.jsonc --file ...`).

## Visual diff (`visual-diff.mjs`)

```bash
MSYS_NO_PATHCONV=1 node visual-diff.mjs --candidate https://<preview> [--base https://university.etop.tech] [--threshold 0.5] [--pages /,/team/meet-the-team]
```

- Pages compared: the home page plus 5 docs chosen to cover every block type: long text with details, tables, 23 images, asides, and a section index.
- Each page runs in light and dark, full-page at 1280 wide, with "Last updated" hidden.
- Output: `out/visual/report.md` plus base, candidate and diff PNGs. Exit 1 if any page is over the threshold or does not return 200.
- `MSYS_NO_PATHCONV=1` only matters in Git Bash, which otherwise rewrites `/` into a Windows path.
- Pass rules: HTTP 200 on both sides; at most 0.5% of all pixels differ (`--threshold`); at most 2% differ in any 200px band (`--band`), so a tall page cannot hide a broken block; heights within 8px. Pages are captured in 8000px tiles (one shot of a very tall page can come back blank past ~16k px). A stalled image fails its row after 30s.
- Credentials go only to the site under test, and never through a redirect: a cross-origin redirect is followed without them (checked with two mock servers).
### Reviewed baseline (issue #9)

Comparing against another site stops meaning anything once that site's look has legitimately moved (the
Starlight 0.30 to 0.42 font-metric wrap kept every page at 1-5%, so the gate was always red). Instead,
compare against screenshots a person has looked at and accepted:

```bash
# 1. Shoot the site as it is now (e.g. right after a reviewed deploy). Never overwrites an existing folder.
MSYS_NO_PATHCONV=1 node visual-diff.mjs --candidate https://university.etop.tech --save-baseline baselines/2026-10-04
# 2. Look at every PNG in that folder. If they are right, record it in baselines/2026-10-04/baseline.json:
#    "reviewed": { "by": "BJ Pote", "on": "2026-10-04", "manifest": "<hash the save printed>", "note": "..." }
# 3. Later deploys compare against it; red means a real change again.
MSYS_NO_PATHCONV=1 node visual-diff.mjs --candidate https://<preview or prod> --baseline baselines/2026-10-04
```

- A baseline nobody marked reviewed is refused (`--allow-unreviewed` only for a quick look; the report then says NOT REVIEWED).
- Integrity: `baseline.json` lists every PNG (page, theme, file, sha256) and the hash of that list. The review must
  carry that hash, and every run checks the folder holds exactly those files with those hashes; a changed, swapped,
  added or missing PNG is refused, even with `--allow-unreviewed`. Re-shoot means a new folder and a new review.
- File names are a readable slug plus a hash of the exact path (`home-8a5edab282-light.png`), so two pages can never
  share a file; a duplicate page in `--pages` fails before anything is written.
- Same pass rules as above. `--pages` must be a subset of the baseline's pages; `--base` is not allowed with a baseline.
- Where to keep it: anywhere local. Twelve full-page PNGs run to several MB, so they are not committed by default.
- Checked 2026-10-04: live vs a baseline of live 12/12 PASS at 0.00%; the local reference build vs that
  baseline FAIL (0.5-2.4%, worst band up to 99.6%), so red still means something. An unreviewed baseline was refused.
- Unit checks (no browser): `npm run test:unit`.

- Self-checks run 2026-10-02:
  - live vs live: 12/12 at 0.00%.
  - live home vs live team page (negative control): FAIL, 12.7% light and 66.3% dark (worst band 32% and 99.6%).
