// Shared settings for the editor E2E. Everything comes from environment
// variables so the same spec runs against `astro dev` and the Access-protected
// preview. Missing credentials fail loudly; nothing falls back silently.

export const BASE_URL = (process.env.E2E_BASE_URL || "").replace(/\/$/, "");
export const TEST_SLUG = process.env.E2E_TEST_SLUG || "e2e-test-page";
export const COLLECTION = "docs";

const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(BASE_URL);

// dev-bypass: EmDash's /_emdash/api/setup/dev-bypass (only exists under `astro dev`).
// token: an admin-scope EmDash API token sent as a Bearer header. EmDash accepts
//        Bearer auth on admin pages as well as the API, so the real editor UI works
//        behind Cloudflare Access without a bypass in the deployed code.
export const AUTH = process.env.E2E_AUTH || (isLocal ? "dev-bypass" : "token");

export function requireConfig() {
  const missing = [];
  if (!BASE_URL) missing.push("E2E_BASE_URL");
  if (AUTH === "token" && !process.env.EMDASH_TOKEN) missing.push("EMDASH_TOKEN (admin-scope EmDash API token)");
  if (AUTH === "token" && !isLocal && !(process.env.E2E_CF_ACCESS_CLIENT_ID && process.env.E2E_CF_ACCESS_CLIENT_SECRET)) {
    missing.push("E2E_CF_ACCESS_CLIENT_ID + E2E_CF_ACCESS_CLIENT_SECRET (Access service token university-e2e; deliberately not CF_ACCESS_CLIENT_*, which other tools set shell-wide)");
  }
  if (!["token", "dev-bypass"].includes(AUTH)) missing.push(`E2E_AUTH must be token or dev-bypass, got "${AUTH}"`);
  if (missing.length) throw new Error(`E2E config missing:\n  - ${missing.join("\n  - ")}\nSee tests/e2e/README.md.`);
}

// Headers that get a request past Cloudflare Access (service token). Access
// covers /_emdash only, so on public pages they are inert; sending them on the
// visitor check keeps it working if Access is ever widened to the whole host.
export function accessHeaders() {
  const h = {};
  if (process.env.E2E_CF_ACCESS_CLIENT_ID) h["CF-Access-Client-Id"] = process.env.E2E_CF_ACCESS_CLIENT_ID;
  if (process.env.E2E_CF_ACCESS_CLIENT_SECRET) h["CF-Access-Client-Secret"] = process.env.E2E_CF_ACCESS_CLIENT_SECRET;
  return h;
}

export function editorHeaders() {
  const h = accessHeaders();
  if (AUTH === "token") h.Authorization = `Bearer ${process.env.EMDASH_TOKEN}`;
  return h;
}

// Small REST client over Playwright's APIRequestContext (shares cookies with the
// page in dev-bypass mode). Throws with the status and EmDash error code.
export function api(request) {
  return async function call(method, path, body) {
    const res = await request.fetch(`${BASE_URL}/_emdash/api${path}`, {
      method,
      headers: { "content-type": "application/json", "x-emdash-request": "1", ...editorHeaders() },
      data: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`${method} ${path} -> ${res.status()} non-JSON: ${text.slice(0, 200)}`);
    }
    if (!res.ok() || json.success === false) {
      throw new Error(`${method} ${path} -> ${res.status()} ${json.error?.code || ""} ${json.error?.message || ""}`.trim());
    }
    return json.data;
  };
}

// Find an entry by slug across published and draft lists (same approach as
// scripts/emdash/apply.mjs).
export async function findBySlug(call, collection, slug) {
  for (const status of [undefined, "draft"]) {
    let cursor;
    do {
      const q = new URLSearchParams({ limit: "100" });
      if (cursor) q.set("cursor", cursor);
      if (status) q.set("status", status);
      const d = await call("GET", `/content/${collection}?${q}`);
      const hit = (d.items || []).find((it) => it.slug === slug);
      if (hit) return hit;
      cursor = d.nextCursor;
    } while (cursor);
  }
  return null;
}
