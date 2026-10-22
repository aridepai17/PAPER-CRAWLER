"""
fetch_paper.py - download an arXiv paper as HTML so the spider can crawl it.

    python fetch_paper.py                      # "Attention Is All You Need"
    python fetch_paper.py 2005.14165           # an arXiv ID
    python fetch_paper.py https://arxiv.org/abs/1810.04805
    python fetch_paper.py --batch "1706.03762 2005.14165 1810.04805"

HOW IT WORKS (the 30-second version, good for explaining on camera)
  1. METADATA  - the arXiv API (an Atom/XML feed) gives title, authors, date
                 and abstract. We parse it with xml.etree from the stdlib.
  2. PAPER HTML - arXiv renders LaTeX to HTML ("LaTeXML") in two places:
                    https://arxiv.org/html/<id>             (native, ~late 2023+)
                    https://ar5iv.labs.arxiv.org/html/<id>  (older papers)
                 We try the first, fall back to the second.
  3. ABSOLUTE URLS - the HTML uses relative links for figures (x1.png, or
                  "<id>v2/fig.svg" inside <object data=...>). Once the file lives
                  on localhost those would break, so we rewrite every
                  src/href/data/srcset to an absolute arXiv URL. arXiv and ar5iv
                  put their assets in different places, so we resolve each
                  reference against the base that actually matches it.
  4. SAVE      - papers/<id>.html + papers/<id>.json (metadata).
     We download first instead of fetching in the browser because arXiv does
     not send CORS headers, so a web page cannot read it directly.

Standard library only. Be polite: descriptive User-Agent, ~3s between requests.
"""

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PAPERS_DIR = ROOT / "papers"

# arXiv asks API users to identify themselves. Put your own contact here.
USER_AGENT = "PaperCrawler/1.0 (educational spider demo)"
POLITE_DELAY = 3.0  # seconds between requests, per arXiv's API etiquette
DEFAULT_ID = "1706.03762"  # Attention Is All You Need

ATOM = "{http://www.w3.org/2005/Atom}"

_last_request = 0.0  # time of the previous request, for rate limiting


# --------------------------------------------------------------------------- #
# small helpers
# --------------------------------------------------------------------------- #
def polite_get(url, timeout=60):
    """GET a URL (text), sleeping first so we never hit arXiv faster than ~1 req / 3 s.
    Returns (text, final_url). final_url matters: arXiv redirects /html/<id> to
    /html/<id>v7 and relative figure paths are relative to *that* address."""
    global _last_request
    if _last_request:
        wait = POLITE_DELAY - (time.time() - _last_request)
        if wait > 0:
            time.sleep(wait)
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            final_url = resp.geturl()
            charset = resp.headers.get_content_charset() or "utf-8"
    finally:
        _last_request = time.time()
    return raw.decode(charset, errors="replace"), final_url


NEW_ID = re.compile(r"(\d{4}\.\d{4,5})(?:v\d+)?")
OLD_ID = re.compile(r"([a-z\-]+(?:\.[A-Z]{2})?/\d{7})(?:v\d+)?")


def parse_arxiv_id(text):
    """Accept '1706.03762', '1706.03762v5', abs/pdf/html URLs, or old-style
    'hep-th/9901001'. Returns the id without a version (so we get the latest)."""
    text = text.strip()
    m = NEW_ID.search(text) or OLD_ID.search(text)
    if not m:
        raise ValueError(f"Could not find an arXiv ID in: {text!r}")
    return m.group(1)


def file_stem(arxiv_id):
    """Old-style ids contain a slash - flatten it so it is a valid filename."""
    return arxiv_id.replace("/", "_")


def clean(s):
    return re.sub(r"\s+", " ", s or "").strip()


# --------------------------------------------------------------------------- #
# 1) metadata from the arXiv API
# --------------------------------------------------------------------------- #
def fetch_metadata(arxiv_id):
    url = "https://export.arxiv.org/api/query?id_list=" + urllib.parse.quote(arxiv_id)
    xml_text, _ = polite_get(url)
    root = ET.fromstring(xml_text.encode("utf-8"))
    entry = root.find(ATOM + "entry")
    if entry is None or clean(entry.findtext(ATOM + "title")).lower() == "error":
        raise RuntimeError(f"arXiv API returned no paper for id {arxiv_id}")
    return {
        "id": arxiv_id,
        "title": clean(entry.findtext(ATOM + "title")),
        "authors": [
            clean(a.findtext(ATOM + "name")) for a in entry.findall(ATOM + "author")
        ],
        "published": clean(entry.findtext(ATOM + "published"))[:10],
        "abstract": clean(entry.findtext(ATOM + "summary")),
        "abs_url": f"https://arxiv.org/abs/{arxiv_id}",
    }


# --------------------------------------------------------------------------- #
# 2) the HTML itself
# --------------------------------------------------------------------------- #
def fetch_html(arxiv_id):
    """Try native arXiv HTML, then ar5iv. Returns (html, final_url, source) or None."""
    sources = [
        ("arxiv", f"https://arxiv.org/html/{arxiv_id}"),
        ("ar5iv", f"https://ar5iv.labs.arxiv.org/html/{arxiv_id}"),
    ]
    for name, url in sources:
        print(f"  trying {url} ...")
        try:
            html, final_url = polite_get(url)
        except urllib.error.HTTPError as e:
            print(f"    -> HTTP {e.code}")
            continue
        except urllib.error.URLError as e:
            print(f"    -> network error: {e.reason}")
            continue
        # Real LaTeXML output always carries 'ltx_' classes; anything else is an error page.
        if "ltx_" not in html:
            print("    -> response did not look like a LaTeXML paper")
            continue
        return html, final_url, name
    return None


# --------------------------------------------------------------------------- #
# 3) rewrite relative URLs -> absolute
# --------------------------------------------------------------------------- #
# `data` matters: LaTeXML puts figures in <object data="...">, not <img src>.
# ("data-src" is not in this list on purpose - it is matched by the "src" branch
# starting at the "src", which leaves the "data-" prefix untouched.)
ATTR_RE = re.compile(
    r"""(\b(?:src|href|data|poster)\s*=\s*)(["'])(.*?)\2""", re.I | re.S
)
SRCSET_RE = re.compile(r"""(\bsrcset\s*=\s*)(["'])(.*?)\2""", re.I | re.S)
SKIP_PREFIXES = ("#", "data:", "mailto:", "javascript:", "blob:", "tel:")


def base_urls(html, final_url, arxiv_id):
    """The two bases a relative URL in an arXiv paper can be relative to.

    arXiv and ar5iv disagree:
      * arxiv.org/html/<id>   references a figure as "<id>v2/fig.svg", i.e. it is
        relative to the DIRECTORY that holds the page, so the base is the page
        URL itself (no trailing slash - RFC drops the last segment -> /html/).
      * ar5iv.../html/<id>    references a figure as "fig.png", relative to the
        page's own directory, so the base needs the trailing slash.
    We keep both and pick per reference (see absolutize).
    """
    m = re.search(r"""<base\s+href=["']([^"']+)["']""", html, re.I)
    if m:  # an explicit <base> wins over every guess
        b = urllib.parse.urljoin(final_url, m.group(1))
        p = urllib.parse.urlparse(b)
        return b, urllib.parse.urlunparse(p._replace(path=p.path.rsplit("/", 1)[0] + "/"))
    p = urllib.parse.urlparse(final_url)
    stem = p.path.rsplit("/", 1)[-1]  # "1706.03762"
    dir_base = urllib.parse.urlunparse(p._replace(path=p.path.rstrip("/") + "/"))
    parent_base = urllib.parse.urlunparse(
        p._replace(path=p.path.rstrip("/").rsplit("/", 1)[0] + "/")
    )
    return dir_base, parent_base


def absolutize(html, final_url, arxiv_id):
    dir_base, parent_base = base_urls(html, final_url, arxiv_id)
    stem = urllib.parse.urlparse(final_url).path.rsplit("/", 1)[-1]
    origin = urllib.parse.urlunparse(
        urllib.parse.urlparse(final_url)._replace(path="", query="", fragment="")
    )

    def fix(u):
        u = u.strip()
        if not u or u.lower().startswith(SKIP_PREFIXES):
            return u
        # "<id>v2/fig.svg" -> relative to the directory that holds the page
        first = u.lstrip("/").split("/", 1)[0]
        if first.startswith(stem) or first.startswith(arxiv_id):
            return urllib.parse.urljoin(parent_base, u)
        return urllib.parse.urljoin(dir_base, u)

    html = ATTR_RE.sub(
        lambda m: f"{m.group(1)}{m.group(2)}{fix(m.group(3))}{m.group(2)}", html
    )

    def fix_srcset(m):
        parts = []
        for item in m.group(3).split(","):
            bits = item.strip().split()
            if bits:
                bits[0] = fix(bits[0])
                parts.append(" ".join(bits))
        return f"{m.group(1)}{m.group(2)}{', '.join(parts)}{m.group(2)}"

    return SRCSET_RE.sub(fix_srcset, html)


# --------------------------------------------------------------------------- #
# 4) put it all together
# --------------------------------------------------------------------------- #
def download(arxiv_id, force=False, log=None):
    """Download a paper (metadata + HTML) into papers/.

    Returns a result dict: {ok, id, arxivId, title, authors, published, source,
    cached, error}.  `log(message, kind)` reports progress; kind is "info" or
    "error".  The default logger prints to stdout/stderr (what the CLI wants);
    serve.py passes its own logger so the browser can watch the download.
    """
    if log is None:

        def log(message, kind="info"):
            if kind == "error":
                print(message, file=sys.stderr)
            else:
                print(message)

    stem = file_stem(arxiv_id)
    html_path = PAPERS_DIR / f"{stem}.html"
    json_path = PAPERS_DIR / f"{stem}.json"

    def result(**kw):
        base = {
            "ok": False,
            "id": stem,
            "arxivId": arxiv_id,
            "title": "",
            "authors": [],
            "published": "",
            "source": None,
            "cached": False,
            "error": None,
        }
        base.update(kw)
        return base

    if html_path.exists() and json_path.exists() and not force:
        log(f"[{arxiv_id}] already downloaded (use --force to refresh)")
        meta = {}
        try:
            meta = json.loads(json_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            pass
        return result(
            ok=True,
            cached=True,
            title=meta.get("title", ""),
            authors=meta.get("authors", []),
            published=meta.get("published", ""),
            source=meta.get("html_source"),
        )

    log(f"[{arxiv_id}] fetching metadata ...")
    try:
        meta = fetch_metadata(arxiv_id)
    except Exception as e:  # noqa: BLE001 - we want a friendly message for any failure
        msg = f"could not get metadata: {e}"
        log(f"  ERROR: {msg}", "error")
        return result(error=msg)

    log(f"  {meta['title']}")
    fetched = fetch_html(arxiv_id)
    if fetched is None:
        msg = (
            f"{arxiv_id} has no HTML version on arxiv.org/html or ar5iv.\n"
            "Paper Crawler needs HTML (it cannot read PDFs). Try another paper."
        )
        log(f"  ERROR: {msg}", "error")
        return result(error=msg, title=meta.get("title", ""))

    html, final_url, source = fetched
    html = absolutize(html, final_url, arxiv_id)

    PAPERS_DIR.mkdir(exist_ok=True)
    html_path.write_text(html, encoding="utf-8")
    meta.update(
        {
            "html_source": source,
            "source_url": final_url,
            "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
    )
    json_path.write_text(
        json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    log(f"  saved papers/{stem}.html  ({len(html) // 1024} KB, via {source})")
    return result(
        ok=True,
        title=meta.get("title", ""),
        authors=meta.get("authors", []),
        published=meta.get("published", ""),
        source=source,
    )


def main():
    ap = argparse.ArgumentParser(
        description="Download arXiv papers as HTML for Paper Crawler."
    )
    ap.add_argument(
        "paper", nargs="*", help="arXiv ID(s) or URL(s). Default: %s" % DEFAULT_ID
    )
    ap.add_argument(
        "--batch", help='space-separated list, e.g. "1706.03762 2005.14165"'
    )
    ap.add_argument(
        "--force", action="store_true", help="re-download even if already saved"
    )
    args = ap.parse_args()

    raw = list(args.paper)
    if args.batch:
        raw += args.batch.split()
    if not raw:
        raw = [DEFAULT_ID]

    try:
        ids = [parse_arxiv_id(r) for r in raw]
    except ValueError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 2

    results = [download(i, force=args.force) for i in ids]
    done = sum(1 for r in results if r["ok"])
    print(
        f"\nDone: {done}/{len(results)} downloaded. Next: python serve.py  ->  http://localhost:5173"
    )
    return 0 if done == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
