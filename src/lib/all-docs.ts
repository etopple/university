import { getEmDashCollection } from "emdash";

/** Slugs of every published page, in a stable order (cursor-paged). */
export async function allDocSlugs(): Promise<string[]> {
  const slugs: string[] = [];
  let cursor: string | undefined;
  do {
    const r = await getEmDashCollection("docs", { limit: 100, cursor, orderBy: { slug: "asc" } });
    if (r.error) throw r.error;
    slugs.push(...r.entries.map((e) => e.id));
    cursor = r.nextCursor;
  } while (cursor);
  return slugs;
}

/** Pages for automated tests (the editor E2E edits "e2e-test-page"): never in the sitemap, noindex. */
export const isTestPage = (slug: string) => slug.startsWith("e2e-");

export const docPath = (slug: string) => (slug === "index" ? "/" : `/${slug}/`);
