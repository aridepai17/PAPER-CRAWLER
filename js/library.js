/**
 * library.js - the paper library drawer.
 *
 * Three things live in the drawer (L):
 *   1. YOUR PAPERS: everything in papers/, searchable, one click to open.
 *   2. ADD A PAPER: type an arXiv id (or URL) and the server downloads it
 *      from arXiv -> POST /api/fetch, which streams progress back as SSE.
 *   3. THIS PAPER: the table of contents. Clicking a section sends the
 *      spider there, and the explainer picks the section up on the way.
 *
 * The drawer is deliberately a *drawer*: the paper keeps crawling behind it.
 */

import { listPapers } from "./loader.js";

const $ = (s) => document.querySelector(s);

export class Library {
  constructor({ onOpenPaper, onGoSection } = {}) {
    this.onOpenPaper = onOpenPaper || (() => {});
    this.onGoSection = onGoSection || (() => {});
    this.papers = [];
    this.currentId = null;

    this.el = {
      root: $("#library"),
      backdrop: $("#library-backdrop"),
      close: $("#lib-close"),
      input: $("#lib-arxiv"),
      fetch: $("#lib-fetch"),
      progress: $("#lib-progress"),
      search: $("#lib-search"),
      list: $("#lib-papers"),
      outline: $("#lib-outline"),
      status: $("#lib-status"),
    };

    this.el.close.addEventListener("click", () => this.close());
    this.el.backdrop.addEventListener("click", () => this.close());
    this.el.search.addEventListener("input", () => this.renderPapers());
    this.el.fetch.addEventListener("click", () => this.addPaper());
    this.el.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.addPaper();
      }
    });
  }

  get open() {
    return !this.el.root.hidden;
  }

  /* ------------------------------------------------------------- open/close */
  async show() {
    this.el.root.hidden = false;
    this.el.backdrop.hidden = false;
    document.body.classList.add("lib-open");
    await this.refresh();
    this.el.input.focus();
  }

  close() {
    this.el.root.hidden = true;
    this.el.backdrop.hidden = true;
    document.body.classList.remove("lib-open");
  }

  async toggle() {
    if (this.open) this.close();
    else await this.show();
  }

  /* ----------------------------------------------------------------- papers */
  async refresh() {
    this.papers = await listPapers();
    this.renderPapers();
    await this.renderStatus();
  }

  setCurrent(id) {
    this.currentId = id;
    this.renderPapers();
  }

  renderPapers() {
    const q = this.el.search.value.trim().toLowerCase();
    const list = this.el.list;
    list.replaceChildren();
    const rows = this.papers.filter((p) => {
      if (!q) return true;
      const hay = `${p.title || ""} ${p.id || ""} ${(p.authors || []).join(" ")}`;
      return hay.toLowerCase().includes(q);
    });
    if (!rows.length) {
      const li = document.createElement("li");
      li.className = "lib-empty";
      li.textContent = q
        ? `no paper matches "${q}"`
        : "no papers yet - add one above";
      list.append(li);
      return;
    }
    for (const p of rows) {
      const li = document.createElement("li");
      li.className = "lib-paper" + (p.id === this.currentId ? " on" : "");
      const b = document.createElement("b");
      b.textContent = p.title || p.id;
      const s = document.createElement("span");
      const auth = (p.authors || []).slice(0, 3).join(", ");
      s.textContent = `${p.id} · ${auth}${(p.authors || []).length > 3 ? " et al." : ""} · ${p.published || ""}`;
      li.append(b, s);
      li.addEventListener("click", () => this.onOpenPaper(p.id));
      list.append(li);
    }
  }

  /* ------------------------------------------------------------ table of contents */
  setOutline(sections) {
    const ul = this.el.outline;
    ul.replaceChildren();
    for (const s of sections || []) {
      if (s.isRefs) continue; // the bibliography is not worth listing
      const li = document.createElement("li");
      li.className = "lib-sec lv" + (s.level || 1);
      li.textContent = s.title;
      li.title = s.title;
      li.addEventListener("click", () => {
        this.onGoSection(s);
        this.close();
      });
      ul.append(li);
    }
    if (!ul.children.length) {
      const li = document.createElement("li");
      li.className = "lib-empty";
      li.textContent = "no sections found";
      ul.append(li);
    }
  }

  /* --------------------------------------------------------------- the download */
  async addPaper() {
    const raw = this.el.input.value.trim();
    if (!raw) return;
    const box = this.el.progress;
    box.hidden = false;
    box.replaceChildren();
    const line = (text, kind) => {
      const d = document.createElement("div");
      d.className = "lib-log" + (kind ? " " + kind : "");
      d.textContent = text;
      box.append(d);
      box.scrollTop = box.scrollHeight;
    };

    this.el.fetch.disabled = true;
    this.el.input.disabled = true;
    try {
      const res = await fetch("/api/fetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: raw }),
      });
      const ctype = res.headers.get("content-type") || "";
      if (ctype.includes("application/json")) {
        // The server rejected it before starting the stream (bad id, busy...).
        const j = await res.json().catch(() => ({}));
        line(j.error || `download failed (HTTP ${res.status})`, "err");
        return;
      }
      const done = await this.readStream(res, line);
      if (done) {
        const id = done.paper?.id;
        line(
          done.cached ? "already in your library" : `downloaded ${id || raw}`,
          "ok",
        );
        await this.refresh();
        // Don't re-open the paper you are already reading: that would throw
        // away your place in it.
        if (id && id !== this.currentId) this.onOpenPaper(id);
      }
    } catch (e) {
      line("download failed: " + (e.message || e), "err");
    } finally {
      this.el.fetch.disabled = false;
      this.el.input.disabled = false;
      this.el.input.value = "";
    }
  }

  /** Read the SSE stream of /api/fetch. Returns the "done" event, or null. */
  async readStream(res, line) {
    if (!res.body) {
      line("this browser cannot stream the download", "err");
      return null;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let done = null;
    for (;;) {
      const { value, done: fin } = await reader.read();
      if (fin) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const m = chunk.split("\n").find((l) => l.startsWith("data: "));
        if (!m) continue;
        let ev;
        try {
          ev = JSON.parse(m.slice(6));
        } catch (_) {
          continue;
        }
        if (ev.type === "progress") line(ev.line);
        else if (ev.type === "error") {
          line(ev.message || "download failed", "err");
          return null;
        } else if (ev.type === "done") done = ev;
      }
    }
    if (!done) line("the download ended without a result", "err");
    return done;
  }

  /* ------------------------------------------------------------------ status */
  async renderStatus() {
    try {
      const s = await (await fetch("/api/status")).json();
      if (!s.hasKey) {
        this.el.status.textContent =
          "no GEMINI_API_KEY - the spider still crawls";
        return;
      }
      let t = s.model || "no model";
      if (s.quotaReset) {
        const mins = Math.max(
          0,
          Math.round((s.quotaReset * 1000 - Date.now()) / 60000),
        );
        t +=
          mins > 90
            ? ` · quota resets in ${Math.round(mins / 60)}h`
            : ` · resets in ${mins}m`;
      }
      this.el.status.textContent = t;
    } catch (_) {
      this.el.status.textContent = "server?";
    }
  }
}
