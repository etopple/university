#!/usr/bin/env node
// Visual diff: screenshot key pages on two sites (default: live vs a candidate)
// in light and dark mode, and pixel-compare them.
//
//   node visual-diff.mjs --candidate https://<preview> [--base https://university.etop.tech]
//                        [--threshold 0.5] [--band 2] [--pages /,/about-us/values]
//
// Writes out/visual/<page>-<theme>-{base,candidate,diff}.png and out/visual/report.md.
// Exit 1 if a page fails to load, differs by more than --threshold % of all pixels or
// --band % within any 200px strip, or changes height by more than 8px.
// Sends E2E_CF_ACCESS_CLIENT_ID / E2E_CF_ACCESS_CLIENT_SECRET to the candidate if set.

import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { accessHeaders, newContextWithHeaders } from "./lib/env.mjs";

// Home + 5 docs that between them use every block the theme must render.
export const KEY_PAGES = [
  { path: "/", why: "home (splash)" },
  { path: "/about-us/values", why: "longest page; collapsible details" },
  { path: "/education/self-help-guides/new-employee-it-setup-what-to-expect", why: "tables" },
  { path: "/education/self-help-guides/office-365-guides/mobile-phone-setup/android-phone-setup", why: "23 images" },
  { path: "/team/meet-the-team", why: "asides" },
  { path: "/education/self-help-guides/office-365-guides/microsoft-authenticator", why: "section index page" },
];

function args(argv) {
  const a = { base: "https://university.etop.tech", candidate: "", threshold: 0.5, band: 2, pages: null, out: "" };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--base") a.base = argv[++i];
    else if (k === "--candidate") a.candidate = argv[++i];
    else if (k === "--threshold") a.threshold = Number(argv[++i]);
    else if (k === "--band") a.band = Number(argv[++i]);
    else if (k === "--pages") a.pages = argv[++i].split(",").map((p) => ({ path: p.trim(), why: "" }));
    else if (k === "--out") a.out = argv[++i];
    else throw new Error(`unknown arg ${k}`);
  }
  if (!a.candidate) throw new Error("--candidate <url> is required");
  a.base = a.base.replace(/\/$/, "");
  a.candidate = a.candidate.replace(/\/$/, "");
  return a;
}

async function shoot(browser, url, theme, headers) {
  const ctx = await newContextWithHeaders(browser, url, headers, { viewport: { width: 1280, height: 900 }, colorScheme: theme, reducedMotion: "reduce" });
  try {
  const page = await ctx.newPage();
  const res = await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
  const status = res?.status() ?? 0;
  // Settle lazy images and fonts, hide things that legitimately differ between builds.
  // Bounded: a stalled image must fail the row, not hang the whole gate.
  const settled = await page.evaluate(async (ms) => {
    for (const img of document.images) img.loading = "eager";
    const all = Promise.all([...document.images].map((i) => (i.complete ? null : new Promise((r) => { i.onload = i.onerror = r; }))))
      .then(() => document.fonts?.ready).then(() => true);
    return Promise.race([all, new Promise((r) => setTimeout(() => r(false), ms))]);
  }, 30_000);
  if (!settled) throw new Error("images or fonts did not finish loading within 30s");
  await page.addStyleTag({ content: "*{animation:none!important;transition:none!important;caret-color:transparent!important} .sl-last-updated, footer .meta time{visibility:hidden!important}" });
  // Capture in tiles and stitch: one full-page shot of a very tall page can hit
  // Chromium's texture limit (~16k px) and come back clipped or blank below it.
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  const width = 1280;
  const out = new PNG({ width, height });
  for (let y = 0; y < height; y += TILE) {
    const h = Math.min(TILE, height - y);
    const tile = PNG.sync.read(await page.screenshot({ fullPage: true, clip: { x: 0, y, width, height: h } }));
    PNG.bitblt(tile, out, 0, 0, Math.min(tile.width, width), Math.min(tile.height, h), 0, y);
  }
  return { status, png: out };
  } finally {
    await ctx.close();
  }
}

const TILE = 8000;
const BAND = 200; // px: a regression is judged per horizontal band, so a tall page cannot dilute it
const MAX_HEIGHT_DELTA = 8; // px

// Worst band: the highest share of differing pixels in any BAND-tall strip.
function worstBand(diffPng) {
  const { width, height, data } = diffPng;
  let worst = { pct: 0, y: 0 };
  for (let y0 = 0; y0 < height; y0 += BAND) {
    const y1 = Math.min(height, y0 + BAND);
    let n = 0;
    for (let y = y0; y < y1; y++) for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      // pixelmatch paints differing pixels red (255,0,0) by default
      if (data[i] === 255 && data[i + 1] === 0 && data[i + 2] === 0) n++;
    }
    const pct = (n / ((y1 - y0) * width)) * 100;
    if (pct > worst.pct) worst = { pct, y: y0 };
  }
  return worst;
}

// Pad two images to the same size (white) so pages of different heights still compare.
function pad(img, w, h) {
  if (img.width === w && img.height === h) return img;
  const out = new PNG({ width: w, height: h });
  out.data.fill(255);
  PNG.bitblt(img, out, 0, 0, img.width, img.height, 0, 0);
  return out;
}

async function main() {
  const a = args(process.argv);
  const here = dirname(fileURLToPath(import.meta.url));
  const outDir = a.out || join(here, "out", "visual");
  mkdirSync(outDir, { recursive: true });
  const pages = a.pages || KEY_PAGES;
  const browser = await chromium.launch();
  const rows = [];
  let failed = 0;

  for (const p of pages) {
    for (const theme of ["light", "dark"]) {
      const name = `${p.path === "/" ? "home" : p.path.replace(/^\/|\/$/g, "").replace(/\//g, "__")}-${theme}`;
      try {
        const base = await shoot(browser, a.base + p.path, theme, {});
        const cand = await shoot(browser, a.candidate + p.path, theme, accessHeaders());
        const w = Math.max(base.png.width, cand.png.width);
        const h = Math.max(base.png.height, cand.png.height);
        const b = pad(base.png, w, h);
        const c = pad(cand.png, w, h);
        const diff = new PNG({ width: w, height: h });
        const px = pixelmatch(b.data, c.data, diff.data, w, h, { threshold: 0.1 });
        const pct = (px / (w * h)) * 100;
        const band = worstBand(diff);
        const heightDelta = Math.abs(base.png.height - cand.png.height);
        writeFileSync(join(outDir, `${name}-base.png`), PNG.sync.write(b));
        writeFileSync(join(outDir, `${name}-candidate.png`), PNG.sync.write(c));
        writeFileSync(join(outDir, `${name}-diff.png`), PNG.sync.write(diff));
        const statusOk = base.status === cand.status && cand.status === 200;
        const ok = statusOk && pct <= a.threshold && band.pct <= a.band && heightDelta <= MAX_HEIGHT_DELTA;
        if (!ok) failed++;
        rows.push({ page: p.path, why: p.why, theme, status: `${base.status}/${cand.status}`, size: `${base.png.width}x${base.png.height} / ${cand.png.width}x${cand.png.height}`, pct, band, ok, name });
      } catch (err) {
        failed++;
        rows.push({ page: p.path, why: p.why, theme, status: "error", size: "", pct: NaN, ok: false, name, err: String(err.message || err).slice(0, 160) });
      }
      const r = rows.at(-1);
      console.log(`${r.ok ? "PASS" : "FAIL"} ${r.page} [${theme}] ${Number.isNaN(r.pct) ? r.err : `${r.pct.toFixed(2)}% overall, worst band ${r.band.pct.toFixed(1)}% at y=${r.band.y}, ${r.size}`}`);
    }
  }
  await browser.close();

  const md = [
    `# Visual diff: ${a.base} vs ${a.candidate}`,
    "",
    `Run ${new Date().toISOString()}. FAIL if: HTTP not 200 on both; over ${a.threshold}% of all pixels differ; over ${a.band}% differ in any ${BAND}px band; or heights differ by more than ${MAX_HEIGHT_DELTA}px. Viewport 1280 wide, full page captured in ${TILE}px tiles. "Last updated" stamps hidden.`,
    "",
    "| Result | Page | Why it is in the set | Theme | HTTP base/candidate | Size base / candidate | Pixels different | Worst band | Diff image |",
    "|---|---|---|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.ok ? "PASS" : "**FAIL**"} | \`${r.page}\` | ${r.why} | ${r.theme} | ${r.status} | ${r.size} | ${Number.isNaN(r.pct) ? r.err : r.pct.toFixed(2) + "%"} | ${r.band ? `${r.band.pct.toFixed(1)}% at y=${r.band.y}` : ""} | ${r.err ? "" : `${r.name}-diff.png`} |`),
    "",
    `**${failed === 0 ? "PASS" : `FAIL: ${failed} of ${rows.length}`}**`,
    "",
  ].join("\n");
  writeFileSync(join(outDir, "report.md"), md);
  console.log(`\nreport: ${join(outDir, "report.md")}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
