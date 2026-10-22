"""
serve.py - Paper Crawler's tiny backend.  Run:  python serve.py   ->  http://localhost:5173

It does three jobs, using only the Python standard library:

  1. Serves the static front-end (index.html, css/, js/, papers/).
     Everything else (this file, .env, cache/) is deliberately NOT served.
  2. GET  /api/papers   -> list of downloaded papers (reads papers/*.json)
     GET  /api/status   -> {"hasKey": bool, "model": "...", "quotaReset": 0}
  3. POST /api/explain  -> asks Gemini to explain a section and STREAMS the
     answer back to the browser as Server-Sent Events (SSE), so it types out live.
  4. POST /api/fetch    -> downloads a paper from arXiv (the library drawer) and
     streams the progress back as SSE.

WHY A PROXY?  The Gemini API key must never reach the browser. The browser
talks to this server; this server talks to generativelanguage.googleapis.com
with the key.

CACHING: each answer is saved to cache/{paperId}_{sectionSlug}.json, so running
the same paper again is instant and costs nothing.

SSE messages sent to the browser (each is one line:  data: {json}\\n\\n):
    {"type":"text",  "text":"...chunk..."}
    {"type":"reset"}                 a model died mid-answer: drop what we got
    {"type":"done",  "cached":true|false, "model":"..."}
    {"type":"error", "code":"no_key|api|no_model|quota", "message":"...",
     "resetAt": 1234567890}

MODELS: which model we can actually call depends on the key's quota, and that
changes under us.  Google's free tier gives every model *family* its own
daily allowance (and several model ids are just aliases of one family), so a
single hard-coded model id is a liability.  Instead we keep a chain of
candidates, best first, and fall through automatically.  Google's own error
messages tell us what happened, so we park the right thing for the right time:

    429 out of quota  -> the body names the bucket, the daily limit and when
                         the window reopens ("Please retry in 12h14m32s"), so we
                         park that whole family until then
    limit 0           -> no allowance at all: park it for a day (a plan change
                         is the only way to get one)
    503 high demand   -> temporary, skip it for a few minutes
    404 retired model -> park it for a day
    400 bad params    -> this model dislikes thinkingConfig: retry it without,
                         and if it still complains, skip it for a while

The first model that answers is remembered and used directly from then on, so
the fallback probing costs one request per cooldown, not one per explanation.
Override the chain with  GEMINI_MODELS="gemini-3-flash-preview,gemini-3.1-flash-lite".
"""

import hashlib
import json
import mimetypes
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

# --------------------------------------------------------------------------- #
# Settings - edit these
# --------------------------------------------------------------------------- #
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "5173"))
API_ROOT = "https://generativelanguage.googleapis.com/v1beta"

# Model chain, best first. The first entry that answers wins.
# The chain deliberately spans several *quota buckets*: on a free-tier key each
# model family gets its own daily allowance (Google's 429 tells us the limit
# and the reset time), and several models are just aliases of the same bucket
# (3.5-flash spends 3.6-flash's 20/day; flash-latest spends 3.8-flash's).
# The server learns which bucket a model belongs to from its own error
# messages, and parks a whole family at once.
DEFAULT_MODEL_CHAIN = [
    "gemini-3.1-pro-preview",  # best quality (paid keys; free tier: limit 0)
    "gemini-3-flash-preview",  # full Flash, its own bucket, generous daily limit
    "gemini-3.1-flash-lite",  # separate bucket
    "gemini-3.5-flash-lite",  # separate bucket
    "gemini-flash-lite-latest",  # same family as the line above
    "gemini-3.8-flash",  # 20/day on the free tier
    "gemini-3.6-flash",  # 20/day on the free tier
]
# How long a model stays skipped after a transient failure (seconds).
DEMAND_COOLDOWN = 180.0
# Out-of-quota is treated as long-lived, but Google tells us exactly when the
# window reopens ("Please retry in 12h14m32s") - we use that number.
QUOTA_COOLDOWN = 600.0
# A model whose allowance is literally 0 will not get one without a plan
# change, so it is parked for a whole day instead of a few hours.
ZERO_LIMIT_COOLDOWN = 86400.0

MAX_OUTPUT_TOKENS = 512  # <70 words + a KEY line; thinking is off, so this is plenty
MAX_TEXT_CHARS = 12000  # section text is trimmed to this before sending
REQUEST_TIMEOUT = 45  # seconds to wait for Gemini before giving up on a model
TOTAL_DEADLINE = 60  # seconds for one /api/explain request, across all models

# Reading level -> how the model is told to address the reader.
LEVELS = {
    "beginner": "CS freshman",
    "student": "CS student who knows basic ML",
    "researcher": "ML researcher; be precise and technical",
}

# THE PROMPTS - easy to edit. {section}, {title}, {level} are filled in below.
PROMPT_SECTION = (
    "You are explaining the '{section}' section of the ML paper '{title}' to a {level}. "
    "In under 70 words: what this section says, why it matters, and any key number or result. "
    "Use plain English and one simple analogy if it helps. Define any jargon you use. "
    "Never use LaTeX or raw symbols: write any math out in words "
    "(for example 'one over the square root of d-k' instead of '1/sqrt(d_k)'). "
    "Then output one line starting with 'KEY:' containing the single most important exact "
    "phrase or number from the section text (copied exactly as written, character for "
    "character, and nothing else on that line)."
)
PROMPT_SELECTION = (
    "You are explaining a passage the reader selected from the '{section}' section of the ML paper "
    "'{title}' to a {level}. In under 70 words: say what the passage (or equation) means in plain "
    "English and why it matters. Use plain English and one simple analogy if it helps. Define any "
    "jargon you use. Never use LaTeX or raw symbols: write any math out in words. "
    "Do NOT output a KEY line."
)
# Bump this whenever the prompts above change: the on-disk cache stores it, and a
# mismatch invalidates every cached answer (so old answers never survive an edit).
PROMPT_VERSION = 1

ROOT = Path(__file__).resolve().parent
CACHE_DIR = ROOT / "cache"
PAPERS_DIR = ROOT / "papers"
# Only these places are served statically. Keeps .env / serve.py / cache/ private.
# NOTE: the check is done on the RESOLVED path (see serve_static), otherwise
# "/papers/../.env" would slip through a prefix check and hand out the API key.
STATIC_ALLOW_FILES = ("index.html", "favicon.ico")
STATIC_ALLOW_DIRS = ("css", "js", "papers")
# The papers we mount are third-party HTML. The CSP below means a paper can
# still show its figures (images from arXiv) but cannot run any script of its
# own, and the page cannot be framed (clickjacking).
CSP = (
    "default-src 'self'; "
    "script-src 'self'; "
    "style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: https:; "
    "object-src 'self' data: https:; "
    "font-src 'self' data:; "
    "connect-src 'self'; "
    "frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
)

# --------------------------------------------------------------------------- #
# API key handling: env var first, then .env (KEY=value lines)
# --------------------------------------------------------------------------- #
KEY_NAMES = ("GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_API_KEY")


def get_api_key():
    for name in KEY_NAMES:
        key = os.environ.get(name, "").strip()
        if key:
            return key
    env_file = ROOT / ".env"
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            if k.strip() in KEY_NAMES:
                val = v.strip().strip("'\"")
                if val:
                    return val
    return ""


def safe_slug(s, default="x"):
    s = re.sub(r"[^a-zA-Z0-9._-]+", "-", str(s)).strip("-.")[:80]
    return s or default


def parse_duration(text):
    """'12h14m32s' -> seconds.  Google's quota errors use this format."""
    if not text:
        return None
    total = 0.0
    for num, unit in re.findall(r"(\d+(?:\.\d+)?)\s*([hms])", text):
        total += float(num) * {"h": 3600.0, "m": 60.0, "s": 1.0}[unit]
    return total or None


def parse_quota(detail):
    """Pull the facts out of a 429 body.

    Google's message looks like:
      Quota exceeded for metric: .../generate_content_free_tier_requests,
      limit: 20, model: gemini-3.6-flash
      Please retry in 12h14m32.281387687s.

    -> (bucket, limit, seconds_until_reset)
    """
    bucket = re.search(r"\bmodel:\s*(\S+)", detail)
    limit = re.search(r"\blimit:\s*(\d+)", detail)
    wait = re.search(r"retry in\s*([0-9hms.]+)", detail)
    return (
        bucket.group(1) if bucket else None,
        int(limit.group(1)) if limit else None,
        parse_duration(wait.group(1)) if wait else None,
    )


# --------------------------------------------------------------------------- #
# Model pool: try the chain, remember what works, back off from what doesn't
# --------------------------------------------------------------------------- #
class ModelPool:
    """Picks the best Gemini model this key can actually use right now.

    Gemini answers with a quota/demand error far more often than you'd expect:
    a free-tier key has a zero allowance for the Pro tier, and the newest
    model aliases get 503 "high demand" spikes.  So instead of hard-coding
    one model we keep a chain and fall through, remembering the winner.

    Policy:
      429 out of quota -> skip it for a while and DEMOTE it (the working model
                         gets tried first next time), so a permanently
                         unavailable model costs one request per cooldown.
      503 high demand  -> short skip, keep its place in the chain.
      404 retired      -> park it for a day.
    """

    def __init__(self, chain=None):
        raw = os.environ.get("GEMINI_MODELS", "")
        if raw:
            chain = [m.strip() for m in raw.split(",") if m.strip()]
        self.order = list(chain or DEFAULT_MODEL_CHAIN)
        self.dead = {}  # model -> unix time it may be retried
        self.bucket = {}  # model -> the quota bucket it draws from
        self.active = None  # last model that answered

    def candidates(self):
        now = time.time()
        live = [m for m in self.order if self.dead.get(m, 0) <= now]
        if self.active and self.active in live:
            live.remove(self.active)
            live.insert(0, self.active)  # try the proven winner first
        return live

    def fail(self, model, code, wait=None, bucket=None, limit=None):
        """Park a model (and its family) after a failure.

        Models that are aliases of the same quota bucket (3.5-flash and
        flash-latest both spend 3.8-flash's 20 requests/day) must be parked
        together, otherwise the chain keeps probing a dead bucket.
        """
        if bucket:
            self.bucket[model] = bucket
        if code == 429:
            if limit == 0:
                wait = ZERO_LIMIT_COOLDOWN  # no allowance at all: a plan change only
            self.dead[model] = time.time() + (wait or QUOTA_COOLDOWN)
        elif code == 503:
            self.dead[model] = time.time() + DEMAND_COOLDOWN
        elif code == 404:
            self.dead[model] = time.time() + 86400  # retired
        elif code == 400:
            self.dead[model] = time.time() + 21600  # bad params: don't retry soon
        if bucket:  # park every alias of that bucket too
            for other in self.order:
                if other == bucket or self.bucket.get(other) == bucket:
                    self.dead[other] = max(
                        self.dead.get(other, 0), self.dead.get(model, 0)
                    )
        if model in self.order:  # demote: the working model goes first now
            self.order.remove(model)
            self.order.append(model)
        if self.active == model:
            self.active = None

    def ok(self, model):
        self.active = model
        self.dead.pop(model, None)
        if model in self.order:
            self.order.remove(model)
            self.order.insert(0, model)

    def name(self):
        """What to show in the UI: the model the next request will really use."""
        if self.active:
            return self.active
        live = self.candidates()
        return live[0] if live else (self.order[0] if self.order else "?")

    def next_reset(self):
        """When does the first parked model come back? (unix time, or 0)"""
        times = [self.dead[m] for m in self.order if m in self.dead]
        return min(times) if times else 0


def humanize(seconds):
    """45000 -> '12h 30m'."""
    seconds = int(max(0, seconds))
    if seconds < 60:
        return f"{seconds}s"
    if seconds < 3600:
        return f"{seconds // 60}m {seconds % 60}s"
    return f"{seconds // 3600}h {(seconds % 3600) // 60}m"


POOL = ModelPool()

# Only one arXiv download at a time (arXiv is rate limited, and two downloads
# would race for the same files).
FETCH_LOCK = threading.Lock()


# --------------------------------------------------------------------------- #
# cache: one JSON file per paper+section, holding one answer per reading level
# --------------------------------------------------------------------------- #
def cache_path(paper_id, slug):
    return CACHE_DIR / f"{safe_slug(paper_id)}_{safe_slug(slug)}.json"


def cache_read(path, level):
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        # A prompt edit invalidates every stored answer (PROMPT_VERSION).
        if data.get("promptVersion") != PROMPT_VERSION:
            return None
        return data.get("levels", {}).get(level, {}).get("text")
    except (OSError, ValueError):
        return None


def cache_write(path, level, text, meta):
    CACHE_DIR.mkdir(exist_ok=True)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    data.update(meta)
    data["promptVersion"] = PROMPT_VERSION
    data.setdefault("levels", {})[level] = {
        "text": text,
        "model": meta.get("model", POOL.name()),
        "ts": int(time.time()),
    }
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


# --------------------------------------------------------------------------- #
# HTTP handler
# --------------------------------------------------------------------------- #
class Handler(BaseHTTPRequestHandler):
    server_version = "PaperCrawler/1.0"

    def log_message(self, fmt, *args):  # keep the console quiet; errors still print
        if args and str(args[1]).startswith(("4", "5")):
            sys.stderr.write("[serve] " + fmt % args + "\n")

    # ---- small response helpers ----
    def send_json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def sse_start(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header(
            "Connection", "close"
        )  # HTTP/1.0 style: body ends when we close
        self.end_headers()
        self.close_connection = True

    def sse(self, obj):
        self.wfile.write(
            b"data: " + json.dumps(obj, ensure_ascii=False).encode("utf-8") + b"\n\n"
        )
        self.wfile.flush()

    # ---- routing ----
    def do_GET(self):
        path = unquote(urlparse(self.path).path)
        if path == "/api/papers":
            return self.send_json(self.list_papers())
        if path == "/api/status":
            reset = POOL.next_reset()
            return self.send_json(
                {
                    "hasKey": bool(get_api_key()),
                    "model": POOL.name(),
                    "quotaReset": int(reset) if reset else 0,
                }
            )
        return self.serve_static(path)

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/explain":
            try:
                return self.handle_explain()
            except (BrokenPipeError, ConnectionResetError):
                return  # browser navigated away / aborted the request
        if path == "/api/fetch":
            try:
                return self.handle_fetch()
            except (BrokenPipeError, ConnectionResetError):
                return
        self.send_error(404)

    # ---- /api/papers ----
    def list_papers(self):
        out = []
        for j in sorted(PAPERS_DIR.glob("*.json")):
            if not j.with_suffix(".html").exists():
                continue
            try:
                meta = json.loads(j.read_text(encoding="utf-8"))
            except ValueError:
                meta = {}
            meta.setdefault("id", j.stem)
            meta.setdefault("title", j.stem)
            meta.pop("abstract", None)  # keep the list small
            out.append(meta)
        return out

    # ---- static files ----
    def serve_static(self, path):
        rel = "index.html" if path in ("", "/") else path.lstrip("/")
        try:
            target = (ROOT / rel).resolve()
        except OSError:
            return self.send_error(404)
        if not target.is_file():
            return self.send_error(404)
        # The allowlist is checked on the RESOLVED path, so "../" tricks that
        # survive a naive prefix check can't reach .env / cache/ / serve.py.
        if target.parent == ROOT:
            allowed = target.name in STATIC_ALLOW_FILES
        else:
            allowed = target.parent in [(ROOT / d) for d in STATIC_ALLOW_DIRS]
        if not allowed:
            return self.send_error(404)
        ctype = {
            ".js": "text/javascript",
            ".css": "text/css",
            ".html": "text/html",
        }.get(
            target.suffix,
            mimetypes.guess_type(str(target))[0] or "application/octet-stream",
        )
        data = target.read_bytes()
        self.send_response(200)
        self.send_header(
            "Content-Type",
            ctype + ("; charset=utf-8" if ctype.startswith("text") else ""),
        )
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")  # always fresh while you hack on it
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", CSP)
        self.end_headers()
        self.wfile.write(data)

    # ---- /api/explain ----
    def handle_explain(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > 200_000:
            return self.send_json({"error": "bad request size"}, 400)
        try:
            req = json.loads(self.rfile.read(length))
        except ValueError:
            return self.send_json({"error": "invalid JSON"}, 400)

        paper_id = safe_slug(req.get("paperId", "paper"))
        title = str(req.get("title") or "this paper")[:200]
        section = str(req.get("section") or "Section")[:200]
        text = str(req.get("text") or "")[:MAX_TEXT_CHARS]
        level = req.get("level") if req.get("level") in LEVELS else "student"
        mode = "selection" if req.get("mode") == "selection" else "section"
        if not text.strip():
            return self.send_json({"error": "empty text"}, 400)

        # Cache key. Selections are keyed by a hash of the selected text.
        slug = (
            "sel-" + hashlib.sha1(text.encode("utf-8")).hexdigest()[:12]
            if mode == "selection"
            else req.get("sectionSlug") or section
        )
        cpath = cache_path(paper_id, slug)

        self.sse_start()

        # 1) cache hit: replay it in small chunks so it still "types out"
        cached = cache_read(cpath, level)
        if cached:
            for i in range(0, len(cached), 6):
                self.sse({"type": "text", "text": cached[i : i + 6]})
                time.sleep(0.006)
            return self.sse({"type": "done", "cached": True})

        # 2) need the API
        key = get_api_key()
        if not key:
            return self.sse(
                {
                    "type": "error",
                    "code": "no_key",
                    "message": "No GEMINI_API_KEY found. Put it in a .env file next to serve.py and restart.",
                }
            )

        template = PROMPT_SELECTION if mode == "selection" else PROMPT_SECTION
        prompt = template.format(section=section, title=title, level=LEVELS[level])
        prompt += "\n\n--- TEXT ---\n" + text

        # 3) ask Gemini, falling through the model chain on quota/demand errors
        last_error = ""
        deadline = time.time() + TOTAL_DEADLINE
        for model in POOL.candidates():
            if time.time() > deadline:
                last_error = "out of time"
                break
            ok, chunks, err = self.stream_gemini(model, key, prompt)
            if ok:
                answer = "".join(chunks).strip()
                if answer:
                    cache_write(
                        cpath,
                        level,
                        answer,
                        {
                            "paperId": paper_id,
                            "section": section,
                            "slug": str(slug),
                            "model": model,
                        },
                    )
                return self.sse({"type": "done", "cached": False, "model": model})
            # The model died. If it already sent us some text, tell the browser
            # to throw that partial answer away before the next model starts.
            if chunks:
                self.sse({"type": "reset"})
            if err and err[0] == "fatal":
                return self.sse(
                    {"type": "error", "code": err[1], "message": err[2]}
                )
            # else: this model is unavailable right now -> try the next one
            if err and len(err) > 2:
                last_error = str(err[2])
            if not POOL.candidates():
                break

        reset = POOL.next_reset()
        if reset and reset - time.time() > 60:
            # every model is parked and we know when the window reopens
            return self.sse(
                {
                    "type": "error",
                    "code": "quota",
                    "message": "Gemini's free tier is used up "
                    f"({humanize(reset - time.time())} to go). "
                    "The spider keeps working; the explanations will fill in "
                    "when the quota reopens.",
                    "resetAt": int(reset),
                }
            )
        return self.sse(
            {
                "type": "error",
                "code": "no_model",
                "message": "No Gemini model is available for this key right now "
                "(out of quota or high demand). Try again in a minute, or set "
                "GEMINI_MODELS in .env to a model your key can use."
                + (f" Last error: {last_error[:220]}" if last_error else ""),
            }
        )

    # ---- /api/fetch: download a paper from arXiv, streaming progress ----
    def handle_fetch(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > 20_000:
            return self.send_json({"error": "bad request size"}, 400)
        try:
            req = json.loads(self.rfile.read(length))
        except ValueError:
            return self.send_json({"error": "invalid JSON"}, 400)

        raw = str(req.get("id") or "").strip()
        if not raw:
            return self.send_json({"error": "missing id"}, 400)

        # Imported lazily: a broken fetch_paper.py must not stop the app from
        # starting (it would only break downloading).
        try:
            import fetch_paper
        except Exception as e:  # noqa: BLE001
            return self.send_json({"error": f"fetch_paper.py: {e}"}, 500)

        try:
            arxiv_id = fetch_paper.parse_arxiv_id(raw)
        except ValueError as e:
            return self.send_json({"error": str(e)}, 400)

        if not FETCH_LOCK.acquire(blocking=False):
            return self.send_json(
                {"error": "A download is already running. Wait for it to finish."}, 409
            )

        try:
            self.sse_start()
            self.sse({"type": "progress", "line": f"Fetching {arxiv_id} from arXiv ..."})

            def log_line(message, kind="info"):
                self.sse({"type": "progress", "line": message, "kind": kind})

            result = fetch_paper.download(arxiv_id, log=log_line)
            if not result.get("ok"):
                return self.sse(
                    {
                        "type": "error",
                        "message": result.get("error") or "download failed",
                    }
                )
            self.sse(
                {
                    "type": "done",
                    "cached": bool(result.get("cached")),
                    "paper": {
                        "id": result.get("id") or arxiv_id,
                        "arxivId": result.get("arxivId") or arxiv_id,
                        "title": result.get("title") or "",
                        "authors": result.get("authors") or [],
                        "published": result.get("published") or "",
                        "source": result.get("source"),
                    },
                }
            )
        finally:
            FETCH_LOCK.release()

    # ---- one streaming call to Gemini ----
    def stream_gemini(self, model, key, prompt):
        """Ask one model; log the outcome so the chain is easy to debug."""
        ok, chunks, err = self._stream_gemini(model, key, prompt)
        if ok:
            sys.stderr.write(f"[gemini] {model}: ok, {len(chunks)} chunks\n")
        else:
            why = err[2] if err and len(err) > 2 else ""
            sys.stderr.write(f"[gemini] {model}: {err[0] if err else '?'} {why[:160]}\n")
        return ok, chunks, err

    def _stream_gemini(self, model, key, prompt, thinking=True):
        """Stream one model's answer to the browser.  Returns (ok, chunks, err).

        err is None on success, ("fatal", code, message) for problems the user
        must see, and ("skip", model, reason) for "this model is busy, try the
        next one" (quota / demand / retired model).
        """
        url = f"{API_ROOT}/models/{model}:streamGenerateContent?alt=sse"
        gen = {
            "temperature": 0.3,
            "maxOutputTokens": MAX_OUTPUT_TOKENS,
        }
        if thinking:
            # Thinking off: the answer is 70 words, and thinking tokens would
            # eat the output budget and stall the live typing.
            gen["thinkingConfig"] = {"thinkingBudget": 0}
        body = json.dumps(
            {
                "contents": [{"role": "user", "parts": [{"text": prompt}]}],
                "generationConfig": gen,
            }
        ).encode("utf-8")
        upstream = urllib.request.Request(
            url,
            data=body,
            method="POST",
            headers={
                "content-type": "application/json",
                # The key travels in a header, not in the URL: a URL shows up in
                # proxy logs, error messages and crash dumps.
                "x-goog-api-key": key,
            },
        )

        chunks = []
        t0 = time.time()
        try:
            with urllib.request.urlopen(upstream, timeout=REQUEST_TIMEOUT) as resp:
                # Gemini's stream is SSE too:  "data: {json}\n\n"
                for raw in resp:
                    line = raw.decode("utf-8", "replace").strip()
                    if not line.startswith("data:"):
                        continue
                    try:
                        ev = json.loads(line[5:].strip())
                    except ValueError:
                        continue
                    if "error" in ev:
                        msg = ev["error"].get("message", "API error")
                        return False, chunks, ("skip", model, msg)
                    for cand in ev.get("candidates", []):
                        for part in cand.get("content", {}).get("parts", []):
                            txt = part.get("text")
                            if txt:
                                chunks.append(txt)
                                self.sse({"type": "text", "text": txt})
                        reason = cand.get("finishReason")
                        if reason and reason not in ("STOP",):
                            # SAFETY / RECITATION / MAX_TOKENS: tell the user
                            # instead of silently sending a truncated answer.
                            if reason == "MAX_TOKENS":
                                chunks.append(
                                    "\n\n_(answer cut off at the token limit)_"
                                )
                                self.sse(
                                    {"type": "text", "text": chunks[-1]}
                                )
                            else:
                                return (
                                    False,
                                    chunks,
                                    (
                                        "fatal",
                                        "api",
                                        f"Gemini stopped early ({reason}).",
                                    ),
                                )
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")
            try:
                detail = json.loads(detail)["error"]["message"]
            except (ValueError, KeyError, TypeError):
                detail = detail[:300]
            if e.code in (401, 403):
                return (
                    False,
                    chunks,
                    ("fatal", "api", f"Gemini rejected the key ({e.code}): {detail}"),
                )
            if e.code == 400 and thinking:
                # The flash-lite models reject thinkingConfig outright. Try the
                # same model again without it before giving up on it.
                return self._stream_gemini(model, key, prompt, thinking=False)
            if e.code == 400:
                # Bad request for this model (wrong params, safety): skip it
                # rather than failing the whole request - another model may be
                # perfectly happy.
                POOL.fail(model, 400)
                return False, chunks, ("skip", model, f"400: {detail}")
            if e.code == 429:
                bucket, limit, wait = parse_quota(detail)
                POOL.fail(model, 429, wait=wait, bucket=bucket, limit=limit)
                # A short wait means "slow down, the per-minute limit tripped";
                # a long one means this bucket's daily allowance is gone. Both
                # are per-bucket, so we fall through to the next model - the
                # chain spans several buckets on purpose.
                return False, chunks, ("skip", model, f"429: {detail}")
            if e.code in (404, 500, 502, 503, 504):
                POOL.fail(model, e.code)
                return False, chunks, ("skip", model, f"{e.code}: {detail}")
            return False, chunks, ("fatal", "api", f"Gemini API {e.code}: {detail}")
        except (urllib.error.URLError, TimeoutError) as e:
            POOL.fail(model, 503)
            return False, chunks, ("skip", model, f"Could not reach the API: {e}")

        if not chunks:
            return (
                False,
                chunks,
                (
                    "fatal",
                    "api",
                    "Gemini returned an empty answer for this section.",
                ),
            )
        POOL.ok(model)
        return True, chunks, None


def main():
    PAPERS_DIR.mkdir(exist_ok=True)
    CACHE_DIR.mkdir(exist_ok=True)
    try:
        srv = ThreadingHTTPServer((HOST, PORT), Handler)
    except OSError as e:
        if e.errno not in (48, 98):  # EADDRINUSE (mac/linux), EADDRINUSE (windows)
            raise
        print(f"\nPort {PORT} is already in use - another copy of Paper Crawler is\n"
              f"probably still running. Either:\n"
              f"  - open http://localhost:{PORT} (the other copy is fine to use)\n"
              f"  - stop the old one and start this one:  lsof -ti :{PORT} | xargs kill\n"
              f"  - or use a different port:  PORT=5174 python serve.py\n")
        sys.exit(1)
    srv.daemon_threads = True
    print(f"Paper Crawler  ->  http://localhost:{PORT}")
    print(f"  models: {' -> '.join(POOL.order)}")
    print(
        "  API key: "
        + (
            "found"
            if get_api_key()
            else "NOT SET (visuals work; AI explanations are off)"
        )
    )
    print(
        f"  papers: {len(list(PAPERS_DIR.glob('*.html')))} in papers/   (add more: python fetch_paper.py <arxiv id>)"
    )
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
