"""Cross-check that every sidebar link maps to a real markdown file."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "src" / "content" / "docs"
SIDEBAR = ROOT / "src" / "_generated" / "sidebar.json"


def collect_links(items, out):
    for it in items:
        if "link" in it:
            out.append(it["link"])
        if "items" in it:
            collect_links(it["items"], out)


def slug_to_paths(slug: str) -> list[Path]:
    p = slug.lstrip("/")
    if p == "":
        return [DOCS / "index.md"]
    return [DOCS / f"{p}.md", DOCS / p / "index.md"]


def main() -> None:
    sidebar = json.loads(SIDEBAR.read_text(encoding="utf-8"))
    links: list[str] = []
    collect_links(sidebar, links)
    missing = []
    for link in links:
        if not any(p.exists() for p in slug_to_paths(link)):
            missing.append(link)
    print(f"sidebar links: {len(links)}")
    print(f"missing files: {len(missing)}")
    for m in missing:
        print(f"  MISSING -> {m}")


if __name__ == "__main__":
    main()
