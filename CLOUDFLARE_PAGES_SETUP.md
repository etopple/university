# Cloudflare Pages — first-time setup for university.etop.tech

This is a one-time setup so future pushes to GitHub auto-deploy. Estimated time: 10 minutes.

## Prerequisites

- You're logged into the Cloudflare dashboard with the account that owns `etop.tech`.
- The `etopple/university` repo on GitHub has a `starlight` branch (already done — that's where this Starlight site lives).
- GitBook is still pointed at the `website` branch and stays alive until you cut DNS over.

## Step 1 — Create the Pages project

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** tab → **Connect to Git**.
2. **GitHub** → authorize Cloudflare if first-time, then pick the `etopple/university` repo.
3. **Set up builds and deployments**:
   - **Project name:** `etop-university` (will publish to `etop-university.pages.dev`)
   - **Production branch:** `starlight`
   - **Framework preset:** **Astro**
   - **Build command:** `npm run build`
   - **Build output directory:** `dist`
   - **Root directory (advanced):** leave blank (repo root)
   - **Environment variables (advanced):**
     - `NODE_VERSION` = `20`
4. Click **Save and Deploy**. First build takes ~2 min. When it finishes you'll have a working preview at `https://etop-university.pages.dev`.

## Step 2 — Verify the preview

Open `https://etop-university.pages.dev`. You should see:
- The "Welcome to eTop University" landing page
- The full sidebar tree (About us / Team / Education / Media / Security / Policies)
- All images loading (they live at `/.gitbook/assets/...`)

If anything looks wrong, fix in the repo, push to `starlight`, CF Pages rebuilds automatically.

## Step 3 — Custom domain

While still inside the `etop-university` Pages project:

1. **Custom domains** tab → **Set up a custom domain**.
2. Enter `university.etop.tech`.
3. Cloudflare will detect that `etop.tech` is on this same account and offer a one-click DNS record creation. Accept it.
   - The DNS record it creates is a CNAME `university` → `etop-university.pages.dev`, proxied (orange cloud).
4. Wait ~30 seconds for the cert to issue. Status flips to **Active**.

## Step 4 — Cut over from GitBook

Right now `university.etop.tech` resolves to GitBook. To switch:

1. In Cloudflare DNS for `etop.tech`, find the existing `university` record (likely a CNAME to `hosting.gitbook.com` or similar). **Delete it** if Step 3 didn't already replace it.
2. Confirm the new CNAME `university` → `etop-university.pages.dev` (proxied) is the only record for that hostname.
3. Wait 1–2 minutes for propagation. Hard-refresh `university.etop.tech` — Starlight should load.
4. In GitBook, you can now disconnect the GitHub integration and either downgrade the plan or cancel the workspace. Keep the GitBook export downloaded somewhere as a backup until you're confident.

## Ongoing workflow

- Edit markdown under `src/content/docs/`, commit to `starlight`, push.
- CF Pages auto-builds and deploys (~90 seconds).
- Pull requests get preview deployments at `<pr-id>.etop-university.pages.dev` automatically.
- When ready, merge `starlight` → `main` if you want a tidy default branch (optional — you can also keep `starlight` as default).

## Build settings reference (in case you need to recreate)

```
Framework preset:        Astro
Build command:           npm run build
Build output directory:  dist
Root directory:          /
Production branch:       starlight
Node version:            20
Install command:         npm install   (default)
```

## Cost

CF Pages free tier covers this easily:
- Unlimited bandwidth
- 500 builds/month (you'll do maybe 10–30)
- 100 custom domains
- Unlimited preview deployments

Total: **$0/mo** vs GitBook's $100/mo.
