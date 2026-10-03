import { defineCollection } from "astro:content";
import { docsSchema } from "@astrojs/starlight/schema";

// Page content lives in EmDash (see src/pages/[...slug].astro). Starlight still
// needs a `docs` collection, so it is deliberately empty. The markdown under
// src/content/docs/ is the migration source for scripts/emdash/, not served.
export const collections = {
  docs: defineCollection({ loader: async () => [], schema: docsSchema() }),
};
