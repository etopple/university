# EmDash migration (content lane)

Moves eTop University's pages from `src/content/docs/**/*.md` into EmDash, and
proves nothing changed for readers before cutover.

| Step | Command (run in `scripts/emdash/`) | What it does |
|---|---|---|
| Install | `npm install` | Isolated deps; does not touch the site's root `package.json`. |
| Build the seed | `node build-seed.mjs` | Writes `.emdash/seed.json` (schema + sidebar menu + all 118 pages) and `out/migration-report.json`. |
| Drift check | `node build-seed.mjs --check` | Exit 1 if someone edited markdown without regenerating the seed. |
| Load locally | `node apply.mjs --local [--database ./data.db]` | `emdash seed --on-conflict update` into SQLite. Needs `emdash` installed at the repo root. |
| Load a new D1 | `npx emdash seed --on-conflict update` (repo root), then `node scripts/emdash/d1-sql.mjs` and `npx wrangler d1 execute DB [--env preview] --remote --file scripts/emdash/out/d1-load.sql` | Builds idempotent SQL (CREATE IF NOT EXISTS, INSERT OR REPLACE, search index rebuilt) from the seeded SQLite. Needs no admin sign-in or API token. New databases only: it overwrites pages. |
| Load a preview | `EMDASH_TOKEN=… node apply.mjs --url https://<preview> [--dry-run]` | REST upsert by slug. Creates missing pages, skips unchanged ones, reports pages edited since migration and leaves them alone (`--overwrite` rewrites them; pre-cutover only). Rebuilds the sidebar menu when it is empty. |
| Fidelity check | `node content-check.mjs` | Compares each page's Portable Text with the live rendered text. Currently 118/118 exact. |
| **Cutover gate** | `node parity.mjs --candidate https://<preview>` | Crawls every URL on the live site and the preview; compares status, `<title>`, and main-content text; checks every asset. Exit 0 = parity. Report in `out/parity-report.md`; moved pages get a line in `out/redirects.suggested`. |
| Gate rules | | Exact text match (order matters); same status; same redirect target; same in-content link targets and image srcs; same asset status and type. Fetch errors, 5xx, a missing selector or non-HTML 200 fail. `--limit` runs are always FAIL (partial). The live crawl must reach every seed page. |
| Step hints | `node step-hints.mjs [--check]` | Writes `src/_generated/step-hints.json`: for every block that sits inside a numbered step (and every sub-list item that resumes after one), its `_key` and level. The editor drops those hints on save but keeps keys; the theme reads this file so saved pages keep their screenshots in the right step (#13, #14). Re-run after `build-seed.mjs`. |
| Make boxes editable | `node flatten-boxes.mjs --url <site> (--dev-bypass \| EMDASH_TOKEN=…) [--apply]` | Rewrites each live page's old nested aside/details as start/end markers. Keeps every other block and key; skips pages with unpublished drafts. Renders the same (parity checked locally). |
| Tests | `npm test` | Converter, seed determinism, and the parity gate against fake sites (pass and fail cases). |

## Content model

- Collection `docs`, `urlPattern: "/{slug}"`. The slug is the full Starlight path
  (`education/self-help-guides/backups`; the home page is `index`), so every URL stays where it is.
  Target: **zero moved URLs**, so `redirects` in the seed is empty.
- Fields: `title`, `description`, `body` (Portable Text), `sidebar_label`, `template`,
  `frontmatter_extra` (any other frontmatter, kept verbatim), `legacy_source`, `migration_hash`.
- Sidebar: menu `docs-sidebar`, built from `src/_generated/sidebar.json`. Labels and order are verbatim;
  groups are `custom` items with `url: "#"` and `cssClasses: "sidebar-group"`.
- Body blocks the theme must render: standard PT blocks (h1–h6, normal, blockquote, bullet/number lists
  with `level`), marks `strong` `em` `code` `strike-through` `underline`, markDefs `link {href, blank?}`
  and `highlight {color}`, plus custom blocks `image {alt, asset.url, caption?, align?}`,
  `code {language, code}`, `table {align, rows[{header, cells[{content}]}]}`, `html {html}` (raw passthrough, used twice), `break`.
- Boxes (issue #15) are stored flat so the editor can change their text: `asideStart {variant, title?}`, the
  content as ordinary blocks, `asideEnd {closes: "aside"}`; likewise `detailsStart {summary}` ... `detailsEnd`.
  The start marker keeps the box's `_key`, the end marker adds `e`. The theme also still renders the old
  nested `aside {variant, title?, content}` / `details {summary, content}` (pages loaded before 2026-10-04).
  `flatten-boxes.mjs` rewrites those in place (dry run by default; production needs `--production`).
- List blocks may also carry `listContinuation` (more content of the previous item, also set on code/image
  blocks inside an item, so render it inside that `<li>`), `checked` (task lists) and `listStart`.
  An `image` may carry `link`.
- Images keep their `/.gitbook/assets/…` URLs from `public/`; nothing is re-uploaded in v1.
- Text is stored after SmartyPants, exactly as Astro rendered it (curly quotes, dashes, ellipses).

## Idempotency

`build-seed.mjs` is a pure function of the markdown and the sidebar: no random keys, stable ordering,
so re-running it on unchanged content is a zero-byte diff. Applying the seed matches entries by
(collection, slug, locale), so a second apply updates in place and never duplicates. Verified against
`emdash` 1.x on SQLite: first apply 118 created / 152 menu items, second apply 118 updated, row counts unchanged.

## Already-broken links

The parity crawl found 34 internal links that 404 on the live site today (old GitBook `.md` links).
Both sides agree, so they do not block cutover; they are listed in `out/parity-report.md` under
"Already broken on the live site".
