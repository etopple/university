import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import vm from "node:vm";
import { fingerprint, MANAGED_FIELDS } from "../build-seed.mjs";
import { runFlatten, fingerprintWith } from "../lib/flatten-core.mjs";
import { browserScript } from "../flatten-boxes.mjs";

const nodeSha = async (s) => createHash("sha256").update(s).digest("hex");
const webSha = async (s) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
const box = { _type: "aside", _key: "k1", variant: "tip", content: [{ _type: "block", _key: "k2", children: [{ _type: "span", text: "x" }] }] };

// A fake EmDash API over an in-memory list of items; records every call in order.
function fakeSite(items, { listFields = true, bodyInList = true } = {}) {
  const calls = [];
  const strip = (it) => {
    const o = structuredClone(it);
    if (!listFields) delete o.draftRevisionId;
    if (!bodyInList) delete o.data.body;
    return o;
  };
  const api = async (method, path, body) => {
    calls.push(`${method} ${path.split("?")[0]}`);
    if (method === "GET" && path.startsWith("/content/docs?")) return { items: path.includes("status=draft") ? [] : items.map(strip) };
    const id = path.split("/")[3];
    const it = items.find((x) => x.id === id);
    if (method === "GET") return { item: structuredClone(it), _rev: `rev-${id}` };
    if (method === "PUT") { assert.equal(body._rev, `rev-${id}`); it.data = body.data; return {}; }
    if (method === "POST") return {};
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { api, calls };
}
const page = (id, extra = {}, data = {}) => {
  const d = { title: `T${id}`, body: [box], legacy_source: `src/${id}.md`, ...data };
  return { id, slug: `p/${id}`, status: "published", draftRevisionId: null, ...extra, data: { ...d, migration_hash: fingerprint(d) } };
};
const run = (api, o = {}) => runFlatten({ api, apply: true, managedFields: MANAGED_FIELDS, sha256hex: nodeSha, saveBackups: async () => {}, log: () => {}, ...o });

test("WebCrypto and Node fingerprints match build-seed's", async () => {
  const d = { title: "A", body: [box], migration_hash: "ignored" };
  assert.equal(await fingerprintWith(d, MANAGED_FIELDS, nodeSha), fingerprint(d));
  assert.equal(await fingerprintWith(d, MANAGED_FIELDS, webSha), fingerprint(d));
});

test("untouched page: boxes flattened and migration_hash refreshed, so apply.mjs still sees it untouched", async () => {
  const items = [page("a")];
  const { api } = fakeSite(items);
  const { tally } = await run(api);
  assert.deepEqual([tally.changed, tally.hashRefreshed], [1, 1]);
  const d = items[0].data;
  assert.deepEqual(d.body.map((b) => b._type), ["asideStart", "block", "asideEnd"]);
  assert.equal(d.migration_hash, fingerprint(d));
});

test("page edited in the CMS: flattened, hash left alone (it was already drifted)", async () => {
  const p = page("b");
  p.data.title = "Edited";
  const old = p.data.migration_hash;
  const { api } = fakeSite([p]);
  const { tally } = await run(api);
  assert.deepEqual([tally.changed, tally.hashRefreshed], [1, 0]);
  assert.equal(p.data.migration_hash, old);
});

test("drafts and unpublished pages are skipped; nothing is written for them", async () => {
  const items = [page("c", { draftRevisionId: "r9" }), page("d", { status: "draft" })];
  const { api, calls } = fakeSite(items);
  const { tally } = await run(api);
  assert.deepEqual([tally.skippedDraft, tally.changed], [2, 0]);
  assert.ok(!calls.some((c) => c.startsWith("PUT")));
});

test("refuses when the listing carries no draftRevisionId (no read_drafts)", async () => {
  const { api, calls } = fakeSite([page("e")], { listFields: false });
  await assert.rejects(run(api), /cannot see drafts/);
  assert.ok(!calls.some((c) => c.startsWith("PUT")));
});

test("all backups are saved before the first write; a failed backup writes nothing", async () => {
  const items = [page("f"), page("g")];
  const { api, calls } = fakeSite(items);
  let backedUp;
  await run(api, { saveBackups: async (pages) => { backedUp = pages; calls.push("BACKUP"); } });
  assert.deepEqual(backedUp.map((p) => p.slug), ["p/f", "p/g"]);
  assert.equal(backedUp[0].before.item.data.body[0]._type, "aside"); // the BEFORE state
  const firstPut = calls.findIndex((c) => c.startsWith("PUT"));
  assert.ok(calls.indexOf("BACKUP") < firstPut);
  const second = fakeSite([page("h")]);
  await assert.rejects(run(second.api, { saveBackups: async () => { throw new Error("disk full"); } }), /disk full/);
  assert.ok(!second.calls.some((c) => c.startsWith("PUT")));
});

test("a listing without bodies is warned about and read page by page", async () => {
  const items = [page("i")];
  const { api } = fakeSite(items, { bodyInList: false });
  const logs = [];
  const { tally } = await run(api, { log: (m) => logs.push(m) });
  assert.ok(logs.some((l) => /without a body/.test(l)));
  assert.equal(tally.changed, 1);
});

test("dry run writes nothing and saves no backup", async () => {
  const { api, calls } = fakeSite([page("j")]);
  let backups = 0;
  const { tally } = await run(api, { apply: false, saveBackups: async () => backups++ });
  assert.deepEqual([tally.toChange, tally.changed, backups], [1, 0, 0]);
  assert.ok(!calls.some((c) => c.startsWith("PUT") || c.startsWith("POST")));
});

test("the browser script is valid JavaScript and contains the shared core", () => {
  const src = browserScript();
  assert.doesNotThrow(() => new vm.Script(src));
  assert.match(src, /function flattenBoxes/);
  assert.match(src, /async function runFlatten/);
  assert.match(src, /credentials: "same-origin"/);
});
