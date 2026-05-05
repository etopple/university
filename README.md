# eTop University

Public docs site for [university.etop.tech](https://university.etop.tech) — tutorials, self-help guides, policies, and security briefs from eTop Technology.

## Stack

- **[Astro v5](https://astro.build/)** + **[Starlight](https://starlight.astro.build/)** for the docs framework
- **Cloudflare Pages** for hosting (replaces GitBook)
- Content is plain markdown in `src/content/docs/`

## Local development

```bash
npm install
npm run dev
```

Dev server runs at http://localhost:4321/.

```bash
npm run build      # production build to ./dist
npm run preview    # preview the built site locally
```

## Editing content

All pages live under `src/content/docs/`. The directory layout drives the URL:

| File | URL |
| --- | --- |
| `src/content/docs/index.md` | `/` |
| `src/content/docs/team/meet-the-team.md` | `/team/meet-the-team` |
| `src/content/docs/policies/policies/index.md` | `/policies/policies/` |

Frontmatter is optional. The most useful keys:

```yaml
---
title: "Page Title"
description: "Short summary used for SEO + sidebar tooltips."
---
```

## Sidebar / nav

The sidebar is generated from `SUMMARY.md` (legacy GitBook table of contents) into `src/_generated/sidebar.json` by `scripts/migrate.py`. To regenerate after edits to `SUMMARY.md`:

```bash
python scripts/migrate.py
```

The migration script is idempotent — re-running won't re-move already-migrated content.

## Assets

Old GitBook assets live at `public/.gitbook/assets/` and are referenced by absolute path (`/.gitbook/assets/foo.png`). New images can go anywhere under `src/assets/` (Astro image pipeline) or `public/` (raw passthrough).

## Deployment

Pushed to `starlight` branch → Cloudflare Pages auto-deploys.

Build settings (configured in CF Pages):
- Framework preset: **Astro**
- Build command: `npm run build`
- Build output directory: `dist`
- Node version: `20` (or higher)
