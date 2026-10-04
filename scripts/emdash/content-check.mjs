#!/usr/bin/env node
// Conversion fidelity check, no EmDash theme needed: for every page in the seed,
// compare the plain text of its Portable Text body with the text of the live
// page's rendered markdown. Catches anything the markdown -> PT conversion lost.
//
//   node content-check.mjs [--base https://university.etop.tech] [--min 1]
//
// Exit 1 if any page falls below --min similarity (default 1 = exact after
// whitespace/quote normalisation). Writes out/content-check.json.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { portableTextToPlain } from "./lib/md-to-pt.mjs";
import { extract, normText, compareText } from "./parity.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const seed = JSON.parse(readFileSync(resolve(HERE, "..", "..", ".emdash", "seed.json"), "utf8"));

const argv = process.argv.slice(2);
const opt = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const base = opt("--base", "https://university.etop.tech").replace(/\/$/, "");
const min = Number(opt("--min", "1"));

// Starlight renders the markdown into .sl-markdown-content; asides add a visible
// default title ("Note", "Tip", ...) that is not part of the source text.
const ASIDE_TITLES = { note: "Note", tip: "Tip", caution: "Caution", danger: "Danger" };
function expectedText(body) {
  const withTitles = body.map((b) => ((b._type === "aside" || b._type === "asideStart") && !b.title ? { ...b, title: ASIDE_TITLES[b.variant] } : b));
  // parity.extract() decodes Cloudflare's email obfuscation on the live page,
  // so addresses compare as written.
  return normText(portableTextToPlain(withTitles));
}

const results = [];
const entries = seed.content.docs;
let i = 0;
await Promise.all(Array.from({ length: 6 }, async () => {
  while (i < entries.length) {
    const e = entries[i++];
    const url = e.slug === "index" ? "/" : `/${e.slug}/`;
    const r = await fetch(base + url);
    const html = await r.text();
    const live = extract(html, ".sl-markdown-content", "script,style,svg,.sl-anchor-link,.sr-only,.sl-sr-only");
    const want = expectedText(e.data.body);
    const cmp = compareText(live.text, want);
    // Exact text required; the ratio is diagnostic only (it is 1 for reordered words).
    const same = live.text === want && live.selectorFound;
    const similarity = same ? 1 : Math.min(Number(cmp.ratio.toFixed(4)), 0.9999);
    results.push({ slug: e.slug, status: r.status, similarity, ...(same ? {} : { live: cmp.base, seed: cmp.candidate }) });
  }
}));
results.sort((a, b) => a.similarity - b.similarity || a.slug.localeCompare(b.slug));
const bad = results.filter((r) => r.status !== 200 || r.similarity < min);
mkdirSync(join(HERE, "out"), { recursive: true });
writeFileSync(join(HERE, "out", "content-check.json"), JSON.stringify({ base, min, pages: results.length, belowMin: bad.length, results }, null, 2) + "\n");
const exact = results.filter((r) => r.similarity === 1).length;
console.log(`${results.length} pages: ${exact} exact, ${bad.length} below ${min}`);
for (const r of bad.slice(0, 30)) console.log(`  ${r.similarity} ${r.slug}\n     live: ${r.live}\n     seed: ${r.seed}`);
process.exit(bad.length ? 1 : 0);
