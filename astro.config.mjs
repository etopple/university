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
        src: "./src/assets/etop-help-logo.png",
        replacesTitle: false,
      },
      favicon: "/favicon.png",
      social: {
        linkedin: "https://www.linkedin.com/company/etop-technology",
        github: "https://github.com/etopple",
      },
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
