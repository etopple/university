#!/usr/bin/env node
// Load the migrated content into an EmDash instance. Safe to re-run.
//
// Local SQLite (dev):
//   node apply.mjs --local [--database ./data.db]
//     -> runs `npx emdash seed .emdash/seed.json --on-conflict update` from the repo root
//        (needs the `emdash` package installed at the root by the integration lane).
//
// Remote instance (preview / D1), over the REST API:
//   EMDASH_TOKEN=... node apply.mjs --url https://<preview> [--dry-run] [--overwrite] [--header "K: V"]
//     - creates any page that is missing (matched by slug) and publishes it;
//     - skips a page whose migration_hash matches (nothing changed);
//     - a page that exists with a different hash was changed in the CMS or in the
//       markdown: it is REPORTED, and only rewritten with --overwrite (pre-cutover only);
//     - the docs-sidebar menu is rebuilt when it is empty, or when it differs and --overwrite is set.
//   The docs collection must already exist: EmDash creates it from .emdash/seed.json on first boot.
//
// Run `node build-seed.mjs` first; this script only reads .emdash/seed.json.

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const SEED_PATH = join(ROOT, ".emdash", "seed.json");

function parseArgs(argv) {
  const a = { local: false, database: "./data.db", url: "", token: process.env.EMDASH_TOKEN || "", dryRun: false, overwrite: false, headers: {} };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => argv[++i];
    if (k === "--local") a.local = true;
    else if (k === "--database") a.database = v();
    else if (k === "--url") a.url = v().replace(/\/$/, "");
    else if (k === "--token") a.token = v();
    else if (k === "--dry-run") a.dryRun = true;
    else if (k === "--overwrite") a.overwrite = true;
    else if (k === "--header") {
      const [hk, ...rest] = v().split(":");
      a.headers[hk.trim()] = rest.join(":").trim();
    } else throw new Error(`unknown option ${k}`);
  }
  if (process.env.EMDASH_HEADERS) {
    for (const line of process.env.EMDASH_HEADERS.split("\n")) {
      const [hk, ...rest] = line.split(":");
      if (hk.trim()) a.headers[hk.trim()] = rest.join(":").trim();
    }
  }
  return a;
}

function applyLocal(a) {
  const args = ["emdash", "seed", SEED_PATH, "--on-conflict", "update", "--database", a.database];
  console.log(`> npx ${args.join(" ")}  (cwd ${ROOT})`);
  if (a.dryRun) return 0;
  const r = spawnSync("npx", args, { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" });
  return r.status ?? 1;
}

function client(a) {
  return async function api(method, path, body) {
    const r = await fetch(a.url + "/_emdash/api" + path, {
      method,
      headers: { authorization: `Bearer ${a.token}`, "content-type": "application/json", "x-emdash-request": "1", ...a.headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { success: false, error: { code: `HTTP_${r.status}`, message: text.slice(0, 200) } };
    }
    if (!r.ok || json.success === false) {
      const e = new Error(`${method} ${path} -> ${r.status} ${json.error?.code || ""} ${json.error?.message || ""}`.trim());
      e.status = r.status;
      throw e;
    }
    return json.data;
  };
}

async function listAll(api, collection) {
  const items = [];
  for (const status of [undefined, "draft"]) {
    let cursor;
    do {
      const q = new URLSearchParams({ limit: "100" });
      if (cursor) q.set("cursor", cursor);
      if (status) q.set("status", status);
      const d = await api("GET", `/content/${collection}?${q}`);
      items.push(...(d.items || []));
      cursor = d.nextCursor;
    } while (cursor);
  }
  const bySlug = new Map();
  for (const it of items) if (it.slug && !bySlug.has(it.slug)) bySlug.set(it.slug, it);
  return bySlug;
}

// Desired menu as a flat, depth-first list with stable comparison keys.
function flattenMenu(items, slugToId, parentPath = "", out = []) {
  items.forEach((it, i) => {
    const path = `${parentPath}/${i}`;
    out.push({
      path,
      parentPath: parentPath || null,
      sortOrder: i,
      type: it.type,
      label: it.label,
      referenceCollection: it.type === "page" ? it.collection : undefined,
      referenceId: it.type === "page" ? slugToId.get(it.ref.replace(/^docs:/, "")) : undefined,
      customUrl: it.type === "custom" ? it.url : undefined,
      target: it.target,
      titleAttr: it.titleAttr,
      cssClasses: it.cssClasses,
    });
    if (it.children) flattenMenu(it.children, slugToId, path, out);
  });
  return out;
}

function menuSignature(flat) {
  return flat.map((x) => [x.parentPath, x.sortOrder, x.type, x.label, x.referenceId || "", x.customUrl || "", x.cssClasses || ""].join("\u0001")).join("\n");
}

function existingSignature(items) {
  // Rebuild paths from parentId + sortOrder.
  const byParent = new Map();
  for (const it of items) {
    const p = it.parentId || "";
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p).push(it);
  }
  const out = [];
  const walk = (pid, path) => {
    (byParent.get(pid) || []).sort((x, y) => x.sortOrder - y.sortOrder).forEach((it, i) => {
      const p = `${path}/${i}`;
      out.push({ parentPath: path || null, sortOrder: i, type: it.type, label: it.label, referenceId: it.referenceId, customUrl: it.customUrl, cssClasses: it.cssClasses });
      walk(it.id, p);
    });
  };
  walk("", "");
  return menuSignature(out);
}

async function applyRemote(a) {
  if (!a.token) throw new Error("set EMDASH_TOKEN or pass --token (an admin/editor token for the target site)");
  const api = client(a);
  const seed = JSON.parse(readFileSync(SEED_PATH, "utf8"));
  const coll = seed.collections[0].slug;
  const entries = seed.content[coll];
  const tally = { created: 0, unchanged: 0, updated: 0, drifted: 0, failed: 0 };
  const drift = [];

  try {
    await api("GET", `/schema/collections/${coll}`);
  } catch (e) {
    throw new Error(`collection "${coll}" not found on ${a.url} (${e.message}). Boot the site once with .emdash/seed.json so EmDash creates the schema.`);
  }

  const live = await listAll(api, coll);
  console.log(`${a.url}: ${live.size} existing ${coll} entries, ${entries.length} in seed${a.dryRun ? " (dry run)" : ""}`);

  for (const e of entries) {
    const cur = live.get(e.slug);
    try {
      if (!cur) {
        tally.created++;
        if (a.dryRun) continue;
        const d = await api("POST", `/content/${coll}`, { slug: e.slug, data: e.data });
        const id = d.item?.id || d.id;
        await api("POST", `/content/${coll}/${id}/publish`, {});
        live.set(e.slug, { id, slug: e.slug });
        continue;
      }
      const full = await api("GET", `/content/${coll}/${cur.id}`);
      if (full.item?.data?.migration_hash === e.data.migration_hash) {
        tally.unchanged++;
        continue;
      }
      if (!a.overwrite) {
        tally.drifted++;
        drift.push(e.slug);
        continue;
      }
      tally.updated++;
      if (a.dryRun) continue;
      await api("PUT", `/content/${coll}/${cur.id}`, { data: e.data, _rev: full._rev });
      await api("POST", `/content/${coll}/${cur.id}/publish`, {});
    } catch (err) {
      tally.failed++;
      console.error(`  ${e.slug}: ${err.message}`);
    }
  }

  // Sidebar menu.
  const menuDef = seed.menus[0];
  const slugToId = new Map([...live].map(([s, v]) => [s, v.id]));
  const desired = flattenMenu(menuDef.items, slugToId);
  let menu;
  try {
    menu = await api("GET", `/menus/${menuDef.name}`);
  } catch (err) {
    if (err.status !== 404) throw err;
    console.log(`menu ${menuDef.name}: creating`);
    if (!a.dryRun) menu = await api("POST", "/menus", { name: menuDef.name, label: menuDef.label });
    menu = { items: [], ...(menu || {}) };
  }
  const same = existingSignature(menu.items || []) === menuSignature(desired);
  let menuAction = same ? "unchanged" : (menu.items || []).length === 0 || a.overwrite ? "rebuilt" : "drifted (re-run with --overwrite to rebuild)";
  if (!same && menuAction === "rebuilt" && !a.dryRun) {
    // Delete deepest items first, then recreate in order.
    const items = [...(menu.items || [])];
    const depth = (it) => (it.parentId ? 1 + depth(items.find((x) => x.id === it.parentId) || {}) : 0);
    for (const it of items.sort((x, y) => depth(y) - depth(x))) await api("DELETE", `/menus/${menuDef.name}/items/${it.id}`);
    const idByPath = new Map();
    for (const x of desired) {
      const body = { type: x.type, label: x.label, sortOrder: x.sortOrder };
      for (const k of ["referenceCollection", "referenceId", "customUrl", "target", "titleAttr", "cssClasses"]) if (x[k]) body[k] = x[k];
      if (x.parentPath) body.parentId = idByPath.get(x.parentPath);
      const d = await api("POST", `/menus/${menuDef.name}/items`, body);
      idByPath.set(x.path, d.item?.id || d.id);
    }
  }
  console.log(`pages: ${JSON.stringify(tally)}; menu ${menuDef.name}: ${menuAction} (${desired.length} items)`);
  if (drift.length) console.log(`changed since migration (left alone): ${drift.join(", ")}`);
  return tally.failed ? 1 : 0;
}

const a = parseArgs(process.argv.slice(2));
if (!a.local && !a.url) {
  console.error("usage: node apply.mjs --local [--database ./data.db]  |  node apply.mjs --url https://site [--dry-run] [--overwrite]");
  process.exit(2);
}
try {
  process.exit(a.local ? applyLocal(a) : await applyRemote(a));
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
