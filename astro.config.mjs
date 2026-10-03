import { fileURLToPath } from "node:url";
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import emdash from "emdash/astro";
import { d1, r2, access } from "@emdash-cms/cloudflare";

// Editor sign-in: Cloudflare Access (eTop's Entra SSO). The Access app covers
// /_emdash/* only, so the public site stays public. The first person to open
// the admin becomes Admin; everyone else Access lets in is an Editor (40),
// which can edit and publish any page. `astro dev` falls back to passkeys.
const auth = access({
  teamDomain: "etoptech.cloudflareaccess.com",
  audienceEnvVar: "CF_ACCESS_AUDIENCE",
  autoProvision: true,
  defaultRole: 40,
});

export default defineConfig({
  site: "https://university.etop.tech",
  trailingSlash: "ignore",
  output: "server",
  adapter: cloudflare(),
  vite: {
    // Starlight/Astro's markdown engine is a native module that cannot load in
    // a Worker. Nothing compiles markdown at request time, so the Worker
    // bundle gets a stub (src/stubs/satteri.mjs). Build-time code is untouched.
    resolve: {
      alias: { satteri: fileURLToPath(new URL("./src/stubs/satteri.mjs", import.meta.url)) },
    },
  },
  markdown: {
    shikiConfig: {
      theme: "github-dark-default",
    },
  },
  integrations: [
    react(), // EmDash's admin is a React app
    emdash({
      database: d1({ binding: "DB" }),
      storage: r2({ binding: "MEDIA" }),
      auth,
    }),
    starlight({
      title: "eTop University",
      description:
        "Tutorials, guides, and policies from eTop Technology — your MSP learning hub.",
      logo: {
        src: "./src/assets/etop-help-logo.png",
        replacesTitle: false,
      },
      favicon: "/favicon.png",
      social: [
        { icon: "linkedin", label: "LinkedIn", href: "https://www.linkedin.com/company/etop-technology" },
        { icon: "github", label: "GitHub", href: "https://github.com/etopple" },
      ],
      // Pages are server-rendered from EmDash by src/pages/[...slug].astro,
      // which also passes the sidebar (EmDash menu "docs-sidebar").
      sidebar: [],
      disable404Route: true,
      pagefind: false,
      lastUpdated: true,
      pagination: true,
      customCss: ["./src/styles/custom.css"],
      components: {
        Search: "./src/components/Search.astro",
      },
      head: [
        // Starlight only adds this when it builds the sitemap itself.
        { tag: "link", attrs: { rel: "sitemap", href: "/sitemap-index.xml" } },
        {
          tag: "meta",
          attrs: { name: "robots", content: "index,follow" },
        },
      ],
    }),
  ],
});
