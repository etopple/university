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
