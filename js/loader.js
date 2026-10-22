/**
 * loader.js - turns a downloaded arXiv HTML file into a "crawlable" page.
 *
 *   loadPaper(id)  ->  Paper
 *
 * What it does:
 *   1. fetches papers/<id>.html + <id>.json and CLEANS the HTML (drops arXiv's
 *      scripts / styles / nav chrome; we use our own LaTeX-ish theme).
 *   2. WORD FOOTHOLDS: every text node becomes  <span class="w">word</span>
 *      separated by normal whitespace. The spider plants feet on these spans.
 *      Wrapping thousands of words up front would be slow on a long paper, so
 *      it is LAZY: an IntersectionObserver wraps a block (paragraph, cell,
 *      heading...) only when it gets within ~1.5 screens of the viewport.
 *      Math / code / SVG are never wrapped (we skip <math> etc.).
 *   3. SECTION DETECTION: finds the headings (LaTeXML marks them with
 *      .ltx_title_section / _subsection / _abstract / _bibliography), and
 *      records for each section its heading element, its text blocks, and its
 *      page-y position, so the spider can ask "which section am I standing in?"
 *      with a binary search every frame (no DOM work).
 */

/** The TikTok-style caption toggled with the T key. One place to change it. */
export const TITLE_OVERLAY_TEXT =
  "I built a spider that reads ML papers for me";

/** 1 = only top-level sections; 2 = sections + subsections (e.g. "3.2 Attention"). */
const SECTION_DEPTH = 2;

/** Never wrap text inside these (math must stay intact, code/svg are not prose). */
const SKIP_WRAP = "math, svg, pre, code, script, style, textarea, .ltx_listing";
/** Blocks that get observed; their text nodes are wrapped when near the viewport. */
const WRAP_BLOCKS =
  "p, li, dd, dt, td, th, caption, figcaption, h1, h2, h3, h4, h5, h6, .ltx_bibblock, .ltx_title, .ltx_tag";
/** Heading candidates for section detection. */
const HEAD_SEL =
  ".ltx_title_section, .ltx_title_subsection, .ltx_title_subsubsection, .ltx_title_abstract, " +
  ".ltx_title_bibliography, .ltx_title_appendix, .ltx_title_acknowledgements, h2, h3, h4";
/** Paragraph-like blocks whose text feeds the AI explainer. */
export const TEXT_BLOCKS = "p, figcaption, dd, .ltx_bibitem";

const $ = (s, r = document) => r.querySelector(s);

/* ------------------------------------------------------------------ list */
export async function listPapers() {
  try {
    const r = await fetch("/api/papers");
    if (r.ok) return await r.json();
  } catch (_) {
    /* fall through */
  }
  return [];
}

/* ------------------------------------------------------------------ load */
export async function loadPaper(id) {
  const [htmlRes, metaRes] = await Promise.all([
    fetch(`papers/${id}.html`),
    fetch(`papers/${id}.json`),
  ]);
  if (!htmlRes.ok)
    throw new Error(
      `papers/${id}.html not found - add it from the library drawer (press L), ` +
        `or run: python fetch_paper.py ${id}`,
    );
  const meta = metaRes.ok
    ? await metaRes.json()
    : { id, title: id, authors: [] };
  const doc = new DOMParser().parseFromString(
    await htmlRes.text(),
    "text/html",
  );
  return new Paper(id, meta, doc);
}

/* ================================================================== Paper */
export class Paper {
  constructor(id, meta, doc) {
    this.id = id;
    this.meta = meta;
    this.root = $("#paper"); // the white page
    this.body = $("#paper-body");
    this.sections = [];
    this.bounds = { left: 0, right: 0, cx: 0, top: 0, bottom: 0 };
    this.layoutDirty = true;
    this.autoFlush = true; // crawler.js turns this off and flushes in commit()
    this.wrapQueue = new Set(); // blocks waiting to be wrapped
    this._observers = [];

    this.mountHeader();
    this.mountBody(doc);
    this.buildSections();
    this.observeWrapping();
    this.watchLayout();
    this.refreshLayout();
  }

  /* ---- header: title, authors, id (the paper's own title block is hidden by CSS) ---- */
  mountHeader() {
    const m = this.meta;
    $("#paper-title").textContent = m.title || this.id;
    $("#paper-authors").textContent = (m.authors || []).join(", ");
    $("#paper-id").textContent =
      this.id === "demo"
        ? "demo fixture · not a real paper"
        : `arXiv:${this.id}${m.published ? " · " + m.published : ""}`;
    document.title = `${m.title || this.id} - Paper Crawler`;
  }

  /* ---- clean + mount the arXiv HTML ---- */
  mountBody(doc) {
    const src =
      doc.querySelector("article.ltx_document") ||
      doc.querySelector(".ltx_page_content") ||
      doc.body;
    const node = src.cloneNode(true);
    node
      .querySelectorAll(
        "script, style, link, nav, footer, button, iframe, .ltx_page_navbar, .ltx_page_footer, .ltx_page_header, " +
          ".ar5iv-footer, .package-alerts, .ltx_pagination, #header, .sr-only",
      )
      .forEach((n) => n.remove());
    // links open in a new tab (we don't want the paper page to navigate away mid-crawl)
    node.querySelectorAll("a[href]").forEach((a) => {
      if (!a.getAttribute("href").startsWith("#")) {
        a.target = "_blank";
        a.rel = "noopener";
      }
    });
    node.querySelectorAll("img").forEach((i) => {
      i.loading = "lazy";
      i.removeAttribute("height");
    });
    this.body.replaceChildren(node);
    this.content = node;
  }

  /* ================= section detection ================= */
  buildSections() {
    const root = this.content;
    const levelOf = (h) => {
      const c = h.className || "";
      if (
        /ltx_title_(section|abstract|bibliography|appendix|acknowledgements)/.test(
          c,
        )
      )
        return 1;
      if (/ltx_title_subsection/.test(c)) return 2;
      if (/ltx_title_subsubsection/.test(c)) return 3;
      if (/ltx_title_/.test(c)) return 4; // paragraph titles etc.
      const m = /^H(\d)$/.exec(h.tagName);
      return m ? Math.max(1, +m[1] - 1) : 4; // plain <h2> -> level 1
    };
    const heads = [...root.querySelectorAll(HEAD_SEL)].filter(
      (h) =>
        !h.closest("figure, table, .ltx_caption, .ltx_float, .ltx_note") &&
        !h.classList.contains("ltx_title_document") &&
        levelOf(h) <= SECTION_DEPTH,
    );
    const headSet = new Set(heads);

    // One pass in document order: a heading starts a section, a text block joins the current one.
    const sections = [];
    let cur = null;
    for (const el of root.querySelectorAll(HEAD_SEL + ", " + TEXT_BLOCKS)) {
      if (headSet.has(el)) {
        const title = this.headingText(el);
        cur = {
          idx: sections.length,
          id: "s" + sections.length,
          slug: slugify(title) || "section-" + sections.length,
          title,
          level: levelOf(el),
          headingEl: el,
          blocks: [],
          top: 0,
          isRefs:
            /reference|bibliograph/i.test(title) ||
            /bibliography/.test(el.className),
          isAbstract: /abstract/i.test(title),
          forcedText: null,
        };
        sections.push(cur);
      } else if (cur && el.matches(TEXT_BLOCKS) && !el.closest("math")) {
        cur.blocks.push(el);
      }
    }

    // Make sure the paper starts with an Abstract section (some HTML has no abstract heading).
    if (!sections.length || !sections[0].isAbstract) {
      const absEl = root.querySelector(".ltx_abstract");
      sections.unshift({
        idx: 0,
        id: "s0",
        slug: "abstract",
        title: "Abstract",
        level: 1,
        headingEl: absEl || $("#paper-head"),
        blocks: absEl ? [...absEl.querySelectorAll("p")] : [],
        top: 0,
        isRefs: false,
        isAbstract: true,
        forcedText: this.meta.abstract || null,
      });
      sections.forEach((s, i) => {
        s.idx = i;
        s.id = "s" + i;
      });
    }
    // Give the abstract the authoritative text from the arXiv API when we have it.
    if (sections[0].isAbstract && this.meta.abstract)
      sections[0].forcedText = this.meta.abstract;

    // Disambiguate duplicate slugs (cache file names must be unique per section).
    const seen = new Map();
    for (const s of sections) {
      const n = (seen.get(s.slug) || 0) + 1;
      seen.set(s.slug, n);
      if (n > 1) s.slug += "-" + n;
    }
    this.sections = sections;
  }

  /** Heading text with math -> alttext and the "3.2" tag spaced from the title. */
  headingText(h) {
    const c = h.cloneNode(true);
    c.querySelectorAll("math").forEach((m) =>
      m.replaceWith(m.getAttribute("alttext") || m.textContent),
    );
    c.querySelectorAll(".ltx_tag").forEach((t) => t.append(" "));
    return c.textContent
      .replace(/\s+/g, " ")
      .replace(/[:.]$/, "")
      .trim()
      .slice(0, 90);
  }

  /** Which section is at page-y? Binary search over cached heading tops. */
  sectionAt(pageY) {
    const s = this.sections;
    let lo = 0,
      hi = s.length - 1,
      ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (s[mid].top <= pageY + 2) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return s[ans];
  }

  /** Plain text of one block (math replaced by its LaTeX alttext). Cached on the node. */
  blockText(el) {
    if (el.__txt !== undefined) return el.__txt;
    const c = el.cloneNode(true);
    c.querySelectorAll("math").forEach((m) =>
      m.replaceWith(" " + (m.getAttribute("alttext") || m.textContent) + " "),
    );
    return (el.__txt = c.textContent.replace(/\s+/g, " ").trim());
  }

  /**
   * Text of a section for the AI, trimmed to `limit` chars. If it doesn't fit, the
   * paragraphs the spider actually walked over are kept first, then the rest in order.
   */
  sectionText(sec, walked = new Set(), limit = 12000) {
    if (sec.forcedText) return sec.forcedText.slice(0, limit);
    const items = sec.blocks
      .map((b) => ({ b, t: this.blockText(b) }))
      .filter((x) => x.t.length > 0);
    const total = items.reduce((n, x) => n + x.t.length + 2, 0);
    if (total <= limit) return items.map((x) => x.t).join("\n\n");
    const keep = new Set();
    let used = 0;
    for (const pass of [true, false]) {
      for (const x of items) {
        if (keep.has(x) || walked.has(x.b) !== pass) continue;
        if (used + x.t.length + 2 > limit) continue;
        keep.add(x);
        used += x.t.length + 2;
      }
    }
    return items
      .filter((x) => keep.has(x))
      .map((x) => x.t)
      .join("\n\n");
  }

  /**
   * Find an exact phrase (the AI's KEY: line) inside a section and return the word spans.
   * Matching is done word-by-word on letters/digits only, so punctuation/case don't matter.
   */
  findPhrase(phrase, sec) {
    const norm = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}%]/gu, "");
    const toks = phrase.split(/\s+/).map(norm).filter(Boolean);
    if (!toks.length || !sec) return null;
    const firstRaw = phrase.trim().split(/\s+/)[0].toLowerCase();
    for (const tryToks of [toks, toks.slice(0, 4)]) {
      for (const b of sec.blocks) {
        if (!b.textContent.toLowerCase().includes(firstRaw)) continue;
        this.ensureWrapped(b);
        const words = [...b.querySelectorAll(".w")]
          .map((s) => ({ s, n: norm(s.textContent) }))
          .filter((w) => w.n);
        for (let i = 0; i + tryToks.length <= words.length; i++) {
          let ok = true;
          for (let j = 0; j < tryToks.length; j++)
            if (words[i + j].n !== tryToks[j]) {
              ok = false;
              break;
            }
          if (ok) return words.slice(i, i + tryToks.length).map((w) => w.s);
        }
      }
    }
    return null;
  }

  /* ================= lazy word wrapping ================= */
  observeWrapping() {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries)
          if (e.isIntersecting) {
            this.wrapQueue.add(e.target);
            io.unobserve(e.target);
          }
        if (this.autoFlush) this.scheduleAutoFlush();
      },
      { rootMargin: "1500px 0px 1500px 0px" },
    );
    this.content.querySelectorAll(WRAP_BLOCKS).forEach((el) => io.observe(el));
    this._observers.push(io);
  }

  /** Fallback flusher used only until the crawler takes over (it calls flush() from commit()). */
  scheduleAutoFlush() {
    if (this._autoRaf) return;
    this._autoRaf = requestAnimationFrame(() => {
      this._autoRaf = 0;
      this.flush(6);
      if (this.wrapQueue.size && this.autoFlush) this.scheduleAutoFlush();
    });
  }

  /** Wrap queued blocks, stopping after `budgetMs` so a big jump can't cause a long frame. */
  flush(budgetMs = 3) {
    if (!this.wrapQueue.size) return;
    const t0 = performance.now();
    for (const el of this.wrapQueue) {
      this.wrapQueue.delete(el);
      wrapElement(el);
      if (performance.now() - t0 > budgetMs) break;
    }
  }

  /** Synchronously wrap a block (used when we must find words in it right now). */
  ensureWrapped(el) {
    this.wrapQueue.delete(el);
    wrapElement(el);
  }

  /* ================= layout cache ================= */
  watchLayout() {
    // Images loading / the window resizing change page height -> heading tops are stale.
    const ro = new ResizeObserver(() => {
      this.layoutDirty = true;
    });
    ro.observe(this.root);
    this._observers.push(ro);
  }

  /** Re-read heading positions + column bounds. Called by the crawler in its READ phase. */
  refreshLayout() {
    const sy = window.scrollY;
    for (const s of this.sections) {
      s.top =
        s.headingEl === $("#paper-head")
          ? 0
          : s.headingEl.getBoundingClientRect().top + sy;
    }
    if (
      this.sections[0] &&
      this.sections[0].isAbstract &&
      this.sections[0].headingEl !== $("#paper-head")
    ) {
      // the abstract "section" starts at the paper's very top so the title area counts as Abstract
      this.sections[0].top = 0;
    }
    const r = this.root.getBoundingClientRect();
    const pad = 70;
    this.bounds = {
      left: r.left + pad,
      right: r.right - pad,
      cx: (r.left + r.right) / 2,
      top: r.top + sy,
      bottom: r.bottom + sy,
    };
    this.layoutDirty = false;
  }

  dispose() {
    this._observers.forEach((o) => o.disconnect());
    this.wrapQueue.clear();
    if (this._autoRaf) cancelAnimationFrame(this._autoRaf);
  }
}

/* ---------------------------------------------------------------- wrapping */
/** Split every text node under `el` into <span class="w">word</span> + whitespace. */
export function wrapElement(el) {
  if (el.__wrapped) return;
  el.__wrapped = true;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (!n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      const p = n.parentElement;
      if (!p || p.classList.contains("w") || p.closest(SKIP_WRAP))
        return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const n of nodes) {
    const frag = document.createDocumentFragment();
    for (const part of n.nodeValue.split(/(\s+)/)) {
      if (!part) continue;
      if (/^\s+$/.test(part)) frag.append(part);
      else {
        const s = document.createElement("span");
        s.className = "w";
        s.textContent = part;
        frag.append(s);
      }
    }
    n.replaceWith(frag);
  }
}

function slugify(s) {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

/* ---------------------------------------------------------- title overlay */
export function setTitleOverlay(on) {
  const el = $("#title-overlay");
  el.textContent = TITLE_OVERLAY_TEXT;
  el.classList.toggle("on", on);
  return on;
}
