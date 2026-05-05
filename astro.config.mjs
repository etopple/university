import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import sidebar from "./src/_generated/sidebar.json" with { type: "json" };

export default defineConfig({
  site: "https://university.etop.tech",
  trailingSlash: "ignore",
  markdown: {
    shikiConfig: {
      theme: "github-dark-default",
    },
  },
  integrations: [
    starlight({
      title: "eTop University",
      description:
        "Tutorials, guides, and policies from eTop Technology — your MSP learning hub.",
      logo: {
        src: "./src/assets/logo.svg",
        replacesTitle: false,
      },
      favicon: "/favicon.svg",
      social: [
        {
          icon: "linkedin",
          label: "LinkedIn",
          href: "https://www.linkedin.com/company/etop-technology",
        },
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/etopple",
        },
      ],
      editLink: {
        baseUrl:
          "https://github.com/etopple/university/edit/starlight/src/content/docs/",
      },
      sidebar,
      lastUpdated: true,
      pagination: true,
      customCss: ["./src/styles/custom.css"],
      components: {
        // Override slots later if needed.
      },
      head: [
        {
          tag: "meta",
          attrs: { name: "robots", content: "index,follow" },
        },
      ],
    }),
  ],
});
