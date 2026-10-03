#!/usr/bin/env node
// URL parity test: the gate for cutting university.etop.tech over to EmDash.
//
//   node parity.mjs --candidate https://<preview>.pages.dev [--base https://university.etop.tech]
//
// 1. Collects every URL on BASE: sitemap + a same-origin link crawl from "/" +
//    every page the migration seed knows about + every image/asset the pages reference.
// 2. Also crawls CANDIDATE, so URLs that exist only there are reported too.
// 3. For each URL fetches both sides and compares: HTTP status (redirects are not
//    followed, so a moved page shows up as 200 vs 301/404), <title>, and the
//    normalised text of the main content. Assets compare status + byte length.
// 4. Writes out/parity-report.json and out/parity-report.md, plus
//    out/redirects.suggested for any page that moved (matched by title).
//
// Exit code: 0 = parity, 1 = at least one difference (the cutover is blocked), 2 = bad usage.
//
// Options:
//   --base URL            live site (default https://university.etop.tech)
//   --candidate URL       EmDash-backed preview (required)
//   --selector CSS        main-content selector, both sides (default "main")
//   --ignore CSS          elements stripped before comparing text (default: chrome that legitimately differs)
//   --concurrency N       parallel fetches per host (default 6)
//   --limit N             only check the first N URLs (smoke runs)
//   --header "K: V"       extra request header for the candidate (repeatable; e.g. CF Access service token)
//   --no-assets           skip asset URLs

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseHtml } from "node-html-parser";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const SEED = resolve(HERE, "..", "..", ".emdash", "seed.json");

// Differences reviewed and accepted by the lead (2026-10-02). Keep this list short.
const ACCEPTED = {
  "/education/etop-process/how-to-edit-university-pages": {
    problem: "status 404 -> 200",
    why: "new page added with the migration: how eTop staff edit University pages in the CMS",
  },
  "/e2e-test-page": {
    problem: "status 404 -> 200",
    why: "unlisted, noindex page the editor E2E edits on the preview (not in the sitemap or sidebar)",
  },
  "/404": {
    problem: "status 200 -> 404",
    why: "Cloudflare Pages served its 404 page at /404 with status 200 (a soft 404); the Worker returns a real 404",
  },
};

const DEFAULT_IGNORE = [
  "script", "style", "noscript", "template", "svg",
  "footer", "nav", ".pagination-links", "starlight-toc", "mobile-starlight-toc",
  ".sl-sr-only", ".sr-only", "[data-parity-ignore]",
].join(",");

function posInt(k, v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${k} needs a positive integer, got "${v}"`);
  return n;
}

// Same-origin references compare by path, so base and preview hosts can differ.
// alsoSelf: the live origin, so an absolute link to university.etop.tech counts as
// same-site on the candidate too (it is the same page after cutover).
function normRef(href, origin, from, alsoSelf) {
  // Cloudflare email obfuscation: /cdn-cgi/l/email-protection#<hex>, re-keyed on
  // every request. Decode it (first byte XORs the rest) and compare the address.
  const cf = String(href).match(/\/cdn-cgi\/l\/email-protection#([0-9a-f]+)/i);
  if (cf) {
    const bytes = cf[1].match(/../g).map((h) => parseInt(h, 16));
    return "mailto:" + String.fromCharCode(...bytes.slice(1).map((b) => b ^ bytes[0]));
  }
  try {
    const u = new URL(href, origin + from);
    return u.origin === origin || u.origin === alsoSelf ? normPath(u.pathname) + u.search + u.hash : u.href;
  } catch {
    return href;
  }
}

export function parseArgs(argv) {
  const a = { base: "https://university.etop.tech", candidate: "", selector: "main", ignore: DEFAULT_IGNORE, concurrency: 6, limit: 0, headers: {}, assets: true, out: OUT, seedPaths: true };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => argv[++i];
    if (k === "--base") a.base = v();
    else if (k === "--candidate") a.candidate = v();
    else if (k === "--selector") a.selector = v();
    else if (k === "--ignore") a.ignore = v();
    else if (k === "--concurrency") a.concurrency = posInt(k, v());
    else if (k === "--limit") a.limit = posInt(k, v());
    else if (k === "--no-assets") a.assets = false;
    else if (k === "--out") a.out = resolve(v());
    else if (k === "--header") {
      const [hk, ...rest] = v().split(":");
      a.headers[hk.trim()] = rest.join(":").trim();
    } else throw new Error(`unknown option ${k}`);
  }
  a.base = a.base.replace(/\/$/, "");
  a.candidate = a.candidate.replace(/\/$/, "");
  return a;
}

// Path normalisation: Starlight serves /a/b/ and /a/b; compare without the trailing slash.
export function normPath(p) {
  const u = new URL(p, "http://x");
  let path = decodeURI(u.pathname);
  if (path.length > 1) path = path.replace(/\/$/, "");
  return path;
}

export function normText(s) {
  return s
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const BLOCK_BOUNDARY = /<\/?(p|div|li|ul|ol|h[1-6]|tr|td|th|table|thead|tbody|figure|figcaption|summary|details|blockquote|pre|section|article|aside|header|hr|br|img)(\s[^>]*)?\/?>/gi;

// Default node-html-parser keeps <pre> as raw text; we need its text content.
const PARSE_OPTS = { comment: false, blockTextElements: { script: true, style: true, noscript: true } };

// Cloudflare's Email Address Obfuscation rewrites addresses on proxied zones
// (university.etop.tech) but not on workers.dev. Decode it so both sides compare
// the address the reader actually sees.
export function decodeCfEmail(hex) {
  const key = parseInt(hex.slice(0, 2), 16);
  let out = "";
  for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  return out;
}
export function deobfuscateEmails(html) {
  return html
    .replace(/<(a|span)\b[^>]*class="__cf_email__"[^>]*data-cfemail="([0-9a-f]+)"[^>]*>[\s\S]*?<\/\1>/gi, (_, _t, hex) => decodeCfEmail(hex))
    .replace(/href="\/cdn-cgi\/l\/email-protection#([0-9a-f]+)"/gi, (_, hex) => `href="mailto:${decodeCfEmail(hex)}"`);
}

export function extract(html, selector, ignore) {
  const root = parseHtml(deobfuscateEmails(html), PARSE_OPTS);
  const title = normText(root.querySelector("title")?.textContent || "");
  const found = root.querySelector(selector);
  const main = found || root.querySelector("body") || root;
  if (ignore) main.querySelectorAll(ignore).forEach((e) => e.remove());
  // Block-level boundaries become spaces so "a</p><p>b" is not "ab"; inline tags
  // (strong, a, code...) must not add space, or "<b>x</b>." would read "x .".
  const spaced = main.innerHTML.replace(BLOCK_BOUNDARY, " $&");
  const text = normText(parseHtml(spaced, PARSE_OPTS).textContent);
  const links = root.querySelectorAll("a[href]").map((e) => e.getAttribute("href"));
  const assets = root.querySelectorAll("img[src], link[rel~=icon][href], source[srcset]").map((e) => e.getAttribute("src") || e.getAttribute("href") || (e.getAttribute("srcset") || "").split(/\s/)[0]);
  // What the reader can click and see inside the content: compared, not just crawled.
  const contentLinks = main.querySelectorAll("a[href]").map((e) => e.getAttribute("href"));
  const contentImages = main.querySelectorAll("img[src]").map((e) => e.getAttribute("src"));
  return { title, text, links, assets, selectorFound: !!found, contentLinks, contentImages };
}

// Word-level similarity (0..1) and the first point of divergence.
export function compareText(a, b) {
  if (a === b) return { ratio: 1, at: -1 };
  const wa = a.split(" ");
  const wb = b.split(" ");
  let i = 0;
  while (i < wa.length && i < wb.length && wa[i] === wb[i]) i++;
  const setB = new Map();
  for (const w of wb) setB.set(w, (setB.get(w) || 0) + 1);
  let common = 0;
  for (const w of wa) if (setB.get(w) > 0) (common++, setB.set(w, setB.get(w) - 1));
  return {
    ratio: (2 * common) / (wa.length + wb.length || 1),
    at: i,
    base: wa.slice(Math.max(0, i - 6), i + 12).join(" "),
    candidate: wb.slice(Math.max(0, i - 6), i + 12).join(" "),
  };
}

async function fetchOne(url, headers) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { redirect: "manual", headers: { "user-agent": "etop-university-parity/1.0", ...headers } });
      const type = r.headers.get("content-type") || "";
      const body = type.includes("text/html") ? await r.text() : Buffer.from(await r.arrayBuffer());
      return { status: r.status, location: r.headers.get("location") || "", type, body };
    } catch (e) {
      if (attempt === 2) return { status: 0, error: String(e.cause?.code || e.message), type: "", body: "" };
      await new Promise((res) => setTimeout(res, 500 * (attempt + 1)));
    }
  }
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.max(1, n) }, async () => {
    while (i < items.length) {
      const j = i++;
      out[j] = await fn(items[j], j);
    }
  }));
  return out;
}

function sameOriginPath(href, origin, from) {
  if (!href || /^(mailto|tel|javascript|data):/i.test(href) || href.startsWith("#")) return null;
  if (href.includes("/cdn-cgi/")) return null; // Cloudflare-injected (email obfuscation etc.)
  try {
    const u = new URL(href, origin + from);
    if (u.origin !== origin) return null;
    return u.pathname;
  } catch {
    return null;
  }
}

const isAsset = (p) => /\.(png|jpe?g|gif|webp|svg|ico|pdf|mp4|webm|css|js|woff2?|txt|xml)$/i.test(p);

async function sitemapPaths(origin, headers) {
  const paths = new Set();
  const queue = [`${origin}/sitemap-index.xml`, `${origin}/sitemap.xml`];
  const seen = new Set();
  while (queue.length) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);
    const r = await fetchOne(url, headers);
    if (r.status !== 200) continue;
    const xml = r.body.toString();
    for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
      const loc = m[1].trim();
      if (/sitemap.*\.xml$/.test(loc)) queue.push(loc.replace(/^https?:\/\/[^/]+/, origin));
      else paths.add(new URL(loc).pathname);
    }
  }
  return paths;
}

async function crawl(origin, seeds, headers, a) {
  const pages = new Map(); // normPath -> {path, res, ex}
  const assets = new Set();
  const referrers = new Map(); // normPath -> Set(from paths)
  const ref = (p, from) => {
    const k = normPath(p);
    if (!referrers.has(k)) referrers.set(k, new Set());
    referrers.get(k).add(normPath(from));
  };
  const queue = [...seeds];
  const queued = new Set(queue.map(normPath));
  while (queue.length) {
    const batch = queue.splice(0, a.concurrency * 4);
    await pool(batch, a.concurrency, async (path) => {
      let res = await fetchOne(origin + path, headers);
      // A pure trailing-slash redirect (/a -> /a/) is the same page: record the
      // page, so which spelling the crawl met first does not decide the result.
      if (res.status >= 300 && res.status < 400 && res.location) {
        const to = sameOriginPath(res.location, origin, path);
        if (to && to !== path && normPath(to) === normPath(path)) (path = to), (res = await fetchOne(origin + to, headers));
      }
      let ex = null;
      if (res.status === 200 && res.type.includes("text/html")) {
        ex = extract(res.body, a.selector, a.ignore);
        for (const l of ex.links) {
          const p = sameOriginPath(l, origin, path);
          if (!p) continue;
          ref(p, path);
          if (isAsset(p)) assets.add(p);
          else if (!queued.has(normPath(p))) (queued.add(normPath(p)), queue.push(p));
        }
        for (const s of ex.assets) {
          const p = sameOriginPath(s, origin, path);
          if (p) (assets.add(p), ref(p, path));
        }
      } else if (res.status >= 300 && res.status < 400 && res.location) {
        const p = sameOriginPath(res.location, origin, path);
        if (p && !isAsset(p) && !queued.has(normPath(p))) (queued.add(normPath(p)), queue.push(p));
      }
      pages.set(normPath(path), { path, res, ex });
    });
  }
  return { pages, assets, referrers };
}

function seedPaths() {
  if (!existsSync(SEED)) return [];
  const seed = JSON.parse(readFileSync(SEED, "utf8"));
  return (seed.content?.docs || []).map((e) => (e.slug === "index" ? "/" : `/${e.slug}/`));
}

export async function run(a) {
  const t0 = Date.now();
  const known = a.seedPaths === false ? [] : seedPaths();
  if (a.minPages == null) a.minPages = Math.max(1, known.length);
  const seeds = new Set(["/", "/404", ...known]);
  for (const p of await sitemapPaths(a.base, {})) seeds.add(p);
  console.log(`crawling base ${a.base} from ${seeds.size} seed paths...`);
  const base = await crawl(a.base, [...seeds], {}, a);
  console.log(`  ${base.pages.size} pages, ${base.assets.size} assets`);
  console.log(`crawling candidate ${a.candidate}...`);
  const candSeeds = new Set(["/", ...(await sitemapPaths(a.candidate, a.headers))]);
  const cand = await crawl(a.candidate, [...candSeeds], a.headers, a);
  console.log(`  ${cand.pages.size} pages, ${cand.assets.size} assets`);

  let keys = [...new Set([...base.pages.keys(), ...cand.pages.keys()])].sort();
  if (a.limit) keys = keys.slice(0, a.limit);
  const results = [];
  await pool(keys, a.concurrency, async (k) => {
    const b = base.pages.get(k) || { path: k, res: await fetchOne(a.base + k, {}) };
    const c = cand.pages.get(k) || { path: k, res: await fetchOne(a.candidate + k, a.headers) };
    for (const side of [b, c]) if (!side.ex && side.res.status === 200 && side.res.type.includes("text/html")) side.ex = extract(side.res.body, a.selector, a.ignore);
    const r = { url: k, kind: "page", base: { status: b.res.status, location: b.res.location || undefined }, candidate: { status: c.res.status, location: c.res.location || undefined }, problems: [] };
    const bs = b.res.status;
    const cs = c.res.status;
    if (bs !== cs) r.problems.push(`status ${bs} -> ${cs}`);
    // Equal-but-broken is not parity: fetch errors and server errors always fail.
    if (bs === 0 || cs === 0) r.problems.push(`fetch failed (${b.res.error || c.res.error || "no response"})`);
    else if (bs >= 500 || cs >= 500) r.problems.push(`server error ${bs}/${cs}`);
    if (bs === cs && bs >= 300 && bs < 400) {
      const bl = normRef(b.res.location, a.base, b.path);
      const cl = normRef(c.res.location, a.candidate, c.path);
      if (bl !== cl) r.problems.push(`redirect target ${bl} -> ${cl}`);
    }
    if (bs === 200 && cs === 200) {
      if (!b.ex || !c.ex) r.problems.push(`not HTML on ${!b.ex ? "base" : "candidate"} (${(!b.ex ? b : c).res.type || "no content-type"})`);
    }
    if (b.ex && c.ex) {
      r.base.title = b.ex.title;
      r.candidate.title = c.ex.title;
      if (!b.ex.selectorFound || !c.ex.selectorFound) r.problems.push(`selector "${a.selector}" missing on ${!b.ex.selectorFound ? "base" : "candidate"}`);
      if (b.ex.title !== c.ex.title) r.problems.push("title differs");
      const cmp = compareText(b.ex.text, c.ex.text);
      r.textSimilarity = Number(cmp.ratio.toFixed(4));
      // Exact match required: the ratio is a word-bag diagnostic and is 1 for reordered text.
      if (b.ex.text !== c.ex.text) {
        r.problems.push(`body text differs (similarity ${cmp.ratio.toFixed(3)})`);
        r.firstDiff = { base: cmp.base, candidate: cmp.candidate };
      }
      const bLinks = b.ex.contentLinks.map((h) => normRef(h, a.base, b.path)).join("\n");
      const cLinks = c.ex.contentLinks.map((h) => normRef(h, a.candidate, c.path, new URL(a.base).origin)).join("\n");
      if (bLinks !== cLinks) r.problems.push("content link targets differ");
      const bImgs = b.ex.contentImages.map((h) => normRef(h, a.base, b.path)).join("\n");
      const cImgs = c.ex.contentImages.map((h) => normRef(h, a.candidate, c.path, new URL(a.base).origin)).join("\n");
      if (bImgs !== cImgs) r.problems.push("content images differ");
    } else if (b.ex) r.base.title = b.ex.title;
    results.push(r);
  });

  if (a.assets) {
    let assetKeys = [...new Set([...base.assets, ...cand.assets])].sort();
    if (a.limit) assetKeys = assetKeys.slice(0, a.limit);
    await pool(assetKeys, a.concurrency, async (p) => {
      const [b, c] = await Promise.all([fetchOne(a.base + p, {}), fetchOne(a.candidate + p, a.headers)]);
      const r = { url: p, kind: "asset", base: { status: b.status, bytes: b.body?.length }, candidate: { status: c.status, bytes: c.body?.length }, problems: [] };
      const mime = (t) => (t || "").split(";")[0].trim();
      if (b.status !== c.status) r.problems.push(`status ${b.status} -> ${c.status}`);
      else if (b.status === 0) r.problems.push(`fetch failed (${b.error || c.error})`);
      else if (b.status === 200 && mime(b.type) !== mime(c.type)) r.problems.push(`content-type ${mime(b.type)} -> ${mime(c.type)}`);
      else if (b.status === 200 && b.body.length !== c.body.length && !/\.(css|js)$/.test(p)) r.problems.push(`size ${b.body.length} -> ${c.body.length}`);
      results.push(r);
    });
  }
  results.sort((x, y) => x.kind.localeCompare(y.kind) || x.url.localeCompare(y.url));

  // Moved pages: base 200 but candidate not 200 -> find a candidate page with the same title.
  const candByTitle = new Map();
  for (const [k, v] of cand.pages) if (v.ex && v.res.status === 200) candByTitle.set(v.ex.title, k);
  const redirects = [];
  for (const r of results) {
    if (r.kind === "page" && r.base.status === 200 && r.candidate.status !== 200 && r.base.title && candByTitle.has(r.base.title)) {
      r.suggestedRedirect = candByTitle.get(r.base.title);
      redirects.push(`${r.url} ${r.suggestedRedirect} 301`);
    }
  }

  // Reviewed, intentional differences. Each must match exactly one problem string.
  for (const r of results) {
    const ok = ACCEPTED[r.url];
    if (!ok) continue;
    r.accepted = r.problems.filter((p) => p === ok.problem).map((p) => `${p} (accepted: ${ok.why})`);
    r.problems = r.problems.filter((p) => p !== ok.problem);
  }
  const failed = results.filter((r) => r.problems.length);
  // Links that are already broken on the live site: not a parity failure (both
  // sides agree), but worth fixing before or after cutover.
  const brokenOnBase = results
    .filter((r) => r.base.status === 404 && base.referrers.has(r.url))
    .map((r) => ({ url: r.url, kind: r.kind, linkedFrom: [...base.referrers.get(r.url)].sort() }));
  const summary = {
    base: a.base,
    candidate: a.candidate,
    ranAt: new Date().toISOString(),
    seconds: Math.round((Date.now() - t0) / 1000),
    pages: results.filter((r) => r.kind === "page").length,
    assets: results.filter((r) => r.kind === "asset").length,
    failed: failed.length,
    accepted: results.filter((r) => r.accepted?.length).map((r) => `${r.url}: ${r.accepted.join("; ")}`),
    movedUrls: redirects.length,
    brokenOnBase: brokenOnBase.length,
    // A gate that checked nothing must not pass: --limit runs are partial, and
    // the live crawl must have reached at least every page the seed knows about.
    partial: !!a.limit,
    livePages: results.filter((r) => r.kind === "page" && r.base.status === 200).length,
    minLivePages: a.minPages ?? 1,
  };
  summary.pass = failed.length === 0 && !summary.partial && summary.livePages >= summary.minLivePages;
  const out = a.out || OUT;
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "parity-report.json"), JSON.stringify({ summary, brokenOnBase, results }, null, 2) + "\n");
  writeFileSync(join(out, "redirects.suggested"), redirects.join("\n") + (redirects.length ? "\n" : ""));
  writeFileSync(join(out, "parity-report.md"), markdownReport(summary, failed, brokenOnBase));
  return { summary, failed };
}

function verdict(s) {
  if (s.pass) return "PASS";
  const why = [];
  if (s.failed) why.push(`${s.failed} differences`);
  if (s.partial) why.push("partial run (--limit), not a gate result");
  if (s.livePages < s.minLivePages) why.push(`only ${s.livePages} live pages reached, expected >= ${s.minLivePages}`);
  return `FAIL (${why.join("; ")})`;
}

function markdownReport(s, failed, broken) {
  const lines = [
    `# URL parity: ${verdict(s)}`,
    "",
    `- Base: ${s.base}`,
    `- Candidate: ${s.candidate}`,
    `- Ran: ${s.ranAt} (${s.seconds}s)`,
    `- Checked: ${s.pages} pages, ${s.assets} assets`,
    `- Differences: ${s.failed} · moved URLs (redirect suggested): ${s.movedUrls}`,
    ...s.accepted.map((x) => `- Accepted difference: ${x}`),
    "",
  ];
  if (failed.length) {
    lines.push("| URL | Problem | Base | Candidate |", "|---|---|---|---|");
    for (const r of failed) {
      const esc = (x) => String(x ?? "").replace(/\|/g, "\\|").slice(0, 140);
      lines.push(`| ${esc(r.url)} | ${esc(r.problems.join("; "))} | ${esc(r.firstDiff?.base ?? r.base.title ?? r.base.status)} | ${esc(r.firstDiff?.candidate ?? r.candidate.title ?? r.candidate.status)} |`);
    }
  }
  return lines.join("\n") + "\n";
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let a;
  try {
    a = parseArgs(process.argv.slice(2));
    if (!a.candidate) throw new Error("--candidate is required");
  } catch (e) {
    console.error(String(e.message), "\nusage: node parity.mjs --candidate https://preview.example [--base https://university.etop.tech]");
    process.exit(2);
  }
  const { summary, failed } = await run(a);
  console.log(`\n${verdict(summary)}: ${summary.pages} pages, ${summary.assets} assets, ${summary.failed} differences, ${summary.movedUrls} moved`);
  for (const r of failed.slice(0, 25)) console.log(`  ${r.url}: ${r.problems.join("; ")}`);
  if (failed.length > 25) console.log(`  ... ${failed.length - 25} more in out/parity-report.md`);
  process.exit(summary.pass ? 0 : 1);
}
