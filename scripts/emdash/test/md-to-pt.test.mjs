import { test } from "node:test";
import assert from "node:assert/strict";
import { markdownToPortableText as md, portableTextToPlain } from "../lib/md-to-pt.mjs";
import { buildSeed, slugForFile } from "../build-seed.mjs";

const types = (bs) => bs.map((b) => b._type);

test("headings, marks, links", () => {
  const { blocks } = md("## Hi **bold** _em_ `code` [link](https://x.y)\n");
  assert.equal(blocks[0].style, "h2");
  const marks = blocks[0].children.map((c) => c.marks.join(","));
  assert.ok(marks.includes("strong") && marks.includes("em") && marks.includes("code"));
  assert.equal(blocks[0].markDefs[0].href, "https://x.y");
});

test("nested lists keep level and type", () => {
  const { blocks } = md("1. one\n   * a\n2. two\n");
  assert.deepEqual(blocks.map((b) => [b.listItem, b.level]), [["number", 1], ["bullet", 2], ["number", 1]]);
});

test("asides become aside blocks with variant and title", () => {
  const { blocks } = md(":::caution[Heads up]\nBe **careful**\n:::\n");
  assert.equal(blocks[0]._type, "aside");
  assert.equal(blocks[0].variant, "caution");
  assert.equal(blocks[0].title, "Heads up");
  assert.equal(portableTextToPlain(blocks[0].content), "Be careful");
});

test("emoji shortcodes are not eaten by the directive parser", () => {
  const { blocks } = md("> :bulb: Tip: click it\n");
  assert.equal(blocks[0].style, "blockquote");
  assert.equal(blocks[0].children[0].text, ":bulb: Tip: click it");
});

test("gitbook figure html becomes an editable image block", () => {
  const { blocks } = md('<figure><img src="/.gitbook/assets/image (36).png" alt="x"><figcaption>Cap</figcaption></figure>\n');
  assert.deepEqual(blocks[0], { _type: "image", _key: blocks[0]._key, alt: "x", asset: { url: "/.gitbook/assets/image (36).png" }, caption: "Cap" });
});

test("images inside a paragraph split the paragraph", () => {
  const { blocks } = md(["Type it\\", "\\", "![](</.gitbook/assets/image (40).png>)", ""].join("\n"));
  assert.deepEqual(types(blocks), ["block", "image"]);
  assert.equal(blocks[0].children[0].text, "Type it");
  assert.equal(blocks[1].asset.url, "/.gitbook/assets/image (40).png");
});

test("details spread over several nodes", () => {
  const { blocks } = md("<details>\n\n<summary>🚀 Integrity</summary>\n\nBody **text**\n\n</details>\n");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]._type, "details");
  assert.equal(blocks[0].summary, "🚀 Integrity");
  assert.equal(portableTextToPlain(blocks[0].content), "Body text");
});

test("inline html links keep target=_blank and nested strong", () => {
  const { blocks } = md('1. Visit <a href="https://portal.etop.tech" target="_blank" rel="noopener"><strong>portal.etop.tech</strong></a>.\n');
  const b = blocks[0];
  assert.equal(b.markDefs[0].href, "https://portal.etop.tech");
  assert.equal(b.markDefs[0].blank, true);
  const s = b.children.find((c) => c.text === "portal.etop.tech");
  assert.ok(s.marks.includes("strong") && s.marks.includes(b.markDefs[0]._key));
});

test("highlight mark keeps its colour", () => {
  const { blocks } = md('<mark style="color:yellow;">**New Policy**</mark>\n');
  assert.equal(blocks[0].markDefs[0]._type, "highlight");
  assert.equal(blocks[0].markDefs[0].color, "yellow");
});

test("gfm tables", () => {
  const { blocks } = md("| A | B |\n|---|:-:|\n| 1 | **2** |\n");
  assert.equal(blocks[0]._type, "table");
  assert.equal(blocks[0].rows.length, 2);
  assert.equal(blocks[0].rows[0].header, true);
  assert.deepEqual(blocks[0].align, [null, "center"]);
});

test("fenced code keeps language", () => {
  const { blocks } = md("```powershell\nGet-Item .\n```\n");
  assert.deepEqual([blocks[0]._type, blocks[0].language, blocks[0].code], ["code", "powershell", "Get-Item ."]);
});

test("unknown inline html falls back to raw html, never drops content", () => {
  const { blocks } = md('Press <kbd>Ctrl</kbd> now\n');
  assert.equal(blocks[0]._type, "html");
  assert.match(blocks[0].html, /<kbd>Ctrl<\/kbd>/);
});

test("conversion is deterministic", () => {
  const src = "## A\n\n* x\n* y\n\n<figure><img src=\"/a.png\"></figure>\n";
  assert.deepEqual(md(src), md(src));
});

test("slugs match Starlight ids", () => {
  assert.equal(slugForFile("index.md"), "index");
  assert.equal(slugForFile("about-us/values.md"), "about-us/values");
  assert.equal(slugForFile("education/self-help-guides/backups/index.md"), "education/self-help-guides/backups");
});

test("real corpus: every page converts, no warnings, sidebar fully mapped, seed deterministic", () => {
  const a = buildSeed();
  const b = buildSeed();
  assert.equal(JSON.stringify(a.seed), JSON.stringify(b.seed));
  assert.equal(a.report.warnings.length, 0, a.report.warnings.join("\n"));
  assert.equal(a.report.sidebarLinksWithoutPage.length, 0);
  assert.equal(a.report.notInSidebar.length, 0);
  assert.ok(a.seed.content.docs.length >= 118);
  for (const e of a.seed.content.docs) assert.ok(e.data.title, `${e.slug} has no title`);
});
