// Public site search over published University pages. EmDash's own search API
// lives under /_emdash, which Cloudflare Access keeps for staff, so the public
// search box calls this route instead. Published content only, read-only.
import type { APIRoute } from "astro";
import { search } from "emdash";

export const prerender = false;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "public, max-age=60" } });

export const GET: APIRoute = async ({ url, locals }) => {
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 100);
  if (q.length < 2) return json({ results: [] });
  try {
    await (locals as { emdash?: { ensureSearchHealthy?: () => Promise<void> } }).emdash?.ensureSearchHealthy?.();
    // Plain words only: FTS5 operators and quotes from the box are stripped.
    const terms = q.replace(/[^\p{L}\p{N}\s'-]/gu, " ").split(/\s+/).filter(Boolean).map((t) => `"${t.replace(/"/g, "")}"*`);
    if (!terms.length) return json({ results: [] });
    const r = await search(terms.join(" "), { collections: ["docs"], status: "published", limit: 12 });
    return json({
      results: r.items.map((it) => ({
        title: it.title ?? it.slug,
        url: it.slug === "index" ? "/" : `/${it.slug}/`,
        snippet: it.snippet ?? "",
      })),
    });
  } catch (e) {
    console.error("search", e);
    return json({ results: [], error: "Search is unavailable right now." }, 500);
  }
};
