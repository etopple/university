// Every published University page, built from EmDash on request.
import type { APIRoute } from "astro";
import { allDocSlugs, docPath } from "../lib/all-docs";

export const prerender = false;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

export const GET: APIRoute = async ({ url }) => {
  const slugs = (await allDocSlugs()).map(docPath).sort();
  const urls = slugs.map((p) => `<url><loc>${esc(url.origin + encodeURI(p))}</loc></url>`).join("");
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`,
    { headers: { "content-type": "application/xml", "cache-control": "public, max-age=300" } },
  );
};
