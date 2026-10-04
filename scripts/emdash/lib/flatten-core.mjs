// Box flattening, shared by the converter (md-to-pt.mjs), the REST tool
// (flatten-boxes.mjs) and the browser-console variant it prints
// (--browser-script). NO imports and no Node APIs: every function here is also
// pasted into a browser page as source text, so it must stand alone.

// The EmDash editor shows a block type it does not know (aside, details) as a
// locked card (issue #15). Store each box as a start marker, its content as
// ordinary top-level blocks, and an end marker. Keys: the start marker keeps the
// box's key and the end marker adds "e", so no other block's key changes. Any
// step hint on the box (listContinuation/level) stays on the start marker; the
// theme treats start..end as one unit inside that step.
export function flattenBoxes(blocks) {
  const out = [];
  for (const b of blocks) {
    if ((b._type === "aside" || b._type === "details") && Array.isArray(b.content)) {
      const { _type, _key, content, ...fields } = b;
      out.push({ _type: `${_type}Start`, _key, ...fields });
      out.push(...flattenBoxes(content));
      out.push({ _type: `${_type}End`, _key: `${_key}e`, closes: _type });
    } else {
      out.push(b);
    }
  }
  return out;
}

export function needsFlatten(body) {
  return Array.isArray(body) && body.some((b) => (b._type === "aside" || b._type === "details") && Array.isArray(b.content));
}

// Same as build-seed.mjs fingerprint(), with the hash function passed in (Node
// crypto or WebCrypto). A test checks both give the same value.
export async function fingerprintWith(data, managedFields, sha256hex) {
  const canon = {};
  for (const k of managedFields) if (data[k] != null && data[k] !== "") canon[k] = data[k];
  return "sha256:" + (await sha256hex(JSON.stringify(canon))).slice(0, 32);
}

// The whole run. api(method, path, body) -> response "data" (throws on error).
// Phase 1 reads every page and plans the change; phase 2 hands ALL before-states
// to saveBackups() (which must persist them, or throw); only then phase 3 writes.
export async function runFlatten({ api, apply, managedFields, sha256hex, saveBackups, log = console.log }) {
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
  if (!items.length) throw new Error("the docs listing is empty: wrong site, or this session cannot read content");
  // Without draft visibility the "skip pages with unpublished drafts" guard is blind.
  if (!items.some((it) => "draftRevisionId" in it)) {
    throw new Error("the listing carries no draftRevisionId at all: this token/session cannot see drafts (needs read_drafts), so a page's draft could be published. Refusing.");
  }
  const noBody = items.filter((it) => !Array.isArray(it.data?.body));
  if (noBody.length) log(`warning: ${noBody.length} listed page(s) came without a body; reading those one by one`);

  const tally = { pages: items.length, toChange: 0, changed: 0, hashRefreshed: 0, skippedDraft: 0, failed: 0 };
  const plans = [];
  for (const it of items) {
    let body = it.data?.body;
    let full;
    if (!Array.isArray(body)) {
      full = await api("GET", `/content/docs/${it.id}`);
      body = full.item?.data?.body;
    }
    if (!needsFlatten(body)) continue;
    full = full || (await api("GET", `/content/docs/${it.id}`));
    const item = full.item;
    if (!("draftRevisionId" in item)) throw new Error(`${item.slug}: item has no draftRevisionId field; refusing (cannot tell if it has a draft)`);
    if (item.draftRevisionId || item.status !== "published") {
      tally.skippedDraft++;
      log(`skip ${item.slug}: ${item.status !== "published" ? `status is ${item.status} (publishing would make it live)` : "has unpublished draft changes (publish or discard them first)"}`);
      continue;
    }
    const before = item.data.body;
    const data = { ...item.data, body: flattenBoxes(before) };
    // Untouched since the migration: keep it "untouched" for apply.mjs by refreshing the hash.
    let refreshed = false;
    if (item.data.migration_hash && (await fingerprintWith(item.data, managedFields, sha256hex)) === item.data.migration_hash) {
      data.migration_hash = await fingerprintWith(data, managedFields, sha256hex);
      refreshed = true;
    }
    const boxes = before.filter((b) => b._type === "aside" || b._type === "details").length;
    tally.toChange++;
    log(`${apply ? "write" : "would write"} ${item.slug}: ${boxes} box(es), ${before.length} -> ${data.body.length} blocks${refreshed ? ", migration_hash refreshed" : ""}`);
    plans.push({ id: item.id, slug: item.slug, rev: full._rev, before: full, data, refreshed });
  }
  if (!apply || !plans.length) return { tally, plans };

  await saveBackups(plans.map((p) => ({ slug: p.slug, id: p.id, before: p.before })));
  for (const p of plans) {
    try {
      await api("PUT", `/content/docs/${p.id}`, { data: p.data, _rev: p.rev });
      await api("POST", `/content/docs/${p.id}/publish`, {});
      tally.changed++;
      if (p.refreshed) tally.hashRefreshed++;
    } catch (e) {
      tally.failed++;
      log(`  ${p.slug}: ${e.message}`);
    }
  }
  return { tally, plans };
}
