import { test } from "node:test";
import assert from "node:assert/strict";
import { markdownToPortableText as md, portableTextToPlain, flattenBoxes } from "../lib/md-to-pt.mjs";
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

test("asides become editable content between start/end markers (#15)", () => {
  const { blocks } = md(":::caution[Heads up]\nBe **careful**\n:::\n");
  assert.deepEqual(types(blocks), ["asideStart", "block", "asideEnd"]);
  assert.deepEqual(blocks[0], { _type: "asideStart", _key: blocks[0]._key, variant: "caution", title: "Heads up" });
  assert.deepEqual(blocks[2], { _type: "asideEnd", _key: blocks[0]._key + "e", closes: "aside" });
  assert.equal(portableTextToPlain([blocks[1]]), "Be careful");
});

test("flattenBoxes: nested boxes flatten in order; keys of other blocks never change", () => {
  const inner = { _type: "block", _key: "k3", children: [] };
  const flat = flattenBoxes([
    { _type: "block", _key: "k1", children: [] },
    { _type: "details", _key: "k2", summary: "S", content: [inner, { _type: "aside", _key: "k4", variant: "tip", content: [] }] },
  ]);
  assert.deepEqual(flat.map((b) => `${b._type}:${b._key}`), ["block:k1", "detailsStart:k2", "block:k3", "asideStart:k4", "asideEnd:k4e", "detailsEnd:k2e"]);
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
  assert.deepEqual(types(blocks), ["detailsStart", "block", "detailsEnd"]);
  assert.equal(blocks[0].summary, "🚀 Integrity");
  assert.equal(portableTextToPlain([blocks[1]]), "Body text");
});

test("inline html links keep target=_blank and nested strong", () => {
  const { blocks } = md('1. Visit <a href="https://portal.etop.tech" target="_blank" rel="noopener"><strong>portal.etop.tech</strong></a>.\n');
  const b = blocks[0];
  assert.equal(b.markDefs[0].href, "https://portal.etop.tech");
  assert.equal(b.markDefs[0].blank, true);
  const s = b.children.find((c) => c.text === "portal.etop.tech");
  assert.ok(s.marks.includes("strong") && s.marks.includes(b.markDefs[0]._key));
});

test("highlight becomes strong (the CMS editor rejects unknown marks)", () => {
  const { blocks } = md('<mark style="color:yellow;">New Policy</mark>\n');
  assert.equal(blocks[0].markDefs.length, 0);
  assert.deepEqual(blocks[0].children.find((c) => c.text === "New Policy").marks, ["strong"]);
});

test("gfm tables", () => {
  const { blocks } = md("| A | B |\n|---|:-:|\n| 1 | **2** |\n");
  assert.equal(blocks[0]._type, "table");
  assert.equal(blocks[0].rows.length, 2);
  // EmDash editor shape: tableRow/tableCell, inline spans, per-cell header flag.
  assert.equal(blocks[0].rows[0]._type, "tableRow");
  assert.equal(blocks[0].rows[0].cells[0]._type, "tableCell");
  assert.equal(blocks[0].rows[0].cells[0].isHeader, true);
  assert.equal(blocks[0].rows[1].cells[0].isHeader, undefined);
  assert.equal(blocks[0].rows[1].cells[1].textAlign, "center");
  assert.deepEqual(blocks[0].rows[1].cells[1].content.map((c) => [c._type, c.text, c.marks]), [["span", "2", ["strong"]]]);
});

test("a second paragraph in a list step joins the step's text (editor keeps it in the step)", () => {
  const { blocks } = md("1. First line\n\n   More about step one\n2. Two\n");
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].children.map((c) => c.text).join(""), "First line\n\nMore about step one");
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

test("content inside a step is stored the way the CMS editor keeps it", () => {
  // Code/extra text inside step 3 sit between the items as plain blocks; step 4
  // carries its real number so the list continues after an editor save.
  const { blocks } = md(["3. one", "   ```", "   x", "   ```", "   then more", "4. two", ""].join("\n"));
  // listContinuation + level stay as rendering hints (the editor drops them on save).
  assert.deepEqual(blocks.map((b) => [b._type, b.listItem ?? null, b.listStart ?? null, !!b.listContinuation, b.level ?? null]), [
    ["block", "number", 3, false, 1], ["code", null, null, true, 1], ["block", null, null, true, 1], ["block", "number", 4, false, 1],
  ]);
});

test("an image-only list item hangs on an empty text item", () => {
  const { blocks } = md("- ![a](a.png)\n- text\n");
  assert.deepEqual(blocks.map((b) => [b._type, b.listItem ?? null]), [["block", "bullet"], ["image", null], ["block", "bullet"]]);
});

test("task lists and linked images keep their state", () => {
  const { blocks } = md("- [x] done\n- [ ] todo\n\n[![a](a.png)](https://x.com)\n");
  assert.deepEqual(blocks.slice(0, 2).map((b) => b.checked), [true, false]);
  assert.equal(blocks[2]._type, "image");
  assert.equal(blocks[2].link, "https://x.com");
});

test("a note box inside a list item keeps the step hint on its start marker", () => {
  const { blocks } = md("1. step\n\n   :::note\n   text\n   :::\n\n2. step\n");
  assert.deepEqual(types(blocks), ["block", "asideStart", "block", "asideEnd", "block"]);
  assert.equal(blocks[1].listContinuation, true);
  assert.equal(blocks[1].level, 1);
});
