"""Live smoke check for a University host: pages, images, search, admin gate, 404s.

Usage: python scripts/infra/smoke.py [host ...]   (default: both production hosts)
Exit 0 only when every check passes. Read-only: GET requests, no sign-in.
"""
import re
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urljoin, urlparse

HOSTS = ["university.etop.tech", "www.university.etop.tech"]
UA = "etop-university-smoke/1"
# Broken before the cutover, tracked elsewhere; reported but not counted as a failure.
KNOWN_BROKEN = [
    "media.licdn.com/dms/image/C5603AQHKEF1AFekEHA",  # issue #21, expired LinkedIn photo
    "/assets/outlook-view-tab.png",  # issue #22, screenshot never existed
]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def get(url, follow=True):
    opener = urllib.request.build_opener() if follow else urllib.request.build_opener(NoRedirect)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with opener.open(req, timeout=30) as r:
            return r.status, r.headers, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read()
    except Exception as e:  # TLS, DNS, timeout
        return 0, {}, str(e).encode()


def links(base, html):
    out = []
    for href in re.findall(r'href="(/[^"#?]*)"', html):
        if href.startswith(("/_", "/api/", "/assets/", "/favicon")) or "." in href.rsplit("/", 1)[-1]:
            continue
        out.append(urljoin(base, href))
    return list(dict.fromkeys(out))


def images(base, html):
    return list(dict.fromkeys(urljoin(base, s) for s in re.findall(r'<img[^>]+src="([^"]+)"', html)
                              if not s.startswith("data:")))


def check_host(host):
    base = f"https://{host}/"
    fails = []
    status, _, body = get(base)
    if status != 200:
        return [f"home {status} {body[:120]!r}"], {}
    html = body.decode("utf-8", "replace")
    pages = links(base, html)
    with ThreadPoolExecutor(8) as ex:
        page_res = list(ex.map(lambda u: (u, get(u)), pages))
    bad_pages = [(u, s) for u, (s, _, _) in page_res if s != 200]
    fails += [f"page {s} {u}" for u, s in bad_pages]

    # Images on every page, same-host and external alike.
    imgs = images(base, html)
    for u, (s, _, b) in page_res:
        if s == 200:
            imgs += images(u, b.decode("utf-8", "replace"))
    imgs = list(dict.fromkeys(imgs))
    with ThreadPoolExecutor(8) as ex:
        img_res = list(ex.map(lambda u: (u, get(u)[0]), imgs))
    bad_imgs = [(u, s) for u, s in img_res if s != 200]
    known = [(u, s) for u, s in bad_imgs if any(k in u for k in KNOWN_BROKEN)]
    fails += [f"image {s} {u}" for u, s in bad_imgs if (u, s) not in known]

    s, _, b = get(base + "api/search?q=vpn")
    n_hits = b.count(b'"url"')
    if s != 200 or n_hits == 0:
        fails.append(f"search {s} hits={n_hits}")

    s, h, _ = get(base + "_emdash/admin", follow=False)
    loc = (h.get("Location") or "") if h else ""
    if s != 302 or "cloudflareaccess.com" not in loc:
        fails.append(f"admin not behind Access: {s} {loc[:80]}")

    # Image-path Access bypass: an unknown media file must reach the Worker (404), not Access (302).
    s, _, _ = get(base + "_emdash/api/media/file/smoke-missing.png", follow=False)
    if s != 404:
        fails.append(f"media bypass: expected 404 from Worker, got {s}")

    stats = {"pages": len(pages), "pages_bad": len(bad_pages), "images": len(imgs),
             "images_bad": len(bad_imgs), "images_known_broken": len(known), "search_hits": n_hits}
    return fails, stats


def main():
    hosts = sys.argv[1:] or HOSTS
    ok = True
    for host in hosts:
        fails, stats = check_host(host)
        print(f"{host}: {'PASS' if not fails else 'FAIL'} {stats}")
        for f in fails:
            print("  -", f)
        ok = ok and not fails
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
