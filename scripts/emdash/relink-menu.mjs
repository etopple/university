#!/usr/bin/env node
// Re-point the docs-sidebar's page links at the pages, by slug (issue #25).
//
// Why links lose their page: EmDash's setup wizard re-applies .emdash/seed.json
// when the first admin signs in. It deletes the menu's items and recreates them,
// resolving each `ref: "docs:<slug>"` only against content it applied in that same
// run. With "Empty site" it applies no content, so every page link is stored with
// reference_id NULL and renders as "/#". (Prod: 2026-10-04 04:56:45Z, 13 s after the
// first admin user was created.)
//
// This tool walks the seed's menu tree and the stored items in parallel (same
// parent, same sort order, same label, same type), and for every page item whose
// reference is missing or wrong writes one UPDATE keyed by the item's id, setting
// the reference to the published page with the seed's slug. Items with no match
// are left alone and listed. Nothing else changes: ids, order, labels stay.
//
//   node relink-menu.mjs --items items.json [--menu docs-sidebar]   # writes out/relink-menu.sql + out/relink-menu-check.sql
//   (items.json = `wrangler d1 execute DB --remote --json --command "SELECT * FROM _emdash_menu_items"`)
//
// Review out/relink-menu-check.sql (a SELECT of old -> new for every row), run it,
// then run out/relink-menu.sql with `wrangler d1 execute DB --remote --file`.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED = join(HERE, "..", "..", ".emdash", "seed.json");
const q = (v) => (v == null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);

// rows: _emdash_menu_items rows of ONE menu. Returns { updates, unmatched, ok }.
export function relinkPlan(seedItems, rows) {
  const kids = new Map();
  for (const r of rows) {
    const k = r.parent_id ?? "";
    if (!kids.has(k)) kids.set(k, []);
    kids.get(k).push(r);
  }
  for (const list of kids.values()) list.sort((a, b) => a.sort_order - b.sort_order);
  const updates = [], unmatched = [], ok = [];
  const walk = (seedList, parentId, path) => {
    const stored = kids.get(parentId ?? "") || [];
    seedList.forEach((s, i) => {
      const r = stored[i];
      const where = `${path}/${i} "${s.label}"`;
      if (!r || r.type !== s.type || r.label !== (s.label || "")) {
        unmatched.push({ where, reason: r ? `stored item is ${r.type} "${r.label}"` : "no stored item at this position" });
        return; // its children cannot be matched either
      }
      if (s.type === "page") {
        const slug = String(s.ref || "").replace(/^[^:]+:/, "");
        const collection = s.collection || "docs";
        if (!slug) unmatched.push({ where, reason: "seed item has no ref" });
        else updates.push({ id: r.id, label: r.label, slug, collection, old: { reference_collection: r.reference_collection, reference_id: r.reference_id } });
      } else ok.push(r.id);
      if (s.children?.length) walk(s.children, r.id, `${path}/${i}`);
    });
    if (stored.length > seedList.length) for (const r of stored.slice(seedList.length)) unmatched.push({ where: `${path}/* "${r.label}"`, reason: "stored item not in the seed menu (left alone)" });
  };
  walk(seedItems, null, "");
  return { updates, unmatched, ok };
}

const target = (u) => `(SELECT id FROM "ec_${u.collection}" WHERE slug = ${q(u.slug)} AND locale = 'en' AND status = 'published' AND deleted_at IS NULL)`;

// One statement per item. The guard makes a row whose page does not exist a no-op
// (reference_id would otherwise become NULL again).
export function updateSql(updates) {
  return updates.map((u) =>
    `UPDATE "_emdash_menu_items" SET reference_collection = ${q(u.collection)}, reference_id = ${target(u)} WHERE id = ${q(u.id)} AND type = 'page' AND label = ${q(u.label)} AND EXISTS ${target(u)};`,
  ).join("\n") + "\n";
}

// Dry run: old and new reference for every row, and whether the page exists.
export function checkSql(updates) {
  // json_each, not UNION ALL: D1 caps compound SELECTs at a few dozen terms.
  const pairs = JSON.stringify(updates.map((u) => ({ id: u.id, slug: u.slug })));
  return `SELECT m.id, m.label, m.reference_id AS old_ref, json_extract(v.value, '$.slug') AS slug, d.id AS new_ref, d.status FROM "_emdash_menu_items" m JOIN json_each(${q(pairs)}) v ON json_extract(v.value, '$.id') = m.id LEFT JOIN "ec_docs" d ON d.slug = json_extract(v.value, '$.slug') AND d.locale = 'en' AND d.status = 'published' AND d.deleted_at IS NULL ORDER BY v.key;
`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const argv = process.argv.slice(2);
  const opt = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
  const itemsFile = opt("--items");
  if (!itemsFile) { console.error("usage: node relink-menu.mjs --items <wrangler --json export of _emdash_menu_items> [--menu-id <id>]"); process.exit(2); }
  const seed = JSON.parse(readFileSync(SEED, "utf8"));
  const menu = seed.menus.find((m) => m.name === opt("--menu", "docs-sidebar"));
  let rows = JSON.parse(readFileSync(itemsFile, "utf8"));
  rows = Array.isArray(rows) && rows[0]?.results ? rows[0].results : rows;
  const menuIds = [...new Set(rows.map((r) => r.menu_id))];
  const menuId = opt("--menu-id", menuIds.length === 1 ? menuIds[0] : "");
  if (!menuId) { console.error(`several menus in the export (${menuIds.join(", ")}): pass --menu-id`); process.exit(2); }
  const plan = relinkPlan(menu.items, rows.filter((r) => r.menu_id === menuId));
  mkdirSync(join(HERE, "out"), { recursive: true });
  writeFileSync(join(HERE, "out", "relink-menu.sql"), updateSql(plan.updates));
  writeFileSync(join(HERE, "out", "relink-menu-check.sql"), checkSql(plan.updates));
  const missing = plan.updates.filter((u) => !u.old.reference_id).length;
  console.log(`page items matched: ${plan.updates.length} (${missing} with no reference now); other items matched: ${plan.ok.length}; unmatched: ${plan.unmatched.length}`);
  for (const u of plan.unmatched) console.log(`  unmatched ${u.where}: ${u.reason}`);
  console.log("wrote out/relink-menu-check.sql (review: old -> new per row) and out/relink-menu.sql");
}
