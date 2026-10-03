// node --experimental-strip-types --test src/lib/pt.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { inlineHtml, renderPlan, safeHref } from "./pt.ts";

const span = (text: string, marks: string[] = []) => ({ _type: "span", text, marks });
const p = (children: unknown[], extra: Record<string, unknown> = {}) => ({ _type: "block", style: "normal", markDefs: [], children, ...extra });

test("escapes text and drops unsafe links", () => {
  assert.equal(inlineHtml(p([span("<script>&")])), "&lt;script&gt;&amp;");
  const b = p([span("x", ["l"])], { markDefs: [{ _type: "link", _key: "l", href: "javascript:alert(1)" }] });
  assert.equal(inlineHtml(b), "<span>x</span>");
  assert.equal(safeHref("data:text/html,x"), null);
  assert.equal(safeHref("mailto:a@b.c"), "mailto:a@b.c");
});

test("nests marks and closes them in order", () => {
  assert.equal(inlineHtml(p([span("a", ["strong"]), span("b", ["strong", "em"]), span("c")])), "<strong>a<em>b</em></strong>c");
  assert.equal(inlineHtml(p([span("x", ["superscript"])])), "<sup>x</sup>");
});

test("nested lists with continuations", () => {
  const blocks = [
    p([span("one")], { listItem: "number", level: 1 }),
    p([span("sub")], { listItem: "bullet", level: 2 }),
    { _type: "code", code: "c:/x", listItem: "bullet", level: 2, listContinuation: true },
    p([span("two")], { listItem: "number", level: 1 }),
  ];
  const { nodes } = renderPlan(blocks);
  assert.equal(nodes.length, 1);
  const ol = nodes[0] as any;
  assert.equal(ol.kind, "list");
  assert.equal(ol.items.length, 2);
  const ul = ol.items[0].children[1];
  assert.equal(ul.kind, "list");
  assert.equal(ul.items[0].children[1].kind, "code");
});

test("headings get github-slugger ids and feed the TOC", () => {
  const { nodes, headings } = renderPlan([p([span("Our Focus 🎯")], { style: "h2" }), p([span("Our Focus 🎯")], { style: "h2" })]);
  assert.deepEqual(headings.map((h) => h.slug), ["our-focus-", "our-focus--1"]);
  assert.equal((nodes[0] as any).id, "our-focus-");
});

test("editor-made blocks go to EmDash's renderer", () => {
  const editorTable = { _type: "table", rows: [{ cells: [{ isHeader: true, content: [span("H")] }] }] };
  const legacyTable = { _type: "table", align: [null], rows: [{ header: true, cells: [{ content: [p([span("H")])] }] }] };
  const media = { _type: "image", asset: { _ref: "01ABC", url: "/_emdash/api/media/file/x.png" } };
  const { nodes } = renderPlan([editorTable, legacyTable, media, { _type: "htmlBlock", html: "<b>x</b>" }, { _type: "iframe", src: "https://x" }]);
  assert.deepEqual(nodes.map((n) => n.kind), ["native", "table", "native", "native", "native"]);
});

test("image link: string and editor object forms", () => {
  const { nodes } = renderPlan([
    { _type: "image", asset: { url: "/a b.png" }, link: "https://x.test" },
    { _type: "image", asset: { url: "/c.png" }, link: { href: "https://y.test", blank: true } },
    { _type: "image", asset: { url: "/d.png" }, link: { href: "javascript:x" } },
  ]);
  const [a, b, c] = nodes as any[];
  assert.equal(a.src, "/a%20b.png");
  assert.equal(a.link, "https://x.test");
  assert.equal(b.link, "https://y.test");
  assert.equal(b.linkBlank, true);
  assert.equal(c.link, undefined);
});

test("image keeps GitBook width, rejects junk", () => {
  const { nodes } = renderPlan([
    { _type: "image", asset: { url: "/a.png" }, width: "375" },
    { _type: "image", asset: { url: "/b.png" }, width: "100\" onload=\"x" },
  ]);
  assert.equal((nodes[0] as any).width, "375");
  assert.equal((nodes[1] as any).width, undefined);
});
