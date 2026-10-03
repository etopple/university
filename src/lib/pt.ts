// Portable Text -> the HTML Starlight rendered from the old markdown.
//
// The content lane (scripts/emdash/lib/md-to-pt.mjs) flattened markdown into
// Portable Text. This file turns it back into a small node tree that
// src/components/pt/PtNodes.astro renders. Goal: the same text, links and
// image srcs as the markdown build (scripts/emdash/parity.mjs checks that).
//
// Shapes we accept are documented in scripts/emdash/README.md.
import GithubSlugger from "github-slugger";

export type PtSpan = { _type: string; _key?: string; text?: string; marks?: string[] };
export type PtMarkDef = { _type: string; _key: string; href?: string; blank?: boolean; title?: string; color?: string };
export type PtBlock = {
  _type: string;
  _key?: string;
  style?: string;
  listItem?: "bullet" | "number" | string;
  level?: number;
  listContinuation?: boolean;
  listStart?: number;
  checked?: boolean;
  markDefs?: PtMarkDef[];
  children?: PtSpan[];
  [k: string]: unknown;
};

export type Heading = { depth: number; slug: string; text: string };

export type Node =
  | { kind: "html"; html: string }
  | { kind: "heading"; depth: number; id: string; html: string; align?: string }
  | { kind: "quote"; children: Node[] }
  | { kind: "list"; ordered: boolean; start?: number; items: ListItem[] }
  | { kind: "image"; src: string; alt: string; title?: string; caption?: string; align?: string; link?: string; linkBlank?: boolean; width?: string; height?: string }
  | { kind: "code"; code: string; lang: string }
  | { kind: "aside"; variant: string; title?: string; children: Node[] }
  | { kind: "table"; rows: { cells: TableCell[] }[] }
  | { kind: "details"; summary: string; children: Node[] }
  // A block the EmDash editor makes that this renderer does not own (htmlBlock,
  // gallery, iframe, embed, editor-shaped table or media image, ...): rendered
  // by EmDash's own Portable Text components.
  | { kind: "native"; block: PtBlock };

export type ListItem = { checked?: boolean; children: Node[] };
export type TableCell = { header: boolean; align?: string; colspan?: number; rowspan?: number; children: Node[] };

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
export const esc = (s: string) => String(s ?? "").replace(/[&<>"]/g, (c) => ESC[c]);

// Only http(s), mailto, tel, relative and fragment links render as links.
// Anything else (javascript:, data:) is dropped to plain text.
export function safeHref(href: string | undefined): string | null {
  const h = String(href ?? "").trim();
  if (!h) return null;
  if (/^(https?:|mailto:|tel:)/i.test(h) || /^[/#?.]/.test(h) || !/^[a-z][a-z0-9+.-]*:/i.test(h)) return h;
  return null;
}

// Encode what a browser would (spaces, quotes, non-ASCII); keep existing %-escapes.
const encodeSrc = (u: string) => u.replace(/[^!-~]|["<>\^`{|}]/gu, (c) => encodeURIComponent(c));

const DECORATORS: Record<string, [string, string]> = {
  strong: ["<strong>", "</strong>"],
  em: ["<em>", "</em>"],
  code: ['<code dir="auto">', "</code>"],
  "strike-through": ["<del>", "</del>"],
  underline: ["<u>", "</u>"],
  superscript: ["<sup>", "</sup>"],
  subscript: ["<sub>", "</sub>"],
};

/** Inline children of one PT block as an HTML string. */
export function inlineHtml(block: Pick<PtBlock, "children" | "markDefs">): string {
  const defs = new Map((block.markDefs ?? []).map((d) => [d._key, d]));
  const open = (m: string) => {
    if (DECORATORS[m]) return DECORATORS[m][0];
    const d = defs.get(m);
    if (!d) return "";
    if (d._type === "link") {
      const href = safeHref(d.href);
      if (href === null) return "<span>";
      const t = d.title ? ` title="${esc(d.title)}"` : "";
      return `<a href="${esc(href)}"${t}${d.blank ? ' target="_blank" rel="noopener noreferrer"' : ""}>`;
    }
    if (d._type === "highlight") {
      const color = d.color && /^[#a-z0-9(),.\s%-]+$/i.test(d.color) ? ` style="color: ${esc(d.color)};"` : "";
      return `<mark${color}>`;
    }
    return "<span>";
  };
  const close = (m: string) => {
    if (DECORATORS[m]) return DECORATORS[m][1];
    const d = defs.get(m);
    if (!d) return "";
    if (d._type === "link") return safeHref(d.href) === null ? "</span>" : "</a>";
    if (d._type === "highlight") return "</mark>";
    return "</span>";
  };

  // Marks nest: keep a stack, close down to the first mark that ended, reopen the rest.
  let out = "";
  let stack: string[] = [];
  for (const span of block.children ?? []) {
    if (span._type !== "span") continue;
    const marks = (span.marks ?? []).filter((m) => DECORATORS[m] || defs.has(m));
    let keep = 0;
    while (keep < stack.length && keep < marks.length && stack[keep] === marks[keep]) keep++;
    // Marks still wanted but out of order still have to close and reopen.
    for (let i = stack.length - 1; i >= keep; i--) out += close(stack[i]);
    stack = stack.slice(0, keep);
    const wanted = marks.filter((m) => !stack.includes(m));
    for (const m of wanted) {
      out += open(m);
      stack.push(m);
    }
    out += esc(span.text ?? "").replace(/\n/g, "<br>\n");
  }
  for (let i = stack.length - 1; i >= 0; i--) out += close(stack[i]);
  return out;
}

export function plainText(block: Pick<PtBlock, "children">): string {
  return (block.children ?? []).map((c) => c.text ?? "").join("");
}

// Alignment the editor saves on paragraphs and headings (allowlisted: it lands in a style attribute).
const textAlign = (b: PtBlock) => (typeof b.textAlign === "string" && ALIGN.has(b.textAlign) ? b.textAlign : undefined);

type Ctx = { slugger: GithubSlugger; headings: Heading[] };

/** One non-list block (or a list continuation) to a node. */
function single(b: PtBlock, ctx: Ctx): Node | null {
  switch (b._type) {
    case "block": {
      const style = b.style ?? "normal";
      const m = /^h([1-6])$/.exec(style);
      if (m) {
        const text = plainText(b);
        const id = ctx.slugger.slug(text);
        const depth = Number(m[1]);
        ctx.headings.push({ depth, slug: id, text });
        return { kind: "heading", depth, id, html: inlineHtml(b), align: textAlign(b) };
      }
      const align = textAlign(b);
      return { kind: "html", html: `<p${align ? ` style="text-align: ${align}"` : ""}>${inlineHtml(b)}</p>` };
    }
    case "image": {
      const asset = (b.asset ?? {}) as { url?: string; _ref?: string };
      // Uploaded in the CMS: EmDash resolves media refs, sizes and providers.
      if (asset._ref) return { kind: "native", block: b };
      const src = String(asset.url ?? b.src ?? "");
      if (!src) return null;
      const link = imageLink(b.link);
      return {
        kind: "image",
        src: encodeSrc(src),
        alt: String(b.alt ?? ""),
        title: b.title ? String(b.title) : undefined,
        caption: b.caption ? String(b.caption) : undefined,
        align: b.align ? String(b.align) : undefined,
        width: /^\d+(%|px)?$/.test(String(b.width ?? "")) ? String(b.width) : undefined,
        height: /^\d+(%|px)?$/.test(String(b.height ?? "")) ? String(b.height) : undefined,
        link: link?.href,
        linkBlank: link?.blank,
      };
    }
    case "code":
      return { kind: "code", code: String(b.code ?? ""), lang: String(b.language ?? "plaintext") || "plaintext" };
    case "aside":
      return {
        kind: "aside",
        variant: ["note", "tip", "caution", "danger"].includes(String(b.variant)) ? String(b.variant) : "note",
        title: b.title ? String(b.title) : undefined,
        children: toNodes((b.content as PtBlock[]) ?? [], ctx),
      };
    case "table": {
      const t = tableNode(b, ctx);
      return t ?? { kind: "native", block: b };
    }
    case "details":
      return { kind: "details", summary: String(b.summary ?? ""), children: toNodes((b.content as PtBlock[]) ?? [], ctx) };
    case "html":
      return { kind: "html", html: String(b.html ?? "") };
    case "break":
      return { kind: "html", html: "<hr>" };
    default:
      return b._type && b._type !== "block" ? { kind: "native", block: b } : null;
  }
}

function imageLink(link: unknown): { href: string; blank: boolean } | undefined {
  // Legacy seed: a string. EmDash editor: { href, blank? }.
  const raw = typeof link === "string" ? { href: link, blank: false } : link && typeof link === "object" ? (link as { href?: unknown; blank?: unknown }) : undefined;
  if (!raw || typeof raw.href !== "string") return undefined;
  const href = safeHref(raw.href);
  return href === null ? undefined : { href, blank: raw.blank === true && !href.startsWith("#") };
}

const ALIGN = new Set(["left", "center", "right", "justify"]);
const span1 = (n: unknown) => (Number.isInteger(n) && (n as number) > 1 && (n as number) <= 100 ? (n as number) : undefined);

// Tables in either shape: the CMS editor's (rows[].cells[] of tableCell with inline
// spans and isHeader) or the first migration's (row.header, cells[].content as
// PT blocks, block-level align[]). Anything else goes to EmDash's own renderer.
function tableNode(b: PtBlock, ctx: Ctx): Extract<Node, { kind: "table" }> | null {
  type RawCell = { content?: unknown; markDefs?: PtMarkDef[]; isHeader?: boolean; textAlign?: string; colspan?: unknown; rowspan?: unknown };
  const rows = b.rows as { header?: boolean; cells?: RawCell[] }[] | undefined;
  if (!Array.isArray(rows) || !rows.length || !rows.every((r) => Array.isArray(r.cells))) return null;
  const legacyAlign = (b.align as (string | null)[] | undefined) ?? [];
  const tableDefs = (b.markDefs as PtMarkDef[] | undefined) ?? [];
  return {
    kind: "table",
    rows: rows.map((r) => ({
      cells: r.cells!.map((c, i) => {
        const content = Array.isArray(c.content) ? (c.content as PtBlock[]) : [];
        const inline = content.every((x) => x && x._type === "span");
        const align = c.textAlign ?? legacyAlign[i] ?? undefined;
        return {
          header: c.isHeader === true || r.header === true,
          align: align && ALIGN.has(align) ? align : undefined,
          colspan: span1(c.colspan),
          rowspan: span1(c.rowspan),
          children: inline
            ? [{ kind: "html", html: inlineHtml({ children: content as PtSpan[], markDefs: [...tableDefs, ...(c.markDefs ?? [])] }) } as Node]
            : cellNodes(content, ctx),
        };
      }),
    })),
  };
}

// Table cells hold one paragraph: render it inline, without the <p>.
function cellNodes(content: PtBlock[], ctx: Ctx): Node[] {
  if (content.length === 1 && content[0]._type === "block" && (content[0].style ?? "normal") === "normal")
    return [{ kind: "html", html: inlineHtml(content[0]) }];
  return toNodes(content, ctx);
}

/** A PT array to render nodes. Also fills ctx.headings. */
export function toNodes(blocks: PtBlock[], ctx: Ctx): Node[] {
  const out: Node[] = [];
  let i = 0;
  while (i < blocks.length) {
    const b = blocks[i];
    if (b.listItem) {
      const end = listEnd(blocks, i);
      out.push(...buildLists(blocks.slice(i, end), ctx));
      i = end;
      continue;
    }
    if (b._type === "block" && b.style === "blockquote") {
      const quote: Node[] = [];
      while (i < blocks.length && blocks[i]._type === "block" && blocks[i].style === "blockquote" && !blocks[i].listItem) {
        quote.push({ kind: "html", html: `<p>${inlineHtml(blocks[i])}</p>` });
        i++;
      }
      out.push({ kind: "quote", children: quote });
      continue;
    }
    const n = single(b, ctx);
    if (n) out.push(n);
    i++;
  }
  return out;
}

// Screenshots and code that belong to a step. The CMS editor does not keep
// listContinuation (or listItem) on them, so after an editor save they sit
// between two list blocks: keep them with the step and keep the numbering going.
const MEDIA = new Set(["image", "code", "html", "htmlBlock", "gallery", "embed", "iframe", "break"]);
const isMedia = (b: PtBlock) => MEDIA.has(b._type) && b._type !== "break";

function listEnd(blocks: PtBlock[], i: number): number {
  for (;;) {
    while (i < blocks.length && blocks[i].listItem) i++;
    let j = i;
    while (j < blocks.length && !blocks[j].listItem && isMedia(blocks[j])) j++;
    if (j > i && j < blocks.length && blocks[j].listItem) i = j;
    else return i;
  }
}

// Flat PT list blocks -> nested lists. A block at a deeper level opens a
// sub-list inside the current item; listContinuation adds to the current item.
function buildLists(blocks: PtBlock[], ctx: Ctx): Node[] {
  const roots: Node[] = [];
  // stack[d] = the list open at depth d (0-based)
  const stack: { list: Extract<Node, { kind: "list" }>; level: number }[] = [];
  const currentItem = (): ListItem | undefined => {
    const top = stack[stack.length - 1];
    return top?.list.items[top.list.items.length - 1];
  };

  for (const b of blocks) {
    const level = Math.max(1, Number(b.level ?? stack[stack.length - 1]?.level ?? 1));
    const ordered = b.listItem === "number";
    while (stack.length && stack[stack.length - 1].level > level) stack.pop();

    // A screenshot or code block inside a list run is never a step of its own.
    if (b.listContinuation || (b._type !== "block" && (isMedia(b) || !b.listItem))) {
      const atLevel = b.listItem ? stack.find((s) => s.level === level) : stack[stack.length - 1];
      const item = atLevel ? atLevel.list.items[atLevel.list.items.length - 1] : undefined;
      const n = single(b, ctx);
      if (n && item) item.children.push(n);
      else if (n) roots.push(n);
      continue;
    }

    let top = stack[stack.length - 1];
    if (!top || top.level < level || top.list.ordered !== ordered) {
      if (top && top.level === level) stack.pop(); // list type changed at the same level: new list
      const list: Extract<Node, { kind: "list" }> = { kind: "list", ordered, items: [] };
      if (ordered && b.listStart && b.listStart !== 1) list.start = b.listStart;
      const parent = stack.length ? currentItem() : undefined;
      if (parent) parent.children.push(list);
      else roots.push(list);
      stack.push({ list, level });
      top = stack[stack.length - 1];
    }
    const first = b._type === "block" ? ({ kind: "html", html: inlineHtml(b) } as Node) : single(b, ctx);
    const item: ListItem = { children: first ? [first] : [] };
    if (typeof b.checked === "boolean") item.checked = b.checked;
    top.list.items.push(item);
  }
  return roots;
}

export function renderPlan(body: unknown) {
  const ctx: Ctx = { slugger: new GithubSlugger(), headings: [] };
  const nodes = Array.isArray(body) ? toNodes(body as PtBlock[], ctx) : [];
  return { nodes, headings: ctx.headings };
}
