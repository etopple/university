// URL compatibility with the old Cloudflare Pages site, which:
//   - 308s encoded slashes (/a%2Fb) to the decoded path, with its trailing slash,
//   - 308s /index to /.
// The trailing-slash redirect for real pages (/some/page -> /some/page/) lives in
// src/pages/[...slug].astro, because Pages only did it for pages that exist.
// EmDash's own routes (/_emdash/*) and files (anything with an extension) are left alone.
import { defineMiddleware } from "astro:middleware";

export const onRequest = defineMiddleware((ctx, next) => {
  const { pathname, search } = ctx.url;
  const method = ctx.request.method;
  if ((method !== "GET" && method !== "HEAD") || pathname.startsWith("/_emdash") || pathname.startsWith("/_astro") || pathname.startsWith("/_image"))
    return next();

  // Collapse leading slashes first: a redirect to "//host/" would leave the site.
  let target = pathname.replace(/^\/{2,}/, "/");
  if (/%2f/i.test(target)) {
    target = target.replace(/%2f/gi, "/");
    if (!target.endsWith("/") && !target.slice(target.lastIndexOf("/") + 1).includes(".")) target += "/";
  }
  if (target === "/index" || target === "/index/") target = "/";
  if (target !== pathname) return ctx.redirect(target + search, 308);
  return next();
});
