// EmDash menu "docs-sidebar" -> Starlight's sidebar config shape.
// Groups were seeded as custom items with url "#"; pages carry the URL from
// the docs collection's urlPattern ("/{slug}"), so the home page is "/index".
import type { MenuItem } from "emdash";

export type SidebarEntry = { label: string; link: string; attrs?: Record<string, string> } | { label: string; items: SidebarEntry[] };

// EmDash encodes the "/" inside a nested slug as %2F when it fills urlPattern.
export function pageUrl(url: string): string {
  const u = url.replace(/%2f/gi, "/");
  return u === "/index" || u === "/index/" ? "/" : u;
}

export function menuToSidebar(items: MenuItem[]): SidebarEntry[] {
  return items.map((it) =>
    it.children?.length
      ? { label: it.label, items: menuToSidebar(it.children) }
      : { label: it.label, link: pageUrl(it.url), ...(it.target === "_blank" ? { attrs: { target: "_blank" } } : {}) },
  );
}

type Entry = SidebarEntry;
const isGroup = (e: Entry): e is { label: string; items: SidebarEntry[] } => "items" in e;
const norm = (u: string) => (u.length > 1 ? u.replace(/\/+$/, "") : u);

/** First page link inside an entry (a group's own landing page). */
function firstLink(e: Entry): string | undefined {
  if (!isGroup(e)) return e.link;
  for (const c of e.items) {
    const l = firstLink(c);
    if (l) return l;
  }
}
function countLinks(e: Entry): number {
  return isGroup(e) ? e.items.reduce((n, c) => n + countLinks(c), 0) : 1;
}
const card = (e: Entry) => ({ label: e.label, href: firstLink(e) ?? "/", count: isGroup(e) ? countLinks(e) : undefined });

/**
 * When `path` is a section's landing page (the first link in its sidebar group),
 * the other entries of that group: shown as "In this section" cards.
 */
export function sectionChildren(sidebar: Entry[], path: string) {
  const want = norm(path);
  const walk = (entries: Entry[]): ReturnType<typeof card>[] | undefined => {
    for (const e of entries) {
      if (!isGroup(e)) continue;
      const [first, ...rest] = e.items;
      if (first && !isGroup(first) && norm(first.link) === want && rest.length) return rest.map(card);
      const deeper = walk(e.items);
      if (deeper) return deeper;
    }
  };
  return walk(sidebar) ?? [];
}

/** Top-level sections for the home page. */
export function topSections(sidebar: Entry[]) {
  return sidebar.filter(isGroup).map(card);
}
