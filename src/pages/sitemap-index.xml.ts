// Same shape and URL as the @astrojs/sitemap output of the old static site.
import type { APIRoute } from "astro";

export const prerender = false;

export const GET: APIRoute = ({ url }) =>
  new Response(
    `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${url.origin}/sitemap-0.xml</loc></sitemap></sitemapindex>`,
    { headers: { "content-type": "application/xml", "cache-control": "public, max-age=300" } },
  );
