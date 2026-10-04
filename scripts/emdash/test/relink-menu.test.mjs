import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync as Database } from "node:sqlite";
import { relinkPlan, updateSql, checkSql } from "../relink-menu.mjs";

const seedItems = [
  { type: "page", collection: "docs", ref: "docs:index", label: "Home" },
  { type: "custom", label: "About", url: "#", children: [
    { type: "page", collection: "docs", ref: "docs:about/values", label: "Values" },
    { type: "page", collection: "docs", ref: "docs:about/gone", label: "Gone" },
  ] },
];

// What EmDash's setup wizard leaves behind with "Empty site": same tree, page refs NULL.
function db() {
  const d = new Database(":memory:");
  d.exec(`CREATE TABLE ec_docs (id TEXT, slug TEXT, locale TEXT, status TEXT, deleted_at TEXT);
    CREATE TABLE _emdash_menu_items (id TEXT, menu_id TEXT, parent_id TEXT, sort_order INT, type TEXT, reference_collection TEXT, reference_id TEXT, custom_url TEXT, label TEXT);
    INSERT INTO ec_docs VALUES ('D1','index','en','published',NULL),('D2','about/values','en','published',NULL),('D3','about/draft','en','draft',NULL);
    INSERT INTO _emdash_menu_items VALUES
      ('i1','m','',0,'page',NULL,NULL,NULL,'Home'),
      ('i2','m',NULL,1,'custom',NULL,NULL,'#','About'),
      ('i3','m','i2',0,'page',NULL,NULL,NULL,'Values'),
      ('i4','m','i2',1,'page',NULL,NULL,NULL,'Gone');`);
  d.exec("UPDATE _emdash_menu_items SET parent_id = NULL WHERE parent_id = ''");
  return d;
}

test("setup-wizard menu (refs NULL) is re-pointed by slug; ids, order and labels unchanged", () => {
  const d = db();
  const before = d.prepare("SELECT id, parent_id, sort_order, label, type FROM _emdash_menu_items ORDER BY id").all().map((r) => ({ ...r }));
  const plan = relinkPlan(seedItems, d.prepare("SELECT * FROM _emdash_menu_items").all().map((r) => ({ ...r })));
  assert.deepEqual(plan.updates.map((u) => [u.id, u.slug]), [["i1", "index"], ["i3", "about/values"], ["i4", "about/gone"]]);
  assert.equal(plan.unmatched.length, 0);
  // Dry run shows old -> new for every row; the missing page shows new_ref NULL.
  const check = d.prepare(checkSql(plan.updates)).all().map((r) => ({ ...r }));
  assert.deepEqual(check.map((r) => [r.id, r.old_ref, r.new_ref]), [["i1", null, "D1"], ["i3", null, "D2"], ["i4", null, null]]);
  d.exec(updateSql(plan.updates));
  const after = d.prepare("SELECT id, reference_collection c, reference_id r FROM _emdash_menu_items ORDER BY id").all().map((r) => ({ ...r }));
  assert.deepEqual(after, [{ id: "i1", c: "docs", r: "D1" }, { id: "i2", c: null, r: null }, { id: "i3", c: "docs", r: "D2" }, { id: "i4", c: null, r: null }]);
  assert.deepEqual(d.prepare("SELECT id, parent_id, sort_order, label, type FROM _emdash_menu_items ORDER BY id").all().map((r) => ({ ...r })), before);
  // Idempotent.
  d.exec(updateSql(plan.updates));
  assert.deepEqual(d.prepare("SELECT id, reference_collection c, reference_id r FROM _emdash_menu_items ORDER BY id").all().map((r) => ({ ...r })), after);
});

test("an item whose stored label or type differs from the seed is left alone and listed (with its children)", () => {
  const d = db();
  d.exec("UPDATE _emdash_menu_items SET label = 'About us (edited)' WHERE id = 'i2'");
  const plan = relinkPlan(seedItems, d.prepare("SELECT * FROM _emdash_menu_items").all().map((r) => ({ ...r })));
  assert.deepEqual(plan.updates.map((u) => u.id), ["i1"]);
  assert.equal(plan.unmatched.length, 1);
  assert.match(plan.unmatched[0].reason, /custom "About us \(edited\)"/);
});

test("a draft page is never linked", () => {
  const d = db();
  const plan = relinkPlan([{ type: "page", collection: "docs", ref: "docs:about/draft", label: "Home" }], d.prepare("SELECT * FROM _emdash_menu_items WHERE parent_id IS NULL").all().map((r) => ({ ...r })));
  d.exec(updateSql(plan.updates));
  assert.equal(d.prepare("SELECT reference_id FROM _emdash_menu_items WHERE id = 'i1'").get().reference_id, null);
});
