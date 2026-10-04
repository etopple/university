// node --experimental-strip-types --test src/lib/pt.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { inlineHtml, renderPlan, safeHref, withStepHints } from "./pt.ts";

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
  assert.deepEqual(nodes.map((n) => n.kind), ["table", "table", "native", "native", "native"]);
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

test("editor-shaped tables render here, with header row and alignment", () => {
  const editorTable = {
    _type: "table",
    hasHeaderRow: true,
    rows: [
      { _type: "tableRow", cells: [{ _type: "tableCell", isHeader: true, content: [span("Q")] }, { _type: "tableCell", isHeader: true, content: [span("A")] }] },
      { _type: "tableRow", cells: [{ _type: "tableCell", content: [span("x", ["strong"])], textAlign: "center" }, { _type: "tableCell", content: [span("y")], textAlign: "bogus" }] },
    ],
  };
  const t = renderPlan([editorTable]).nodes[0] as any;
  assert.equal(t.kind, "table");
  assert.equal(t.rows[0].cells[0].header, true);
  assert.equal(t.rows[1].cells[0].align, "center");
  assert.equal(t.rows[1].cells[1].align, undefined);
  assert.equal(t.rows[1].cells[0].children[0].html, "<strong>x</strong>");
});

test("editor-safe steps: content between items goes back into the step only when the list continues", () => {
  const { nodes } = renderPlan([
    p([span("one")], { listItem: "number", level: 1 }),
    { _type: "image", asset: { url: "/s1.png" } },
    p([span("more about one")]),
    p([span("two")], { listItem: "number", level: 1, listStart: 2 }), // continues: back into step 1
    p([span("sub")], { listItem: "bullet", level: 2 }),
    { _type: "image", asset: { url: "/s2.png" } },
    p([span("sub2")], { listItem: "bullet", level: 2 }), // nested: continues
    { _type: "image", asset: { url: "/between.png" } },
    p([span("new list")], { listItem: "number", level: 1 }), // starts at 1: separate list
  ]);
  assert.deepEqual(nodes.map((n) => n.kind), ["list", "image", "list"]);
  const ol = nodes[0] as any;
  assert.equal(ol.items.length, 2);
  assert.deepEqual(ol.items[0].children.map((c: any) => c.kind), ["html", "image", "html"]);
  const ul = ol.items[1].children[1];
  assert.equal(ul.items.length, 2);
  assert.equal(ul.items[0].children[1].kind, "image");
});

test("textAlign is applied from an allowlist", () => {
  const { nodes } = renderPlan([p([span("c")], { textAlign: "center" }), p([span("x")], { textAlign: "red;}" })]);
  assert.equal((nodes[0] as any).html, '<p style="text-align: center">c</p>');
  assert.equal((nodes[1] as any).html, "<p>x</p>");
});

test("hinted content goes back exactly: parent level after a nested list, any block type", () => {
  const { nodes } = renderPlan([
    p([span("step 1")], { listItem: "number", level: 1 }),
    p([span("sub a")], { listItem: "bullet", level: 2 }),
    p([span("sub b")], { listItem: "bullet", level: 2 }),
    { _type: "image", asset: { url: "/parent.png" }, level: 1, listContinuation: true }, // belongs to step 1, not "sub b"
    p([span("quote")], { style: "blockquote", level: 2, listContinuation: true }),
    p([span("step 2")], { listItem: "number", level: 1, listStart: 2 }),
  ]);
  assert.equal(nodes.length, 1);
  const ol = nodes[0] as any;
  assert.equal(ol.items.length, 2);
  assert.deepEqual(ol.items[0].children.map((c: any) => c.kind), ["html", "list", "image", "quote"]);
});

test("bullets: hinted screenshots stay in the item; after an editor save, screenshot-only gaps still do", () => {
  const hinted = renderPlan([
    p([span("a")], { listItem: "bullet", level: 1 }),
    { _type: "image", asset: { url: "/1.png" }, level: 1, listContinuation: true },
    p([span("b")], { listItem: "bullet", level: 1 }),
  ]).nodes;
  const saved = renderPlan([
    p([span("a")], { listItem: "bullet", level: 1 }),
    { _type: "image", asset: { url: "/1.png" } },
    p([span("b")], { listItem: "bullet", level: 1 }),
  ]).nodes;
  for (const nodes of [hinted, saved]) {
    assert.equal(nodes.length, 1);
    assert.equal((nodes[0] as any).items[0].children[1].kind, "image");
  }
  // A paragraph then a new bullet list (no hint) stays two lists.
  const separate = renderPlan([p([span("a")], { listItem: "bullet", level: 1 }), p([span("Next:")]), p([span("b")], { listItem: "bullet", level: 1 })]).nodes;
  assert.deepEqual(separate.map((n) => n.kind), ["list", "html", "list"]);
});

// Shapes below are what the real EmDash editor saved on a local round-trip
// (tests/e2e/roundtrip.mjs): listContinuation/level gone from step content, the
// list's start number and a shared listId on EVERY item of each editor list.
test("after an editor save: listStart repeated on every item does not split the list (#13)", () => {
  const n = (t: string, ls: number, id: string) => p([span(t)], { listItem: "number", level: 1, listStart: ls, listId: id });
  const img = (u: string) => ({ _type: "image", asset: { url: u } });
  const { nodes } = renderPlan([
    n("one", 1, "a"),
    img("/1.png"),
    n("two", 2, "b"),
    n("three", 2, "b"), // same editor list: still item 3, not a restart at 2
    img("/2.png"),
    n("four", 4, "c"),
  ]);
  assert.equal(nodes.length, 1);
  const ol = nodes[0] as any;
  assert.equal(ol.items.length, 4);
  assert.deepEqual(ol.items.map((it: any) => it.children.map((c: any) => c.kind).join("+")), ["html+image", "html", "html+image", "html"]);
});

test("step hints put saved screenshots back, the last step's too (#14)", () => {
  const saved = [
    p([span("one")], { _key: "k1", listItem: "number", level: 1 }),
    { _type: "image", _key: "k2", asset: { url: "/1.png" } },
    p([span("sub")], { _key: "k3", listItem: "bullet", level: 2 }),
    { _type: "image", _key: "k4", asset: { url: "/2.png" } }, // belonged to step one (level 1), after the sub-list
    p([span("After the list.")], { _key: "k5" }),
  ];
  // Without hints the last screenshot falls out of the list (the #14 symptom).
  assert.deepEqual(renderPlan(saved).nodes.map((x) => x.kind), ["list", "image", "html"]);
  const hints = { k2: ["image", 1], k4: ["image", 1], k5: ["image", 1] } as Record<string, [string, number]>; // k5: wrong type, ignored
  const { nodes } = renderPlan(saved, { stepHints: hints });
  assert.deepEqual(nodes.map((x) => x.kind), ["list", "html"]);
  const item = (nodes[0] as any).items[0];
  assert.deepEqual(item.children.map((c: any) => c.kind), ["html", "image", "list", "image"]);
  // A hint never turns a list item into continuation content.
  const li = renderPlan([p([span("x")], { _key: "k1", listItem: "number", level: 1 })], { stepHints: { k1: ["block", 1] } }).nodes as any;
  assert.equal(li[0].items.length, 1);
});

test("box markers render exactly like the nested aside/details they replace (#15)", () => {
  const body = [p([span("Body")]), p([span("more", ["strong"])])];
  const nested = renderPlan([
    { _type: "aside", variant: "tip", title: "T", content: body },
    { _type: "details", summary: "S", content: [p([span("x")]), { _type: "aside", variant: "bogus", content: [p([span("in")])] }] },
  ]).nodes;
  const flat = renderPlan([
    { _type: "asideStart", _key: "a", variant: "tip", title: "T" },
    ...body,
    { _type: "asideEnd", _key: "ae", closes: "aside" },
    { _type: "detailsStart", _key: "d", summary: "S" },
    p([span("x")]),
    { _type: "asideStart", _key: "b", variant: "bogus" },
    p([span("in")]),
    { _type: "asideEnd", _key: "be", closes: "aside" },
    { _type: "detailsEnd", _key: "de", closes: "details" },
  ]).nodes;
  assert.deepEqual(flat, nested);
  // A start with no end runs to the end of the page; a stray end renders nothing.
  const open = renderPlan([{ _type: "asideEnd" }, { _type: "asideStart", variant: "note" }, p([span("a")]), p([span("b")])]).nodes as any;
  assert.equal(open.length, 1);
  assert.equal(open[0].kind, "aside");
  assert.equal(open[0].children.length, 2);
});

test("step hints: a sub-list the editor flattened after a step's code block goes back to its level", () => {
  // Saved by the real editor (teams-troubleshooting): code lost its hint, the bullets came back at level 1.
  const saved = [
    p([span("Clear the cache")], { _key: "k1", listItem: "number", level: 1, listStart: 1, listId: "a" }),
    p([span("Open:")], { _key: "k2", listItem: "bullet", level: 2 }),
    { _type: "code", _key: "k3", code: "%appdata%" },
    p([span("Delete it")], { _key: "k4", listItem: "bullet", level: 1 }),
    p([span("Next")], { _key: "k5", listItem: "number", level: 1, listStart: 2, listId: "b" }),
  ];
  const hints = { k3: ["code", 2], k4: ["li", 2] } as Record<string, [string, number]>;
  const { nodes } = renderPlan(saved, { stepHints: hints });
  assert.equal(nodes.length, 1);
  const ol = nodes[0] as any;
  assert.equal(ol.items.length, 2);
  const sub = ol.items[0].children[1];
  assert.equal(sub.kind, "list");
  assert.deepEqual(sub.items.map((it: any) => it.children.map((c: any) => c.kind).join("+")), ["html+code", "html"]);
});

test("links: tabs/newlines/control chars cannot smuggle a javascript: scheme", () => {
  for (const h of ["java\nscript:alert(1)", "java\tscript:alert(1)", "\x01javascript:alert(1)", " javascript:alert(1)"]) assert.equal(safeHref(h), null, JSON.stringify(h));
  assert.equal(safeHref("vision.md"), "vision.md");
  assert.equal(safeHref("/a b/c"), "/a b/c");
});

test("two editor lists saved back to back stay two lists; across a screenshot they are one run", () => {
  const n = (t: string, ls: number, id: string) => p([span(t)], { listItem: "number", level: 1, listStart: ls, listId: id });
  const adjacent = renderPlan([n("a", 1, "x"), n("b", 1, "x"), n("c", 5, "y"), n("d", 5, "y")]).nodes as any[];
  assert.equal(adjacent.length, 2);
  assert.equal(adjacent[1].start, 5);
  assert.equal(adjacent[1].items.length, 2);
  const gap = renderPlan([n("a", 1, "x"), { _type: "image", asset: { url: "/1.png" } }, n("b", 2, "y")]).nodes as any[];
  assert.equal(gap.length, 1);
  assert.equal(gap[0].items.length, 2);
});

test("a step hint never pulls a paragraph the editor turned into a heading into the list", () => {
  const body = [p([span("one")], { _key: "k1", listItem: "number", level: 1 }), p([span("Next part")], { _key: "k2", style: "h2" })];
  const { nodes } = renderPlan(body, { stepHints: { k2: ["block", 1] } });
  assert.deepEqual(nodes.map((x) => x.kind), ["list", "heading"]);
});

test("a stale step hint is ignored once an editor put other content in front of the block", () => {
  const img = { _type: "image", _key: "k2", asset: { url: "/1.png" } };
  const item = p([span("one")], { _key: "k1", listItem: "number", level: 1 });
  const hints = { k2: ["image", 1] } as Record<string, [string, number]>;
  // Still right after its step: goes back in.
  assert.deepEqual(renderPlan([item, img], { stepHints: hints }).nodes.map((x) => x.kind), ["list"]);
  // An editor added a paragraph between the step and the screenshot: the screenshot stays where they put it.
  const moved = renderPlan([item, p([span("Then:")], { _key: "k9" }), img], { stepHints: hints }).nodes;
  assert.deepEqual(moved.map((x) => x.kind), ["list", "html", "image"]);
  assert.equal((withStepHints([item, p([span("Then:")], { _key: "k9" }), img], hints)[2] as any).listContinuation, undefined);
  // Moved to the top of the page: no list item before it, hint ignored.
  assert.deepEqual(renderPlan([img, item], { stepHints: hints }).nodes.map((x) => x.kind), ["image", "list"]);
});

test("a note box inside a step stays a box inside that step, before and after an editor save", () => {
  // markdownToPortableText("1. step\n\n   :::note\n   text\n   :::\n\n2. step\n")
  const migrated = [
    p([span("step")], { _key: "k1", listItem: "number", level: 1 }),
    { _type: "asideStart", _key: "k2", variant: "note", level: 1, listContinuation: true },
    p([span("text")], { _key: "k3" }),
    { _type: "asideEnd", _key: "k2e", closes: "aside" },
    p([span("step")], { _key: "k4", listItem: "number", level: 1 }),
  ];
  const saved = migrated.map((b: any) => { const { listContinuation, level, ...rest } = b; return b.listItem ? b : rest; });
  for (const [body, hints] of [[migrated, undefined], [saved, { k2: ["asideStart", 1] }]] as const) {
    const { nodes } = renderPlan(body as any, { stepHints: hints as any });
    assert.equal(nodes.length, 1);
    const ol = nodes[0] as any;
    assert.equal(ol.items.length, 2);
    assert.deepEqual(ol.items[0].children.map((c: any) => c.kind), ["html", "aside"]);
    assert.equal(ol.items[0].children[1].children[0].html, "<p>text</p>");
  }
});
