#!/usr/bin/env node
// Visual diff: screenshot key pages on two sites (default: live vs a candidate)
// in light and dark mode, and pixel-compare them.
//
//   node visual-diff.mjs --candidate https://<preview> [--base https://university.etop.tech]
//                        [--threshold 0.5] [--pages /,/about-us/values]
//
// Writes out/visual/<page>-<theme>-{base,candidate,diff}.png and out/visual/report.md.
// Exit 1 if any page differs by more than --threshold percent of pixels, or fails to load.
// Sends CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET to the candidate if set.

import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { accessHeaders } from "./lib/env.mjs";

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
  const a = { base: "https://university.etop.tech", candidate: "", threshold: 0.5, pages: null, out: "" };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--base") a.base = argv[++i];
    else if (k === "--candidate") a.candidate = argv[++i];
    else if (k === "--threshold") a.threshold = Number(argv[++i]);
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
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: theme, extraHTTPHeaders: headers, reducedMotion: "reduce" });
  // Starlight reads its theme from localStorage before first paint.
  await ctx.addInitScript((t) => { try { localStorage.setItem("starlight-theme", t); } catch {} }, theme);
  const page = await ctx.newPage();
  const res = await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
  const status = res?.status() ?? 0;
  // Settle lazy images and fonts, hide things that legitimately differ between builds.
  await page.evaluate(async () => {
    for (const img of document.images) img.loading = "eager";
    await Promise.all([...document.images].map((i) => (i.complete ? null : new Promise((r) => { i.onload = i.onerror = r; }))));
    await document.fonts?.ready;
  });
  await page.addStyleTag({ content: "*{animation:none!important;transition:none!important;caret-color:transparent!important} .sl-last-updated, footer .meta time{visibility:hidden!important}" });
  const png = await page.screenshot({ fullPage: true });
  await ctx.close();
  return { status, png: PNG.sync.read(png) };
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
        writeFileSync(join(outDir, `${name}-base.png`), PNG.sync.write(b));
        writeFileSync(join(outDir, `${name}-candidate.png`), PNG.sync.write(c));
        writeFileSync(join(outDir, `${name}-diff.png`), PNG.sync.write(diff));
        const statusOk = base.status === cand.status && cand.status === 200;
        const ok = statusOk && pct <= a.threshold;
        if (!ok) failed++;
        rows.push({ page: p.path, why: p.why, theme, status: `${base.status}/${cand.status}`, size: `${base.png.width}x${base.png.height} / ${cand.png.width}x${cand.png.height}`, pct, ok, name });
      } catch (err) {
        failed++;
        rows.push({ page: p.path, why: p.why, theme, status: "error", size: "", pct: NaN, ok: false, name, err: String(err.message || err).slice(0, 160) });
      }
      const r = rows.at(-1);
      console.log(`${r.ok ? "PASS" : "FAIL"} ${r.page} [${theme}] ${Number.isNaN(r.pct) ? r.err : r.pct.toFixed(2) + "%"}`);
    }
  }
  await browser.close();

  const md = [
    `# Visual diff: ${a.base} vs ${a.candidate}`,
    "",
    `Run ${new Date().toISOString()}. Threshold ${a.threshold}% of pixels. Viewport 1280 wide, full page. "Last updated" stamps hidden.`,
    "",
    "| Result | Page | Why it is in the set | Theme | HTTP base/candidate | Size base / candidate | Pixels different | Diff image |",
    "|---|---|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.ok ? "PASS" : "**FAIL**"} | \`${r.page}\` | ${r.why} | ${r.theme} | ${r.status} | ${r.size} | ${Number.isNaN(r.pct) ? r.err : r.pct.toFixed(2) + "%"} | ${r.err ? "" : `${r.name}-diff.png`} |`),
    "",
    `**${failed === 0 ? "PASS" : `FAIL: ${failed} of ${rows.length}`}**`,
    "",
  ].join("\n");
  writeFileSync(join(outDir, "report.md"), md);
  console.log(`\nreport: ${join(outDir, "report.md")}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
