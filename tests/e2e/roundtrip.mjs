#!/usr/bin/env node
// Real-editor round-trip: open pages in the EmDash editor, make a no-op edit
// (type two characters, delete them), Save and Publish, and record what the
// editor did to the stored Portable Text. Proves that what the editor writes
// back still renders the same (compare the site before and after with
// scripts/emdash/parity.mjs, which checks text AND list structure).
//
//   node roundtrip.mjs --base http://localhost:4321 [--slugs a/b,c/d | --all] [--out out/roundtrip]
//
// LOCAL ONLY: it publishes every page it touches. It refuses any host but
// localhost/127.0.0.1 (dev-bypass sign-in exists only under `astro dev`).
// Writes <out>/results.json and <out>/<slug>.{before,after}.json.

import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

function args(argv) {
  const a = { base: "", slugs: null, all: false, out: "" };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--base") a.base = argv[++i].replace(/\/$/, "");
    else if (k === "--slugs") a.slugs = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (k === "--all") a.all = true;
    else if (k === "--out") a.out = argv[++i];
    else throw new Error(`unknown arg ${k}`);
  }
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(a.base)) throw new Error("--base must be a local astro dev server (http://localhost:<port>); this tool publishes every page it opens");
  if (!a.all && !a.slugs) throw new Error("pass --slugs a,b or --all");
  return a;
}

const H = { "content-type": "application/json", "x-emdash-request": "1" };

async function listDocs(req, base) {
  const out = [];
  for (const status of [undefined, "draft"]) {
    let cursor;
    do {
      const q = new URLSearchParams({ limit: "100" });
      if (cursor) q.set("cursor", cursor);
      if (status) q.set("status", status);
      const j = await (await req.get(`${base}/_emdash/api/content/docs?${q}`, { headers: H })).json();
      for (const it of j.data.items || []) if (!out.some((o) => o.id === it.id)) out.push({ id: it.id, slug: it.slug });
      cursor = j.data.nextCursor;
    } while (cursor);
  }
  return out;
}

async function getBody(req, base, id) {
  const j = await (await req.get(`${base}/_emdash/api/content/docs/${id}`, { headers: H })).json();
  const item = j.data?.item || j.data;
  return (item.liveData || item.data || {}).body;
}

// What the save changed, block by block (by _key): the fields the editor dropped or added.
export function diffBodies(before, after) {
  const byKey = new Map((after || []).map((b) => [b._key, b]));
  const changes = { dropped: {}, added: {}, missingBlocks: [], newBlocks: [] };
  for (const b of before || []) {
    const a = byKey.get(b._key);
    if (!a) { changes.missingBlocks.push(`${b._key}:${b._type}`); continue; }
    for (const k of Object.keys(b)) if (!(k in a) && b[k] !== undefined) changes.dropped[k] = (changes.dropped[k] || 0) + 1;
    for (const k of Object.keys(a)) if (!(k in b) && a[k] !== undefined) changes.added[k] = (changes.added[k] || 0) + 1;
  }
  const beforeKeys = new Set((before || []).map((b) => b._key));
  for (const a of after || []) if (!beforeKeys.has(a._key)) changes.newBlocks.push(`${a._key}:${a._type}`);
  return changes;
}

async function roundtrip(page, base, doc) {
  await page.goto(`${base}/_emdash/admin/content/docs/${doc.id}`);
  await page.waitForSelector(".ProseMirror", { timeout: 60_000 });
  await page.waitForTimeout(1500);
  const getStarted = page.getByRole("button", { name: "Get Started" });
  if (await getStarted.isVisible({ timeout: 500 }).catch(() => false)) await getStarted.click();
  const imagesBefore = await page.evaluate(() => document.querySelector(".ProseMirror").querySelectorAll("img").length);
  // Caret at the end of the first non-empty paragraph or heading (any depth).
  const target = await page.evaluate(() => {
    const pm = document.querySelector(".ProseMirror");
    const el = [...pm.querySelectorAll("p, h1, h2, h3, h4, h5, h6")].find((e) => e.textContent.trim() && !e.closest("[contenteditable=false]"));
    if (!el) return null;
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let last = null;
    while (w.nextNode()) last = w.currentNode;
    const r = document.createRange();
    if (last) r.setStart(last, last.length); else { r.selectNodeContents(el); r.collapse(false); }
    el.scrollIntoView({ block: "center" });
    pm.focus();
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
    return `${el.tagName}:${el.textContent.slice(-30)}`;
  });
  if (!target) {
    // A page with no editable text (only boxes or tables): type at the very end.
    await page.locator(".ProseMirror").click({ position: { x: 5, y: 5 } }).catch(() => {});
    await page.keyboard.press("Control+End");
  }
  // Let ProseMirror pick up the DOM selection before typing: if it still holds a
  // node selection (e.g. an image at the top of the page), typing would REPLACE
  // that node. Checked below: the typed text must land in the target element.
  await page.waitForTimeout(400);
  await page.keyboard.type("zq");
  await page.waitForTimeout(300);
  const landed = await page.evaluate((hasTarget) => {
    const pm = document.querySelector(".ProseMirror");
    if (!hasTarget) return pm.textContent.includes("zq");
    const el = [...pm.querySelectorAll("p, h1, h2, h3, h4, h5, h6")].find((e) => e.textContent.endsWith("zq"));
    return !!el;
  }, !!target);
  if (!landed) return { target, error: "typed text did not land at the caret; nothing saved (reload discards it)" };
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(500);
  const nodes = await page.evaluate(() => document.querySelector(".ProseMirror").querySelectorAll("img").length);
  if (nodes !== imagesBefore) return { target, error: `image count changed in the editor (${imagesBefore} -> ${nodes}); nothing saved` };
  const save = page.locator('form button[type="submit"]').first();
  if (await save.isDisabled()) return { target: target || "end of document", error: "save stayed disabled after the edit (editor saw no change)" };
  await save.click();
  await page.getByRole("button", { name: "Saved" }).first().waitFor({ timeout: 30_000 });
  const published = page.waitForResponse((r) => /\/_emdash\/api\/content\/docs\/[^/]+\/publish$/.test(new URL(r.url()).pathname) && r.request().method() === "POST", { timeout: 30_000 });
  await page.getByRole("button", { name: /^Publish (now|changes)$/ }).first().click();
  const confirm = page.getByRole("dialog").getByRole("button", { name: /^Publish (now|changes)$/ });
  if (await confirm.isVisible({ timeout: 3_000 }).catch(() => false)) await confirm.click();
  const status = (await published).status();
  return { target: target || "end of document", publish: status, error: status === 200 ? undefined : `publish returned ${status}` };
}

async function main() {
  const a = args(process.argv);
  const here = dirname(fileURLToPath(import.meta.url));
  const out = a.out || join(here, "out", "roundtrip");
  mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await ctx.newPage();
  await page.goto(`${a.base}/_emdash/api/setup/dev-bypass?redirect=/_emdash/api/auth/me`);
  await page.waitForURL((u) => u.pathname === "/_emdash/api/auth/me", { timeout: 60_000 });
  await page.request.post(`${a.base}/_emdash/api/auth/me`, { headers: H, data: { action: "dismissWelcome" } });

  const docs = await listDocs(page.request, a.base);
  const todo = a.all ? docs : a.slugs.map((s) => docs.find((d) => d.slug === s) || { slug: s });
  const results = {};
  let failed = 0;
  for (const doc of todo) {
    const file = doc.slug.replace(/\//g, "__");
    if (!doc.id) { results[doc.slug] = { error: "slug not found" }; failed++; console.log(`FAIL ${doc.slug}: not found`); continue; }
    try {
      const before = await getBody(page.request, a.base, doc.id);
      const r = await roundtrip(page, a.base, doc);
      const after = await getBody(page.request, a.base, doc.id);
      writeFileSync(join(out, `${file}.before.json`), JSON.stringify(before, null, 1));
      writeFileSync(join(out, `${file}.after.json`), JSON.stringify(after, null, 1));
      results[doc.slug] = { ...r, changes: diffBodies(before, after) };
      if (r.error) failed++;
      console.log(`${r.error ? "FAIL" : "ok  "} ${doc.slug}${r.error ? `: ${r.error}` : ""}`);
    } catch (e) {
      failed++;
      results[doc.slug] = { error: String(e.message || e).slice(0, 300) };
      console.log(`FAIL ${doc.slug}: ${results[doc.slug].error}`);
    }
    writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 1));
  }
  await browser.close();
  console.log(`\n${todo.length - failed}/${todo.length} pages saved and published through the editor. Results: ${join(out, "results.json")}`);
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((e) => { console.error(e); process.exit(2); });
}
