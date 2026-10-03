#!/usr/bin/env node
// Build the EmDash seed for eTop University from the Starlight sources.
//
//   node build-seed.mjs            write .emdash/seed.json + scripts/emdash/out/migration-report.json
//   node build-seed.mjs --check    exit 1 if the committed seed is stale (CI drift gate)
//
// Idempotent: output is a pure function of src/content/docs/** and
// src/_generated/sidebar.json. Keys are deterministic, entries and menu items are
// in a stable order, so a re-run with unchanged content is a zero-byte diff.
// Applying the seed is idempotent too: EmDash matches entries by
// (collection, slug, locale) and `--on-conflict update` rewrites them in place.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import YAML from "yaml";
import { markdownToPortableText } from "./lib/md-to-pt.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const DOCS = join(ROOT, "src", "content", "docs");
const SIDEBAR = join(ROOT, "src", "_generated", "sidebar.json");
const SEED_OUT = join(ROOT, ".emdash", "seed.json");
const REPORT_OUT = join(HERE, "out", "migration-report.json");

export const COLLECTION = "docs";
export const MENU = "docs-sidebar";
const KNOWN_FM = new Set(["title", "description", "template", "sidebar"]);

// Fingerprint over the migration-managed fields in a fixed order, skipping
// empty ones. apply.mjs recomputes it from the live entry: if the result no
// longer matches the stored migration_hash, someone edited the page in the CMS.
export const MANAGED_FIELDS = ["title", "description", "body", "sidebar_label", "template", "frontmatter_extra", "legacy_source"];
export function fingerprint(data) {
  const canon = {};
  for (const k of MANAGED_FIELDS) if (data[k] != null && data[k] !== "") canon[k] = data[k];
  return "sha256:" + createHash("sha256").update(JSON.stringify(canon)).digest("hex").slice(0, 32);
}

function walk(dir) {
  return readdirSync(dir)
    .sort()
    .flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? walk(p) : /\.mdx?$/.test(f) ? [p] : [];
    });
}

// Starlight/Astro id for a docs file: path without extension, "/index" dropped,
// each segment slugified the way Astro's glob loader does (github-slugger style).
export function slugForFile(rel) {
  let id = rel.split(sep).join("/").replace(/\.mdx?$/, "");
  id = id.replace(/(^|\/)index$/, "");
  const segs = id.split("/").filter(Boolean).map(slugSegment);
  return segs.length ? segs.join("/") : "index";
}

function slugSegment(s) {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

export function urlForSlug(slug) {
  return slug === "index" ? "/" : `/${slug}/`;
}

function splitFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { fm: {}, body: raw };
  return { fm: YAML.parse(m[1]) || {}, body: raw.slice(m[0].length) };
}

export function buildSeed() {
  const files = walk(DOCS);
  const entries = [];
  const report = { generatedFrom: "src/content/docs", pages: [], totals: {}, warnings: [], htmlPassthrough: [], frontmatterKeys: {} };
  const bySlug = new Map();

  for (const file of files) {
    const rel = relative(DOCS, file);
    const raw = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    const { fm, body } = splitFrontmatter(raw);
    const slug = typeof fm.slug === "string" ? fm.slug.replace(/^\/|\/$/g, "") || "index" : slugForFile(rel);
    if (bySlug.has(slug)) throw new Error(`duplicate slug ${slug}: ${bySlug.get(slug)} and ${rel}`);
    bySlug.set(slug, rel);

    const { blocks, warnings, stats } = markdownToPortableText(body);
    const extra = {};
    for (const [k, v] of Object.entries(fm)) {
      report.frontmatterKeys[k] = (report.frontmatterKeys[k] || 0) + 1;
      if (!KNOWN_FM.has(k)) extra[k] = v;
    }
    const data = {
      title: String(fm.title ?? ""),
      ...(fm.description ? { description: String(fm.description) } : {}),
      body: blocks,
      ...(fm.sidebar?.label ? { sidebar_label: String(fm.sidebar.label) } : {}),
      template: fm.template === "splash" ? "splash" : "doc",
      ...(fm.sidebar && Object.keys(fm.sidebar).some((k) => k !== "label") ? { frontmatter_extra: { ...extra, sidebar: fm.sidebar } } : Object.keys(extra).length ? { frontmatter_extra: extra } : {}),
      legacy_source: `src/content/docs/${rel.split(sep).join("/")}`,
    };
    if (!data.title) warnings.push("missing title");
    // Fingerprint of what the migration wrote. apply.mjs compares it with the
    // live entry so a re-run skips untouched pages and never silently overwrites
    // an editor's change.
    data.migration_hash = fingerprint(data);
    entries.push({ id: `docs:${slug}`, slug, status: "published", data });

    for (const [t, c] of Object.entries(stats)) report.totals[t] = (report.totals[t] || 0) + c;
    for (const w of warnings) report.warnings.push(`${rel.split(sep).join("/")}: ${w}`);
    const html = blocks.filter((b) => b._type === "html").length + nestedHtml(blocks);
    if (html) report.htmlPassthrough.push({ slug, file: rel.split(sep).join("/"), blocks: html });
    report.pages.push({ slug, url: urlForSlug(slug), file: rel.split(sep).join("/"), blocks: blocks.length });
  }

  // Sidebar -> menu. Labels and order are preserved verbatim.
  const sidebar = JSON.parse(readFileSync(SIDEBAR, "utf8"));
  const menuMisses = [];
  let g = 0;
  const toItems = (items) =>
    items.map((it) => {
      if (it.items) {
        g += 1;
        return { type: "custom", label: it.label, url: "#", cssClasses: "sidebar-group", ...(it.collapsed ? { titleAttr: "collapsed" } : {}), children: toItems(it.items) };
      }
      const link = String(it.link || "");
      const internal = !/^[a-z]+:\/\//i.test(link);
      const slug = link.replace(/^\/|\/$/g, "") || "index";
      if (internal && bySlug.has(slug)) return { type: "page", collection: COLLECTION, ref: `docs:${slug}`, label: it.label };
      if (internal) menuMisses.push(link);
      return { type: "custom", label: it.label, url: link, ...(internal ? {} : { target: "_blank" }) };
    });
  const menuItems = toItems(sidebar);
  const inMenu = new Set();
  const markRefs = (items) => items.forEach((i) => (i.ref && inMenu.add(i.ref), i.children && markRefs(i.children)));
  markRefs(menuItems);
  report.notInSidebar = entries.filter((e) => !inMenu.has(e.id)).map((e) => e.slug);
  report.sidebarLinksWithoutPage = menuMisses;

  const seed = {
    $schema: "https://emdashcms.com/seed.schema.json",
    version: "1",
    defaultLocale: "en",
    meta: { name: "eTop University", description: "Migrated from the Astro Starlight sources by scripts/emdash/build-seed.mjs. Do not hand-edit; re-run the script.", author: "eTop Technology" },
    settings: { title: "eTop University", tagline: "Tutorials, guides, and policies from eTop Technology — your MSP learning hub." },
    collections: [
      {
        slug: COLLECTION,
        label: "Docs",
        labelSingular: "Doc",
        description: "eTop University pages (formerly src/content/docs).",
        icon: "book-open",
        supports: ["drafts", "revisions", "preview", "search", "seo"],
        urlPattern: "/{slug}",
        sortOrder: 1,
        fields: [
          { slug: "title", label: "Title", type: "string", required: true, searchable: true },
          { slug: "description", label: "Description", type: "text", searchable: true },
          { slug: "body", label: "Body", type: "portableText", searchable: true },
          { slug: "sidebar_label", label: "Sidebar label (optional)", type: "string" },
          { slug: "template", label: "Template", type: "select", defaultValue: "doc", options: { choices: [{ value: "doc", label: "Doc" }, { value: "splash", label: "Splash" }] } },
          { slug: "frontmatter_extra", label: "Other frontmatter", type: "json" },
          { slug: "legacy_source", label: "Migrated from", type: "string" },
          { slug: "migration_hash", label: "Migration fingerprint", type: "string" },
        ],
      },
    ],
    menus: [{ name: MENU, label: "Docs sidebar", items: menuItems }],
    redirects: [],
    content: { [COLLECTION]: entries },
  };
  report.totals.pages = entries.length;
  report.totals.sidebarGroups = g;
  return { seed, report };
}

function nestedHtml(blocks) {
  let n = 0;
  for (const b of blocks) {
    const kids = b.content || (b.rows ? b.rows.flatMap((r) => r.cells.flatMap((c) => c.content)) : []);
    n += kids.filter((k) => k._type === "html").length + nestedHtml(kids);
  }
  return n;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { seed, report } = buildSeed();
  const json = JSON.stringify(seed, null, 2) + "\n";
  if (process.argv.includes("--check")) {
    // Tolerate autocrlf checkouts on Windows.
    const cur = existsSync(SEED_OUT) ? readFileSync(SEED_OUT, "utf8").replace(/\r\n/g, "\n") : "";
    if (cur !== json) {
      console.error("STALE: .emdash/seed.json does not match src/content/docs. Run: node scripts/emdash/build-seed.mjs");
      process.exit(1);
    }
    console.log(`seed up to date (${report.totals.pages} pages)`);
  } else {
    mkdirSync(dirname(SEED_OUT), { recursive: true });
    mkdirSync(dirname(REPORT_OUT), { recursive: true });
    const before = existsSync(SEED_OUT) ? readFileSync(SEED_OUT, "utf8") : "";
    writeFileSync(SEED_OUT, json);
    writeFileSync(REPORT_OUT, JSON.stringify(report, null, 2) + "\n");
    console.log(`${before === json ? "unchanged" : "wrote"} .emdash/seed.json: ${report.totals.pages} pages, ${JSON.stringify(report.totals)}`);
    console.log(`warnings: ${report.warnings.length}, html passthrough pages: ${report.htmlPassthrough.length}, not in sidebar: ${report.notInSidebar.length}, sidebar links w/o page: ${report.sidebarLinksWithoutPage.length}`);
  }
}
