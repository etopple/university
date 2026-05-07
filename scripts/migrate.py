"""One-shot GitBook → Starlight migration.

Run from repo root:
    python scripts/migrate.py

What it does:
1. Moves all content folders into src/content/docs/.
2. Renames every README.md to index.md (Starlight idiom).
3. Moves .gitbook/assets/ to public/.gitbook/assets/ so legacy URLs keep working.
4. Rewrites image paths from relative ../.gitbook/assets/x to absolute /.gitbook/assets/x.
5. Converts GitBook custom blocks to Starlight equivalents:
       {% hint style="info"|"warning"|"danger"|"success" %} ... {% endhint %}
       {% embed url="..." %}
       {% content-ref url="..." %} ... {% endcontent-ref %}
6. Strips cover/coverY frontmatter (Starlight ignores them).
7. Writes the Starlight sidebar config to src/_generated/sidebar.json from SUMMARY.md.

Idempotent on re-run for the YAML/syntax pass; the file move is one-way.
"""
from __future__ import annotations
import json
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCS_DST = ROOT / "src" / "content" / "docs"
ASSETS_SRC = ROOT / ".gitbook" / "assets"
ASSETS_DST = ROOT / "public" / ".gitbook" / "assets"
SUMMARY = ROOT / "SUMMARY.md"
SIDEBAR_OUT = ROOT / "src" / "_generated" / "sidebar.json"

CONTENT_ROOTS = ["about-us", "team", "education", "media-education",
                 "security-insights", "policies"]

HINT_STYLE_TO_ASIDE = {
    "info": "note",
    "success": "tip",
    "warning": "caution",
    "danger": "danger",
}


def move_content() -> None:
    DOCS_DST.mkdir(parents=True, exist_ok=True)
    readme = ROOT / "README.md"
    if readme.exists() and not (DOCS_DST / "index.md").exists():
        shutil.move(str(readme), str(DOCS_DST / "index.md"))
    for folder in CONTENT_ROOTS:
        src = ROOT / folder
        if not src.exists():
            continue
        dst = DOCS_DST / folder
        if dst.exists():
            print(f"  skip move (already migrated): {folder}")
            continue
        shutil.move(str(src), str(dst))
        print(f"  moved: {folder} -> src/content/docs/{folder}")


def rename_readmes_to_index() -> None:
    for readme in DOCS_DST.rglob("README.md"):
        target = readme.with_name("index.md")
        if target.exists():
            print(f"  conflict, skipping: {readme}")
            continue
        readme.rename(target)


def move_assets() -> None:
    if ASSETS_SRC.exists():
        ASSETS_DST.parent.mkdir(parents=True, exist_ok=True)
        if ASSETS_DST.exists():
            for f in ASSETS_SRC.iterdir():
                shutil.move(str(f), str(ASSETS_DST / f.name))
            ASSETS_SRC.rmdir()
        else:
            shutil.move(str(ASSETS_SRC), str(ASSETS_DST))
        print(f"  moved assets -> public/.gitbook/assets/")
    gb_root = ROOT / ".gitbook"
    if gb_root.exists() and not any(gb_root.iterdir()):
        gb_root.rmdir()


HINT_RE = re.compile(
    r'\{%\s*hint\s+style="(?P<style>\w+)"\s*%\}\s*\n?(?P<body>.*?)\n?\{%\s*endhint\s*%\}',
    re.DOTALL,
)
EMBED_RE = re.compile(r'\{%\s*embed\s+url="(?P<url>[^"]+)"\s*%\}')
CONTENTREF_RE = re.compile(
    r'\{%\s*content-ref\s+url="(?P<url>[^"]+)"\s*%\}\s*(?P<inner>.*?)\{%\s*endcontent-ref\s*%\}',
    re.DOTALL,
)
GB_ASSET_RE = re.compile(r'(\.\./)+\.gitbook/assets/')

FRONTMATTER_RE = re.compile(r'^---\s*\n(.*?)\n---\s*\n', re.DOTALL)
COVER_KEY_RE = re.compile(r'^(cover|coverY|icon|layout):.*?(?=^\S|\Z)', re.MULTILINE | re.DOTALL)


def convert_hint(m: re.Match) -> str:
    style = m.group("style").lower()
    aside = HINT_STYLE_TO_ASIDE.get(style, "note")
    body = m.group("body").strip()
    return f":::{aside}\n{body}\n:::"


def convert_embed(m: re.Match) -> str:
    url = m.group("url")
    return f"[{url}]({url})"


def convert_contentref(m: re.Match) -> str:
    url = m.group("url")
    label = url.replace("README.md", "").rstrip("/").split("/")[-1] or url
    label = label.replace("-", " ").replace(".md", "").strip().title() or url
    return f"- [{label}]({url})"


DROP_KEYS = ("cover", "coverY", "icon", "layout")
DROP_KEY_RE = re.compile(r'^(' + '|'.join(DROP_KEYS) + r')\s*:')


def clean_frontmatter(text: str) -> str:
    m = FRONTMATTER_RE.match(text)
    if not m:
        return text
    fm = m.group(1)
    out_lines: list[str] = []
    lines = fm.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        if DROP_KEY_RE.match(line):
            i += 1
            while i < len(lines) and (lines[i].startswith(" ") or lines[i].startswith("\t")):
                i += 1
            continue
        out_lines.append(line)
        i += 1
    cleaned = "\n".join(l for l in out_lines if l.strip())
    if not cleaned.strip():
        return text[m.end():]
    return f"---\n{cleaned}\n---\n" + text[m.end():]


H1_RE = re.compile(r'^#\s+(?P<title>.+?)\s*$', re.MULTILINE)


def yaml_string(s: str) -> str:
    """Quote a YAML string safely. Uses double quotes; escapes embedded ones."""
    return '"' + s.replace('\\', '\\\\').replace('"', '\\"') + '"'


def get_existing_title(text: str) -> str | None:
    m = FRONTMATTER_RE.match(text)
    if not m:
        return None
    for line in m.group(1).splitlines():
        mt = re.match(r'^title\s*:\s*(.+?)\s*$', line)
        if mt:
            return mt.group(1).strip().strip('"').strip("'")
    return None


def ensure_title_frontmatter(text: str, fallback: str) -> str:
    """Pull the first H1 into a frontmatter `title:` field. Strip the H1 from body.
    If no H1 exists, use the supplied fallback."""
    if get_existing_title(text):
        return text

    body_start = 0
    fm = ""
    m = FRONTMATTER_RE.match(text)
    if m:
        fm = m.group(1).rstrip()
        body_start = m.end()

    body = text[body_start:]
    h1 = H1_RE.search(body)
    if h1:
        title = h1.group("title").strip()
        body = body[: h1.start()] + body[h1.end():]
        body = body.lstrip("\n")
    else:
        title = fallback

    title_line = f"title: {yaml_string(title)}"
    fm_lines = [title_line] + ([fm] if fm else [])
    fm_block = "\n".join(fm_lines).strip()
    return f"---\n{fm_block}\n---\n{body}"


def fallback_title_from_path(p: Path) -> str:
    rel = p.relative_to(DOCS_DST).with_suffix("")
    parts = list(rel.parts)
    if parts and parts[-1] == "index":
        parts = parts[:-1] or ["Home"]
    last = parts[-1].replace("-", " ").replace("_", " ")
    return last.title()


def convert_file(p: Path) -> None:
    text = p.read_text(encoding="utf-8")
    original = text
    text = clean_frontmatter(text)
    text = HINT_RE.sub(convert_hint, text)
    text = EMBED_RE.sub(convert_embed, text)
    text = CONTENTREF_RE.sub(convert_contentref, text)
    text = GB_ASSET_RE.sub('/.gitbook/assets/', text)
    text = ensure_title_frontmatter(text, fallback_title_from_path(p))
    if text != original:
        p.write_text(text, encoding="utf-8", newline="\n")


def convert_all() -> None:
    n = 0
    for md in DOCS_DST.rglob("*.md"):
        convert_file(md)
        n += 1
    print(f"  processed {n} markdown files")


def slug_from_md_path(rel_md: str) -> str:
    """Convert a SUMMARY.md path like 'about-us/values.md' to a Starlight URL slug."""
    p = rel_md.removesuffix(".md")
    if p.endswith("/README"):
        p = p[: -len("/README")]
    elif p == "README":
        p = ""
    return "/" + p.lstrip("/")


SUMMARY_LINK = re.compile(r'^( *)\* \[(?P<label>.+?)\]\((?P<href>[^)]+)\)\s*$')
SUMMARY_HEADER = re.compile(r'^##\s+(?P<title>.+?)\s*$')


def parse_summary() -> list[dict]:
    """Parse SUMMARY.md into a Starlight sidebar tree.

    Output is a list of items: either {label, link} (leaf) or
    {label, items: [...]} (group). Top-level `## Heading` lines become
    sibling group separators.
    """
    if not SUMMARY.exists():
        return []
    lines = SUMMARY.read_text(encoding="utf-8").splitlines()

    sidebar: list[dict] = []
    current_group: dict | None = None
    stack: list[tuple[int, list[dict]]] = []

    def container() -> list[dict]:
        if stack:
            return stack[-1][1]
        if current_group is not None:
            return current_group["items"]
        return sidebar

    for raw in lines:
        line = raw.rstrip()
        if not line.strip():
            continue
        if line.strip() == "***":
            current_group = None
            stack.clear()
            continue
        h = SUMMARY_HEADER.match(line)
        if h:
            current_group = {"label": h.group("title").strip(), "items": []}
            sidebar.append(current_group)
            stack.clear()
            continue
        m = SUMMARY_LINK.match(line)
        if not m:
            continue
        indent = len(m.group(1))
        depth = indent // 2
        label = m.group("label").strip()
        href = m.group("href").strip()
        slug = slug_from_md_path(href)
        item = {"label": label, "link": slug}

        while stack and stack[-1][0] >= depth:
            stack.pop()
        container().append(item)
        if href.endswith("/README.md") or href == "README.md":
            item["items"] = []
            stack.append((depth, item["items"]))
    return sidebar


def collapse_link_only_groups(items: list[dict]) -> list[dict]:
    """Where a group has both a 'link' and 'items', Starlight needs a group
    with the link as its first child or the index page becomes inaccessible.
    Convert {label, link, items} into a group whose first child is the index.
    If the group has no real children, keep it as a flat leaf."""
    out = []
    for it in items:
        if "items" in it and "link" in it:
            children = collapse_link_only_groups(it["items"])
            if not children:
                out.append({"label": it["label"], "link": it["link"]})
                continue
            children.insert(0, {"label": "Overview", "link": it["link"]})
            out.append({"label": it["label"], "items": children})
        elif "items" in it:
            out.append({"label": it["label"], "items": collapse_link_only_groups(it["items"])})
        else:
            out.append(it)
    return out


def write_sidebar() -> None:
    tree = parse_summary()
    tree = collapse_link_only_groups(tree)
    SIDEBAR_OUT.parent.mkdir(parents=True, exist_ok=True)
    SIDEBAR_OUT.write_text(json.dumps(tree, indent=2), encoding="utf-8")
    print(f"  wrote sidebar -> {SIDEBAR_OUT.relative_to(ROOT)}")


def main() -> None:
    print("Step 1: move content folders")
    move_content()
    print("Step 2: rename README.md -> index.md")
    rename_readmes_to_index()
    print("Step 3: move .gitbook/assets -> public/.gitbook/assets")
    move_assets()
    print("Step 4: convert GitBook syntax + frontmatter")
    convert_all()
    print("Step 5: build sidebar from SUMMARY.md")
    write_sidebar()
    print("Done.")


if __name__ == "__main__":
    main()
