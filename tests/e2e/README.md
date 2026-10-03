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

## Visual diff (`visual-diff.mjs`)

```bash
MSYS_NO_PATHCONV=1 node visual-diff.mjs --candidate https://<preview> [--base https://university.etop.tech] [--threshold 0.5] [--pages /,/team/meet-the-team]
```

- Pages compared: the home page plus 5 docs chosen to cover every block type: long text with details, tables, 23 images, asides, and a section index.
- Each page runs in light and dark, full-page at 1280 wide, with "Last updated" hidden.
- Output: `out/visual/report.md` plus base, candidate and diff PNGs. Exit 1 if any page is over the threshold or does not return 200.
- `MSYS_NO_PATHCONV=1` only matters in Git Bash, which otherwise rewrites `/` into a Windows path.
- Self-checks run 2026-10-02:
  - live vs live: 12/12 at 0.00%.
  - live home vs live team page (negative control): FAIL, 12.7% light and 66.3% dark.
