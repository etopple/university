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

export const docPath = (slug: string) => (slug === "index" ? "/" : `/${slug}/`);
