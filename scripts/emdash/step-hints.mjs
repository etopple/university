#!/usr/bin/env node
// Step hints: where each migrated screenshot, code block or extra paragraph sat
// inside a numbered step, keyed by the block's _key.
//
//   node step-hints.mjs            write src/_generated/step-hints.json from .emdash/seed.json
//   node step-hints.mjs --check    exit 1 if the committed file is stale
//
// Why: the seed marks content inside a step with listContinuation + level
// (editorSafeLists in lib/md-to-pt.mjs). The EmDash editor drops both on save,
// but it keeps every block's _key. With this map the theme (src/lib/pt.ts)
// puts a saved page's screenshots back exactly where they were, including the
// last step's (issue #14), with no change to stored content. Blocks an editor
// adds later have new keys and fall back to the theme's own rules.

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const SEED = join(ROOT, ".emdash", "seed.json");
const OUT = join(ROOT, "src", "_generated", "step-hints.json");

// { "<legacy_source>": { "<_key>": ["<_type>", level] } } for top-level body blocks
// that sit inside a list item (listContinuation without listItem), and
// { "<_key>": ["li", level] } for nested list items the editor would flatten.
export function stepHints(seed) {
  const out = {};
  for (const entry of seed.content?.docs ?? []) {
    const src = entry.data?.legacy_source;
    if (!src) continue;
    const page = {};
    const body = entry.data.body ?? [];
    for (let i = 0; i < body.length; i++) {
      const b = body[i];
      if (!b.listItem && b.listContinuation === true) page[b._key] = [b._type, Math.max(1, Number(b.level ?? 1))];
      // A sub-list that resumes after a step's code block or screenshot: the editor
      // starts a new list there and saves its items at level 1. ["li", level] restores them.
      if (b.listItem && Number(b.level ?? 1) > 1 && i > 0 && !body[i - 1].listItem) {
        for (let j = i; j < body.length && body[j].listItem && Number(body[j].level ?? 1) > 1; j++) page[body[j]._key] = ["li", Number(body[j].level)];
      }
    }
    if (Object.keys(page).length) out[src] = page;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  // One line per page: small diffs, still readable.
  const hints = stepHints(JSON.parse(readFileSync(SEED, "utf8")));
  const json = "{\n" + Object.entries(hints).map(([k, v]) => ` ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(",\n") + "\n}\n";
  if (process.argv.includes("--check")) {
    const cur = readFileSync(OUT, "utf8").replace(/\r\n/g, "\n");
    if (cur !== json) {
      console.error("src/_generated/step-hints.json is stale: run node scripts/emdash/step-hints.mjs");
      process.exit(1);
    }
    console.log("step-hints.json is current");
  } else {
    writeFileSync(OUT, json);
    const pages = Object.keys(JSON.parse(json)).length;
    console.log(`wrote ${OUT}: ${pages} pages`);
  }
}
