#!/usr/bin/env node
// Make existing note boxes (aside) and collapsible sections (details) editable
// (issue #15): rewrite each page's stored box as start marker + content + end
// marker (flattenBoxes in lib/md-to-pt.mjs). The page renders the same; the
// editor can then change the text inside the box.
//
//   node flatten-boxes.mjs --url http://localhost:4321 --dev-bypass            # dry run: list what would change
//   node flatten-boxes.mjs --url http://localhost:4321 --dev-bypass --apply    # write + publish
//   EMDASH_TOKEN=... node flatten-boxes.mjs --url https://<site> [--apply] [--production] [--header "K: V"]
//
// Works on the page as it is now in the CMS (editors' changes elsewhere on the
// page are kept), not on the migration seed. Only box blocks change; every other
// block is untouched, keys included. A page with unpublished draft changes is
// skipped (publishing would publish someone's draft). Dry run by default.
// university.etop.tech and the production Worker are refused unless --production
// is passed: changing live content is BJ's call.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { flattenBoxes } from "./lib/md-to-pt.mjs";

const PROD_HOSTS = /^(www\.)?university\.etop\.tech$|^university-emdash\.williampote\.workers\.dev$/;

export function needsFlatten(body) {
  return Array.isArray(body) && body.some((b) => (b._type === "aside" || b._type === "details") && Array.isArray(b.content));
}

function parseArgs(argv) {
  const a = { url: "", token: process.env.EMDASH_TOKEN || "", apply: false, production: false, devBypass: false, headers: {} };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--url") a.url = argv[++i].replace(/\/$/, "");
    else if (k === "--apply") a.apply = true;
    else if (k === "--production") a.production = true;
    else if (k === "--dev-bypass") a.devBypass = true;
    else if (k === "--header") {
      const [hk, ...rest] = argv[++i].split(":");
      a.headers[hk.trim()] = rest.join(":").trim();
    } else throw new Error(`unknown option ${k}`);
  }
  if (!a.url) throw new Error("--url is required");
  const host = new URL(a.url).hostname;
  if (PROD_HOSTS.test(host) && !a.production) throw new Error(`${host} is production: pass --production only with BJ's go-ahead`);
  if (a.devBypass && !/^(localhost|127\.0\.0\.1)$/.test(host)) throw new Error("--dev-bypass only exists under astro dev (localhost)");
  if (!a.devBypass && !a.token) throw new Error("set EMDASH_TOKEN (editor/admin API token), or use --dev-bypass on localhost");
  return a;
}

async function client(a) {
  const headers = { "content-type": "application/json", "x-emdash-request": "1", ...a.headers };
  if (a.devBypass) {
    const r = await fetch(`${a.url}/_emdash/api/setup/dev-bypass?redirect=/_emdash/api/auth/me`, { redirect: "manual" });
    const cookies = (r.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]);
    if (!cookies.length) throw new Error(`dev-bypass gave no session cookie (HTTP ${r.status})`);
    headers.cookie = cookies.join("; ");
  } else headers.authorization = `Bearer ${a.token}`;
  return async function api(method, path, body) {
    const r = await fetch(`${a.url}/_emdash/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { success: false, error: { code: `HTTP_${r.status}`, message: text.slice(0, 200) } }; }
    if (!r.ok || json.success === false) throw new Error(`${method} ${path} -> ${r.status} ${json.error?.code || ""} ${json.error?.message || ""}`.trim());
    return json.data;
  };
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const api = await client(a);
  const items = [];
  for (const status of [undefined, "draft"]) {
    let cursor;
    do {
      const q = new URLSearchParams({ limit: "100" });
      if (cursor) q.set("cursor", cursor);
      if (status) q.set("status", status);
      const d = await api("GET", `/content/docs?${q}`);
      for (const it of d.items || []) if (!items.some((x) => x.id === it.id)) items.push(it);
      cursor = d.nextCursor;
    } while (cursor);
  }
  const tally = { pages: items.length, toChange: 0, changed: 0, skippedDraft: 0, failed: 0 };
  for (const it of items) {
    if (!needsFlatten(it.data?.body)) continue;
    const full = await api("GET", `/content/docs/${it.id}`);
    const item = full.item;
    const before = item.data.body;
    const after = flattenBoxes(before);
    const boxes = before.filter((b) => b._type === "aside" || b._type === "details").length;
    if (item.draftRevisionId) {
      tally.skippedDraft++;
      console.log(`skip ${item.slug}: has unpublished draft changes (publish or discard them first)`);
      continue;
    }
    tally.toChange++;
    console.log(`${a.apply ? "write" : "would write"} ${item.slug}: ${boxes} box(es), ${before.length} -> ${after.length} blocks`);
    if (!a.apply) continue;
    try {
      await api("PUT", `/content/docs/${item.id}`, { data: { ...item.data, body: after }, _rev: full._rev });
      await api("POST", `/content/docs/${item.id}/publish`, {});
      tally.changed++;
    } catch (e) {
      tally.failed++;
      console.error(`  ${item.slug}: ${e.message}`);
    }
  }
  console.log(`\n${JSON.stringify(tally)}${a.apply ? "" : " (dry run: nothing written; add --apply)"}`);
  process.exit(tally.failed ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((e) => { console.error(e.message || e); process.exit(2); });
}
