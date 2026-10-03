// Markdown (Starlight / GitBook-flavoured) -> Portable Text for EmDash.
//
// Deterministic: the same input always yields byte-identical output (keys are
// per-document counters, never random), so re-running the migration is a no-op
// diff. Anything we cannot express as Portable Text is kept verbatim in an
// `html` block rather than dropped, and reported back to the caller.
//
// Custom block types emitted (the theme must render these):
//   image   { alt, asset: { url }, caption?, title?, align? }
//   code    { language?, code }
//   aside   { variant: note|tip|caution|danger, title?, content: PT[] }
//   table   { align: (left|center|right|null)[], rows: [{ header, cells: [{ content: PT[] }] }] }
//   details { summary, content: PT[] }
//   html    { html }                      raw passthrough, rendered as-is
//   break   { style: "lineBreak" }        thematic break (---)
// Marks: strong, em, code, strike-through, underline; markDefs link { href, blank? }, highlight { color }.

import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkDirective from "remark-directive";
import remarkSmartypants from "remark-smartypants";
import { parse as parseHtml } from "node-html-parser";

const ASIDE_VARIANTS = new Set(["note", "tip", "caution", "danger"]);
// Same pipeline Astro runs for Starlight: GFM, directives (asides) and
// SmartyPants (curly quotes, en/em dashes, ellipses), so the stored text is the
// text readers already see.
const processor = unified().use(remarkParse).use(remarkGfm).use(remarkDirective).use(remarkSmartypants);

export function markdownToPortableText(markdown) {
  const ctx = {
    src: markdown,
    n: 0,
    warnings: [],
    stats: {},
    definitions: new Map(),
  };
  const tree = processor.runSync(processor.parse(markdown));
  collectDefinitions(tree, ctx);
  const blocks = convertChildren(tree.children, ctx, {});
  return { blocks, warnings: ctx.warnings, stats: ctx.stats };
}

// ---------------------------------------------------------------------------

function key(ctx) {
  ctx.n += 1;
  return "k" + ctx.n.toString(36).padStart(4, "0");
}

function count(ctx, type) {
  ctx.stats[type] = (ctx.stats[type] || 0) + 1;
}

function slice(ctx, node) {
  const s = node.position?.start?.offset;
  const e = node.position?.end?.offset;
  return s == null || e == null ? "" : ctx.src.slice(s, e);
}

function collectDefinitions(node, ctx) {
  if (node.type === "definition") ctx.definitions.set(node.identifier, node);
  for (const c of node.children || []) collectDefinitions(c, ctx);
}

// Block conversion -----------------------------------------------------------

// `list` = { listItem, level } when converting inside a list.
function convertChildren(nodes, ctx, list) {
  const out = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];

    // <details> ... </details> spread across several mdast nodes.
    if (node.type === "html" && /^\s*<details[\s>]/i.test(node.value) && !/<\/details>/i.test(node.value)) {
      let j = i + 1;
      let depth = 1;
      for (; j < nodes.length; j++) {
        const v = nodes[j].type === "html" ? nodes[j].value : "";
        depth += (v.match(/<details[\s>]/gi) || []).length;
        depth -= (v.match(/<\/details>/gi) || []).length;
        if (depth <= 0) break;
      }
      if (j < nodes.length) {
        out.push(detailsBlock(node, nodes.slice(i + 1, j), nodes[j], ctx));
        i = j;
        continue;
      }
      ctx.warnings.push("unclosed <details>; kept as raw html");
    }
    out.push(...convertBlock(node, ctx, list));
  }
  return out;
}

function detailsBlock(open, inner, close, ctx) {
  count(ctx, "details");
  let summary = "";
  const rest = [];
  const grab = (html) => {
    const m = html.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i);
    if (m && !summary) summary = parseHtml(m[1]).textContent.trim();
    return html.replace(/<\/?details[^>]*>/gi, "").replace(/<summary[^>]*>[\s\S]*?<\/summary>/i, "").trim();
  };
  const leftover = grab(open.value);
  if (leftover) rest.push({ type: "html", value: leftover, position: open.position });
  for (const n of inner) {
    if (n.type === "html") {
      const v = grab(n.value);
      if (v) rest.push({ ...n, value: v });
    } else rest.push(n);
  }
  const tail = grab(close.value);
  if (tail) rest.push({ type: "html", value: tail, position: close.position });
  return { _type: "details", _key: key(ctx), summary, content: convertChildren(rest, ctx, {}) };
}

function convertBlock(node, ctx, list) {
  switch (node.type) {
    case "paragraph":
      return paragraph(node, ctx, list, "normal");
    case "heading":
      return paragraph(node, ctx, {}, "h" + node.depth);
    case "blockquote":
      return node.children.flatMap((c) =>
        c.type === "paragraph" ? paragraph(c, ctx, list, "blockquote") : convertBlock(c, ctx, list),
      );
    case "list":
      return listBlocks(node, ctx, (list.level || 0) + 1);
    case "code":
      count(ctx, "code");
      return [{ _type: "code", _key: key(ctx), ...(node.lang ? { language: node.lang } : {}), code: node.value }];
    case "thematicBreak":
      count(ctx, "break");
      return [{ _type: "break", _key: key(ctx), style: "lineBreak" }];
    case "html":
      return htmlBlock(node.value, ctx);
    case "table":
      return [tableBlock(node, ctx)];
    case "containerDirective":
      if (ASIDE_VARIANTS.has(node.name)) return [asideBlock(node, ctx)];
      ctx.warnings.push(`unknown container directive :::${node.name}; kept as raw markdown text`);
      return rawText(node, ctx, list);
    case "leafDirective":
      return rawText(node, ctx, list);
    case "definition":
      return [];
    case "image":
    case "imageReference":
      return [imageFromNode(node, ctx)];
    default:
      ctx.warnings.push(`unhandled block node ${node.type}; kept as raw markdown text`);
      return rawText(node, ctx, list);
  }
}

function rawText(node, ctx, list) {
  return [textBlock([{ _type: "span", _key: key(ctx), text: slice(ctx, node), marks: [] }], [], "normal", list, ctx)];
}

function listBlocks(node, ctx, level) {
  const out = [];
  const listItem = node.ordered ? "number" : "bullet";
  for (const li of node.children) {
    let first = true;
    for (const child of li.children) {
      if (child.type === "paragraph") {
        const blocks = paragraph(child, ctx, { listItem, level }, "normal");
        if (!first && blocks.length && blocks[0]._type === "block" && out.length && out[out.length - 1]._type === "block" && out[out.length - 1].listItem) {
          // Continuation paragraph of the same <li>: append to the item.
          const prev = out[out.length - 1];
          const b = blocks.shift();
          prev.children.push({ _type: "span", _key: key(ctx), text: "\n\n", marks: [] }, ...b.children);
          prev.markDefs.push(...b.markDefs);
        }
        out.push(...blocks);
      } else if (child.type === "list") {
        out.push(...listBlocks(child, ctx, level + 1));
      } else {
        out.push(...convertBlock(child, ctx, { listItem, level }));
      }
      first = false;
    }
    if (li.children.length === 0) out.push(textBlock([], [], "normal", { listItem, level }, ctx));
  }
  return out;
}

function textBlock(children, markDefs, style, list, ctx) {
  count(ctx, "block");
  const b = { _type: "block", _key: key(ctx), style, markDefs, children };
  if (list && list.listItem) {
    b.listItem = list.listItem;
    b.level = list.level;
  }
  if (children.length === 0) children.push({ _type: "span", _key: key(ctx), text: "", marks: [] });
  return b;
}

// Paragraph -> one or more blocks (images inside a paragraph become their own block).
function paragraph(node, ctx, list, style) {
  const state = { out: [], spans: [], markDefs: [], stack: [], unsupported: false };
  walkInline(node.children, ctx, state, list, style);
  if (state.unsupported) {
    // Inline HTML we cannot model: keep the whole paragraph verbatim.
    return htmlBlock(slice(ctx, node), ctx);
  }
  flush(state, ctx, list, style);
  return state.out;
}

function flush(state, ctx, list, style) {
  const spans = trimSpans(state.spans);
  if (spans.length) state.out.push(textBlock(spans, usedDefs(spans, state.markDefs), style, list, ctx));
  state.spans = [];
}

function usedDefs(spans, defs) {
  const used = new Set(spans.flatMap((s) => s.marks));
  return defs.filter((d) => used.has(d._key));
}

function trimSpans(spans) {
  const s = spans.filter((x) => x.text !== "");
  while (s.length && /^\s*$/.test(s[0].text)) s.shift();
  while (s.length && /^\s*$/.test(s[s.length - 1].text)) s.pop();
  if (s.length) {
    s[0] = { ...s[0], text: s[0].text.replace(/^\s+/, "") };
    const l = s.length - 1;
    s[l] = { ...s[l], text: s[l].text.replace(/\s+$/, "") };
  }
  // Merge neighbours that carry identical marks.
  const merged = [];
  for (const x of s) {
    const p = merged[merged.length - 1];
    if (p && p.marks.join("|") === x.marks.join("|")) p.text += x.text;
    else merged.push({ ...x, marks: [...x.marks] });
  }
  return merged;
}

function pushText(text, ctx, state) {
  state.spans.push({ _type: "span", _key: key(ctx), text, marks: state.stack.map((m) => m.mark) });
}

const INLINE_OPEN = /^<(a|strong|b|em|i|mark|u|code|s|del)(\s[^>]*)?>$/i;
const INLINE_CLOSE = /^<\/(a|strong|b|em|i|mark|u|code|s|del)>$/i;
const DECORATOR = { strong: "strong", b: "strong", em: "em", i: "em", u: "underline", code: "code", s: "strike-through", del: "strike-through" };

function walkInline(nodes, ctx, state, list, style) {
  for (const n of nodes) {
    switch (n.type) {
      case "text":
        pushText(n.value, ctx, state);
        break;
      case "break":
        pushText("\n", ctx, state);
        break;
      case "inlineCode":
        state.stack.push({ mark: "code" });
        pushText(n.value, ctx, state);
        state.stack.pop();
        break;
      case "emphasis":
      case "strong":
      case "delete": {
        state.stack.push({ mark: { emphasis: "em", strong: "strong", delete: "strike-through" }[n.type] });
        walkInline(n.children, ctx, state, list, style);
        state.stack.pop();
        break;
      }
      case "link":
      case "linkReference": {
        const href = n.type === "link" ? n.url : ctx.definitions.get(n.identifier)?.url;
        if (!href) {
          pushText(slice(ctx, n), ctx, state);
          break;
        }
        const k = key(ctx);
        state.markDefs.push({ _type: "link", _key: k, href, ...(n.title ? { title: n.title } : {}) });
        state.stack.push({ mark: k });
        walkInline(n.children, ctx, state, list, style);
        state.stack.pop();
        break;
      }
      case "image":
      case "imageReference":
        flush(state, ctx, list, style);
        state.out.push(imageFromNode(n, ctx));
        break;
      case "html":
        inlineHtml(n, ctx, state, list, style);
        break;
      case "textDirective":
        // `:bulb:` and friends: not a directive, restore the source text
        // (Starlight does the same for directives it does not handle).
        pushText(slice(ctx, n), ctx, state);
        break;
      case "footnoteReference":
        pushText(slice(ctx, n), ctx, state);
        break;
      default:
        ctx.warnings.push(`unhandled inline node ${n.type}`);
        pushText(slice(ctx, n), ctx, state);
    }
  }
}

function inlineHtml(n, ctx, state, list, style) {
  const v = n.value.trim();
  let m;
  if (/^<br\s*\/?>$/i.test(v)) return pushText("\n", ctx, state);
  if (/^<img\s/i.test(v)) {
    flush(state, ctx, list, style);
    const img = parseHtml(v).querySelector("img");
    state.out.push(imageBlock(ctx, img.getAttribute("src") || "", img.getAttribute("alt") || "", {}));
    return;
  }
  if ((m = v.match(INLINE_OPEN))) {
    const tag = m[1].toLowerCase();
    const el = parseHtml(v + `</${tag}>`).firstChild;
    if (tag === "a") {
      const k = key(ctx);
      const blank = el.getAttribute("target") === "_blank";
      state.markDefs.push({ _type: "link", _key: k, href: el.getAttribute("href") || "", ...(blank ? { blank: true } : {}) });
      state.stack.push({ tag, mark: k });
    } else if (tag === "mark") {
      const k = key(ctx);
      const color = (el.getAttribute("style") || "").match(/color:\s*([^;]+)/i)?.[1]?.trim();
      state.markDefs.push({ _type: "highlight", _key: k, ...(color ? { color } : {}) });
      state.stack.push({ tag, mark: k });
    } else {
      state.stack.push({ tag, mark: DECORATOR[tag] });
    }
    count(ctx, "inlineHtml");
    return;
  }
  if ((m = v.match(INLINE_CLOSE))) {
    const tag = m[1].toLowerCase();
    const i = state.stack.map((s) => s.tag).lastIndexOf(tag);
    if (i >= 0) state.stack.splice(i, 1);
    return;
  }
  state.unsupported = true;
  ctx.warnings.push(`inline html ${v.slice(0, 40)} -> paragraph kept as raw html`);
}

// HTML blocks -----------------------------------------------------------------

function htmlBlock(html, ctx) {
  const root = parseHtml(html.trim());
  // A wrapper (figure/div/p) whose only real content is one <img> (+ figcaption)
  // becomes a first-class image block, which editors can actually edit.
  const imgs = root.querySelectorAll("img");
  if (imgs.length === 1) {
    const clone = parseHtml(html.trim());
    clone.querySelectorAll("img, figcaption").forEach((e) => e.remove());
    const leftoverText = clone.textContent.trim();
    const leftoverTags = clone.querySelectorAll("*").filter((e) => !["figure", "div", "p", "picture"].includes(e.tagName.toLowerCase()));
    if (!leftoverText && leftoverTags.length === 0) {
      const img = imgs[0];
      const caption = root.querySelector("figcaption")?.textContent.trim();
      const align = root.querySelector("[align]")?.getAttribute("align");
      return [imageBlock(ctx, img.getAttribute("src") || "", img.getAttribute("alt") || "", { caption, align })];
    }
  }
  if (!html.trim()) return [];
  count(ctx, "html");
  return [{ _type: "html", _key: key(ctx), html: html.trim() }];
}

function imageBlock(ctx, url, alt, { caption, title, align } = {}) {
  count(ctx, "image");
  const b = { _type: "image", _key: key(ctx), alt: alt || "", asset: { url } };
  if (caption) b.caption = caption;
  if (title) b.title = title;
  if (align) b.align = align;
  return b;
}

function imageFromNode(n, ctx) {
  const url = n.type === "image" ? n.url : ctx.definitions.get(n.identifier)?.url || "";
  return imageBlock(ctx, url, n.alt || "", { title: n.title || undefined });
}

function asideBlock(node, ctx) {
  count(ctx, "aside");
  let title;
  const body = [];
  for (const c of node.children) {
    if (c.data?.directiveLabel) title = c.children.map((x) => slice(ctx, x)).join("");
    else body.push(c);
  }
  return { _type: "aside", _key: key(ctx), variant: node.name, ...(title ? { title } : {}), content: convertChildren(body, ctx, {}) };
}

function tableBlock(node, ctx) {
  count(ctx, "table");
  return {
    _type: "table",
    _key: key(ctx),
    align: node.align || [],
    rows: node.children.map((row, r) => ({
      _key: key(ctx),
      header: r === 0,
      cells: row.children.map((cell) => {
        const state = { out: [], spans: [], markDefs: [], stack: [], unsupported: false };
        walkInline(cell.children, ctx, state, {}, "normal");
        if (state.unsupported) return { _key: key(ctx), content: htmlBlock(slice(ctx, cell), ctx) };
        flush(state, ctx, {}, "normal");
        return { _key: key(ctx), content: state.out };
      }),
    })),
  };
}

// Plain-text view of a PT array: used by tests and the parity check to compare
// against the rendered page.
export function portableTextToPlain(blocks) {
  const parts = [];
  for (const b of blocks || []) {
    switch (b._type) {
      case "block":
        parts.push(b.children.map((c) => c.text).join(""));
        break;
      case "image":
        if (b.caption) parts.push(b.caption);
        break;
      case "code":
        parts.push(b.code);
        break;
      case "aside":
        if (b.title) parts.push(b.title);
        parts.push(portableTextToPlain(b.content));
        break;
      case "details":
        parts.push(b.summary, portableTextToPlain(b.content));
        break;
      case "table":
        for (const r of b.rows) for (const c of r.cells) parts.push(portableTextToPlain(c.content));
        break;
      case "html":
        parts.push(parseHtml(b.html).textContent);
        break;
    }
  }
  return parts.join("\n");
}
