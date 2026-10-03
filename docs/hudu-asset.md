# Hudu asset draft: eTop University

**DRAFT. Not created in Hudu.** Create it at cutover, when production URL and access are real.

- Target: company **eTop Technology** (id 39), layout **eTop Internal Tool** (id 135).
- Create with VM etop-mcp `hudu_create_asset` via `invoke_tool`. The Cloudflare gateway refuses company 39.
- Asset name: `eTop University`

| Field (`custom_fields` key) | Value |
|---|---|
| Purpose (`purpose`) | eTop's public help and learning site (self-help guides, eTop process, policies, team page), edited by staff in the EmDash CMS. |
| Status (`status`) | Pilot until cutover, then Production |
| Owner (`owner`) | BJ Pote |
| URL (`url`) | https://university.etop.tech (editor: https://university.etop.tech/_emdash/admin) |
| How to get access (`how_to_get_access`) | Reading needs no login. Editing: sign in at `/_emdash/admin` with your @etoptechnology.com Microsoft account (Cloudflare Access). Your first sign-in creates an Author account, which can edit and publish its own pages. Ask BJ to raise you to Editor or Admin. |
| Credentials (`credentials`) | No shared login for editors. Automation only: Hudu password "University EmDash - E2E service token" (Access service token `university-e2e`, preview only) and "University EmDash - API token" (admin-scope EmDash token). |
| Runs on (`runs_on`) | Cloudflare Worker `university-emdash` (account eTop Technology), D1 `university-emdash-db`, R2 `university-emdash-media`, KV `university-emdash-session`. Preview: same names with `-preview`. |
| Build guide (`build_guide`) | https://github.com/etopple/university/blob/starlight/docs/BUILD.md |
| Change history (`change_history`) | https://github.com/eTop-Technology/etop-changes/issues?q=label%3Atool%3Auniversity |
| Vendor support (`vendor_support`) | EmDash (open source, MIT): https://github.com/emdash-cms/emdash/issues, docs https://docs.emdashcms.com. Hosting: Cloudflare support via the eTop Technology account. |
| Staff runbooks (`staff_runbooks`) | "How to edit and publish a page" (a page on the University site itself: https://university.etop.tech/education/etop-process/how-to-edit-university-pages) |
| Notes (`notes`) | Pages live in the D1 database, not git, after cutover. The markdown in the repo is the frozen migration source. Restore an edit with D1 Time Travel (see build guide). Old Pages project `etop-university` retires after cutover. |

Before creating, check that:
- the snake_case keys match layout 135's labels (`hudu_get_asset_layout` id 135),
- the two Hudu passwords named in *Credentials* exist,
- the build-guide URL points at a merged `docs/BUILD.md`.
