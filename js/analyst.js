/**
 * analyst.js - the AI half of Paper Crawler. The spider is the visual; Gemini does the reading.
 *
 * THE PIPELINE (explainable in 20 seconds):
 *   spider walks into a new section
 *     -> crawler emits "section"            (crawler.js, binary search over heading positions)
 *     -> Analyst.onSection() queues a job   (ONE request at a time, the rest wait in a queue)
 *     -> POST /api/explain {title, section, text(<=12k chars), level}   (serve.py holds the API key)
 *     -> serve.py streams Gemini's answer back as Server-Sent Events    (typed out live here)
 *     -> the last line is "KEY: <exact phrase>"; we FIND that phrase in the paper
 *     -> crawler.pointAt(words): the spider runs to it and blows it up (orange + box).
 *
 * Also here: "Explain this" (select text + E), the Crawler Notes tab (metrics / models /
 * datasets the spider touched), and the Markdown / JSON exports.
 */

const $ = (s) => document.querySelector(s);
const LEVELS = ["beginner", "student", "researcher"];
const LEVEL_NAMES = {
  beginner: "beginner (CS freshman)",
  student: "student (knows basic ML)",
  researcher: "researcher (technical)",
};

export function toast(msg, ms = 2400) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), ms);
}

/** Split the model's reply into the explanation and the "KEY:" phrase (also hides a half-typed "KE"). */
export function splitKey(full) {
  const i = full.search(/\bKEY\s*:/i);
  if (i < 0)
    return {
      body: full.replace(/(?:\n\s*)K(?:E(?:Y)?)?$/, "").trimEnd(),
      key: "",
    };
  const body = full.slice(0, i).trimEnd();
  let key = full
    .slice(i)
    .replace(/^\bKEY\s*:\s*/i, "")
    .split("\n")[0]
    .trim();
  key = key.replace(/^[\s"“”'‘’`*]+|[\s"“”'‘’`*]+$/g, "");
  return { body, key };
}

/** Render **bold** and `code` without ever using innerHTML on model output. */
function renderInline(el, text) {
  el.textContent = "";
  for (const p of text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)) {
    if (!p) continue;
    if (p.length > 4 && p.startsWith("**") && p.endsWith("**")) {
      const b = document.createElement("b");
      b.textContent = p.slice(2, -2);
      el.append(b);
    } else if (p.length > 2 && p.startsWith("`") && p.endsWith("`")) {
      const c = document.createElement("code");
      c.textContent = p.slice(1, -1);
      el.append(c);
    } else el.append(p);
  }
}

export class Analyst {
  constructor(crawler) {
    this.crawler = crawler;
    this.paper = null;
    this.level = "student";
    this.results = Object.fromEntries(LEVELS.map((l) => [l, new Map()])); // level -> (jobKey -> entry)
    this.cards = new Map(); // jobKey -> {el, txt, key}
    this.failed = new Set(); // "level|jobKey" that errored (don't hammer the API)
    this.queue = [];
    this.busy = false;
    this.abort = null;
    this.noKey = false;
    this.notes = [];
    this.selN = 0;
    this.retries = new Map(); // jobKey -> {timer, tries}  (temporary errors)
    this.pauseUntil = 0; // circuit breaker: don't ask Gemini before this
    this.pauseTimer = null;
    this.gen = 0; // bumped on every level switch: kills stale requests
    this.token = null; // identity of the in-flight request

    this.el = {
      sec: $("#an-sec"),
      hist: $("#an-history"),
      notes: $("#an-notes"),
      noteCount: $("#note-count"),
      banner: $("#an-banner"),
      status: $("#an-status"),
      live: $("#tab-live"),
      notesTab: $("#tab-notes"),
    };
    crawler.on("section", (s) => this.onSection(s));
    crawler.on("note", (n) => this.addNote(n));

    document
      .querySelectorAll("#levels button")
      .forEach((b) =>
        b.addEventListener("click", () => this.setLevel(b.dataset.l)),
      );
    document
      .querySelectorAll(".an-tabs button")
      .forEach((b) =>
        b.addEventListener("click", () => this.showTab(b.dataset.tab)),
      );
    $("#exp-md").addEventListener("click", () => this.exportMarkdown());
    $("#exp-json").addEventListener("click", () => this.exportNotes());
  }

  /* ---------------------------------------------------------- lifecycle */
  attach(paper) {
    this.abort && this.abort.abort();
    this.clearRetries();
    this.gen++; // any request still in flight belongs to the old paper
    this.paper = paper;
    for (const l of LEVELS) this.results[l].clear();
    this.cards.clear();
    this.failed.clear();
    this.queue.length = 0;
    this.busy = false;
    this.notes = [];
    this.selN = 0;
    this.el.hist.replaceChildren();
    this.renderNotes();
    this.el.sec.textContent = "-";
    this.checkStatus();
    // TL;DR: explain the abstract immediately, before the spider even lands.
    const abs = paper.sections[0];
    if (abs) this.enqueue(this.sectionJob(abs));
  }

  async checkStatus() {
    try {
      const s = await (await fetch("/api/status")).json();
      this.noKey = !s.hasKey;
      this.showBanner(this.noKey);
      this.el.status.textContent = s.hasKey ? s.model : "AI off";
    } catch (_) {
      this.el.status.textContent = "server?";
    }
  }
  showBanner(on) {
    const b = this.el.banner;
    b.hidden = !on;
    if (!on) return;
    b.replaceChildren();
    b.append(
      "AI explainer is off: no ",
      Object.assign(document.createElement("code"), {
        textContent: "GEMINI_API_KEY",
      }),
      " found. Create a ",
      Object.assign(document.createElement("code"), { textContent: ".env" }),
      " file next to serve.py containing ",
      Object.assign(document.createElement("code"), {
        textContent: "GEMINI_API_KEY=your-key",
      }),
      " and restart ",
      Object.assign(document.createElement("code"), {
        textContent: "python serve.py",
      }),
      ". The spider still crawls and marks up the paper; any cached explanations will still appear.",
    );
  }

  showTab(name) {
    document
      .querySelectorAll(".an-tabs button")
      .forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
    this.el.live.hidden = name !== "live";
    this.el.notesTab.hidden = name !== "notes";
  }

  /* ---------------------------------------------------------- level */
  setLevel(level) {
    if (!LEVELS.includes(level) || level === this.level) return;
    this.level = level;
    document
      .querySelectorAll("#levels button")
      .forEach((b) => b.classList.toggle("on", b.dataset.l === level));
    this.abort && this.abort.abort();
    this.clearRetries();
    this.gen++; // kills anything still in flight for the previous level
    this.queue.length = 0;
    this.busy = false;
    this.el.hist.replaceChildren();
    this.cards.clear();
    for (const [, e] of [...this.results[level]].sort(
      (a, b) => a[1].order - b[1].order,
    )) {
      this.paintCard(e); // re-create the card from the answer we already have
    }
    toast(`Explaining at ${LEVEL_NAMES[level]} level`);
    if (this.paper) {
      this.enqueue(this.sectionJob(this.paper.sections[0]));
      if (this.crawler.curSec) this.onSection(this.crawler.curSec);
    }
    this.pump();
  }

  /* ---------------------------------------------------------- jobs */
  sectionJob(sec) {
    return {
      key: "sec:" + sec.id,
      kind: "section",
      sec,
      title: sec.title,
      label: sec.isAbstract ? "TL;DR" : "",
      order: sec.idx,
      gen: this.gen,
    };
  }

  onSection(sec) {
    this.el.sec.textContent = sec.title;
    if (sec.isRefs) return; // nothing worth explaining in the bibliography
    this.enqueue(this.sectionJob(sec));
  }

  enqueue(job, front = false) {
    const k = this.level + "|" + job.key;
    if (job.gen !== undefined && job.gen !== this.gen) return; // stale level
    if (
      this.results[this.level].has(job.key) ||
      this.failed.has(k) ||
      this.queue.some((j) => j.key === job.key)
    )
      return;
    job.level = this.level;
    front ? this.queue.unshift(job) : this.queue.push(job);
    this.pump();
  }

  /** "Explain this" (E): spider runs to the selection; Gemini explains just that passage. */
  explainSelection() {
    const sel = getSelection();
    const text = String(sel).replace(/\s+/g, " ").trim();
    if (!this.paper || text.length < 3) {
      toast("Select some text in the paper first, then press E");
      return;
    }
    const span = firstWord(sel.getRangeAt(0));
    let secTitle = this.crawler.curSec
      ? this.crawler.curSec.title
      : "the paper";
    if (span) {
      const y = span.getBoundingClientRect().top + scrollY;
      secTitle = this.paper.sectionAt(y).title;
      this.crawler.pointAt([span], {
        mark: false,
        dwell: 2.2,
        setFrontier: "set",
      });
    }
    const n = ++this.selN;
    this.showTab("live");
    this.enqueue(
      {
        key: "sel:" + n,
        kind: "selection",
        title: secTitle,
        text: text.slice(0, 2500),
        quote: text.slice(0, 140),
        label: "selection",
        order: 1000 + n,
        gen: this.gen,
      },
      true,
    );
  }

  async pump() {
    if (this.busy) return;
    // Circuit breaker: if Gemini just told us it is out of quota, stop
    // firing requests for a while instead of burning the queue on errors.
    if (this.pauseUntil && Date.now() < this.pauseUntil) {
      clearTimeout(this.pauseTimer);
      this.pauseTimer = setTimeout(
        () => this.pump(),
        this.pauseUntil - Date.now() + 250,
      );
      return;
    }
    const job = this.queue.shift();
    if (!job) {
      this.el.status.textContent = this.noKey
        ? "AI off"
        : this.el.status.textContent.replace(/ · .*/, "");
      return;
    }
    if (job.level !== this.level) return this.pump();
    this.busy = true;
    const token = (this.token = {});
    try {
      await this.run(job);
    } catch (e) {
      console.warn("[analyst]", e);
    }
    // If a level switch happened while we were waiting, the newer pump owns
    // the queue now - don't clear its "busy" flag or start a second request.
    if (this.token === token) {
      this.busy = false;
      this.pump();
    }
  }

  /** Stop asking Gemini for a moment (quota / demand). */
  pause(ms) {
    this.pauseUntil = Math.max(this.pauseUntil || 0, Date.now() + ms);
  }

  /* ---------------------------------------------------------- one request */
  async run(job) {
    const level = job.level,
      paper = this.paper;
    const text =
      job.kind === "section"
        ? paper.sectionText(job.sec, this.crawler.walked)
        : job.text;
    if (job.kind === "section" && text.length < 200) return; // heading with no body of its own

    const entry = {
      key: job.key,
      // Cards are keyed per level: the same section explained at two levels
      // must not fight over one card element.
      cardKey: level + "|" + job.key,
      level,
      kind: job.kind,
      title: job.title,
      label: job.label,
      quote: job.quote,
      order: job.order,
      secIdx: job.sec ? job.sec.idx : -1,
      text: "",
      keyPhrase: "",
      done: false,
      error: "",
    };
    this.results[level].set(job.key, entry);
    const startCard = this.ensureCard(entry);
    startCard && startCard.el.classList.add("typing");
    this.paintCard(entry);

    const ctrl = (this.abort = new AbortController());
    let raw = "";
    // If Gemini is slow (or the fallback chain is walking through models),
    // say so instead of leaving the card on "reading…" with no explanation.
    const slowTimer = setTimeout(() => {
      const c = this.cards.get(entry.cardKey);
      if (c && !entry.text && !c.el.querySelector(".retry")) {
        const note = document.createElement("div");
        note.className = "retry";
        note.textContent = "still waiting for Gemini…";
        c.el.append(note);
      }
    }, 6000);
    try {
      const res = await fetch("/api/explain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          paperId: paper.id,
          title: paper.meta.title || paper.id,
          section: job.title,
          sectionSlug: job.sec ? job.sec.slug : "",
          text,
          level,
          mode: job.kind === "selection" ? "selection" : "section",
        }),
      });
      if (!res.ok || !res.body)
        throw new Error("server returned " + res.status);
      const reader = res.body.getReader(),
        dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          // one SSE message per blank line
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 2);
          if (!line.startsWith("data:")) continue;
          const ev = JSON.parse(line.slice(5));
          if (ev.type === "text") {
            raw += ev.text;
            const s = splitKey(raw);
            entry.text = s.body;
            entry.keyPhrase = s.key;
            this.paintCard(entry, true);
          } else if (ev.type === "reset") {
            // the model died mid-answer and the server is trying the next one:
            // throw the partial text away so we don't end up with two halves.
            raw = "";
            entry.text = "";
            entry.keyPhrase = "";
            this.paintCard(entry, true);
          } else if (ev.type === "done") {
            // the server tells us which model actually answered
            if (ev.model) this.el.status.textContent = ev.model;
          } else if (ev.type === "error") {
            entry.error = ev.message;
            entry.errCode = ev.code;
            entry.resetAt = ev.resetAt || 0;
          }
        }
      }
    } catch (e) {
      clearTimeout(slowTimer);
      if (e.name === "AbortError") {
        this.results[level].delete(job.key);
        this.dropCard(entry.cardKey);
        return;
      }
      entry.error = "Could not reach the explainer: " + e.message;
    }
    clearTimeout(slowTimer);

    // The level changed while we were waiting: this answer belongs to a
    // generation that is no longer on screen. Drop it quietly.
    if (job.gen !== undefined && job.gen !== this.gen) {
      this.results[level].delete(job.key);
      this.dropCard(entry.cardKey);
      return;
    }

    const card = this.cards.get(entry.cardKey);
    card && card.el.classList.remove("typing");
    if (entry.error && !entry.text) {
      if (entry.errCode === "no_key") {
        this.noKey = true;
        this.showBanner(true);
        this.results[level].delete(job.key);
        this.dropCard(entry.cardKey);
        return;
      }
      if (entry.errCode === "no_model" || entry.errCode === "quota") {
        // Gemini is out of quota / under load. That is temporary, so DON'T
        // blacklist the job: schedule a retry (at the reset time if the server
        // told us) and let the card say so.
        this.results[level].delete(job.key);
        this.paintCard(entry);
        this.pause(20000);
        this.scheduleRetry(job, entry.resetAt);
        return;
      }
      this.failed.add(level + "|" + job.key);
      this.paintCard(entry);
      return;
    }
    entry.done = true;
    this.paintCard(entry);
    // The payoff: find KEY in the paper and send the spider to it (only if it's still in that section).
    if (
      job.kind === "section" &&
      entry.keyPhrase &&
      this.crawler.curSec === job.sec
    )
      this.pointAtKey(entry, job.sec);
  }

  pointAtKey(entry, sec) {
    const spans = this.paper.findPhrase(entry.keyPhrase, sec);
    if (spans && spans.length)
      this.crawler.pointAt(spans, { setFrontier: "max" });
    else
      toast("Couldn't find “" + entry.keyPhrase.slice(0, 40) + "” in the text");
  }

  /* ---------------------------------------------------------- retries */
  /** Temporary failure (quota / demand): try the same job again later. */
  scheduleRetry(job, resetAt) {
    const prev = this.retries.get(job.key) || { tries: 0, timer: null };
    if (prev.timer) clearTimeout(prev.timer);
    const tries = prev.tries + 1;
    if (tries > 6) return; // 15s,30s,60s,120s,120s,120s then give up
    // If the server told us when the quota reopens, wait exactly that long.
    const untilReset = resetAt ? resetAt * 1000 - Date.now() : 0;
    const wait =
      untilReset > 15000
        ? untilReset
        : Math.min(15000 * 2 ** (tries - 1), 120000);
    const timer = setTimeout(() => {
      const r = this.retries.get(job.key);
      if (r) r.timer = null;
      this.enqueue(job);
    }, wait);
    this.retries.set(job.key, { tries, timer });
    const card = this.cards.get((job.level || this.level) + "|" + job.key);
    if (card) {
      const old = card.el.querySelector(".retry");
      old && old.remove();
      const note = document.createElement("div");
      note.className = "retry";
      note.textContent =
        untilReset > 15000
          ? `Gemini's daily quota is used up - retrying in ${humanTime(wait)}`
          : `Gemini is busy or out of quota - retrying in ${Math.round(wait / 1000)}s…`;
      card.el.append(note);
    }
  }

  clearRetries() {
    for (const [, r] of this.retries) if (r.timer) clearTimeout(r.timer);
    this.retries.clear();
  }

  /* ---------------------------------------------------------- cards */
  ensureCard(e) {
    // A card belongs to ONE reading level. Once we switch levels the old
    // level's cards are wiped, so an answer that is still streaming in must
    // not resurrect a card for a level that is no longer on screen.
    if (e.level && e.level !== this.level) return null;
    const ck = e.cardKey || e.key;
    if (this.cards.has(ck)) return this.cards.get(ck);
    const el = document.createElement("div");
    el.className =
      "card" +
      (e.kind === "selection" ? " sel" : e.label === "TL;DR" ? " tldr" : "");
    const h = document.createElement("h4");
    h.append(
      document.createTextNode(
        e.kind === "selection" ? "◇ explain this" : "▸ " + e.title,
      ),
    );
    if (e.label && e.kind !== "selection") {
      const t = document.createElement("span");
      t.className = "tag";
      t.textContent = e.label;
      h.append(t);
    }
    el.append(h);
    if (e.quote) {
      const q = document.createElement("div");
      q.className = "quote";
      q.textContent = "“" + e.quote + (e.quote.length >= 140 ? "…" : "") + "”";
      el.append(q);
    }
    const txt = document.createElement("div");
    txt.className = "txt";
    el.append(txt);
    const card = { el, txt, key: null, entry: e };
    // insert in section order, so history stays in reading order
    const after = [...this.cards.values()].find((c) => c.entry.order > e.order);
    after ? this.el.hist.insertBefore(el, after.el) : this.el.hist.append(el);
    this.cards.set(ck, card);
    return card;
  }
  dropCard(key) {
    const c = this.cards.get(key);
    if (c) {
      c.el.remove();
      this.cards.delete(key);
    }
  }

  paintCard(e, stick = false) {
    const c = this.ensureCard(e);
    if (!c) return; // the card's level is no longer on screen
    const near =
      this.el.live.scrollHeight -
        this.el.live.scrollTop -
        this.el.live.clientHeight <
      80;
    c.txt.textContent = "";
    if (e.error && !e.text) {
      const s = document.createElement("span");
      s.className = "err";
      // the no_model message from the server is long; the card gets a short
      // version and the retry note below it carries the detail.
      s.textContent =
        e.errCode === "no_model" ? "Gemini is busy or out of quota." : e.error;
      c.txt.append(s);
    } else if (!e.text) {
      const s = document.createElement("span");
      s.className = "wait";
      s.textContent = "reading…";
      c.txt.append(s);
    } else renderInline(c.txt, e.text);
    if (e.keyPhrase && e.done) {
      if (!c.key) {
        c.key = document.createElement("div");
        c.key.className = "key";
        c.key.title = "Send the spider to this phrase";
        c.key.addEventListener("click", () => {
          const sec = this.paper.sections[e.secIdx] || this.crawler.curSec;
          if (sec) this.pointAtKey(e, sec);
        });
        c.el.append(c.key);
      }
      c.key.textContent = e.keyPhrase;
    }
    if (stick && near) this.el.live.scrollTop = this.el.live.scrollHeight;
  }

  /* ---------------------------------------------------------- Crawler Notes */
  addNote(n) {
    this.notes.push(n);
    this.renderNotes();
  }
  renderNotes() {
    this.el.noteCount.textContent = this.notes.length;
    const ul = this.el.notes;
    ul.replaceChildren();
    if (!this.notes.length) {
      const li = document.createElement("li");
      li.className = "an-empty";
      li.textContent =
        "Every metric, model and dataset the spider steps on is logged here with the sentence it appeared in.";
      ul.append(li);
      return;
    }
    for (const n of [...this.notes].reverse()) {
      const li = document.createElement("li");
      const chip = document.createElement("span");
      chip.className = "chip " + n.type;
      chip.textContent = n.type;
      const t = document.createElement("span");
      t.className = "nt";
      t.textContent = n.text;
      const s = document.createElement("div");
      s.className = "ns";
      s.textContent = n.section;
      const x = document.createElement("div");
      x.className = "nx";
      x.textContent = n.sentence;
      li.append(chip, t, s, x);
      ul.append(li);
    }
  }

  /* ---------------------------------------------------------- exports */
  exportMarkdown() {
    if (!this.paper) return;
    const P = this.paper,
      m = P.meta,
      entries = [...this.results[this.level].values()]
        .filter((e) => e.text)
        .sort((a, b) => a.order - b.order);
    if (!entries.length) {
      toast("Nothing explained yet - let the spider crawl a bit first");
      return;
    }
    const L = [];
    L.push(`# ${m.title || P.id} - paper breakdown`, "");
    L.push(
      `> arXiv:${P.id}${m.authors && m.authors.length ? " · " + m.authors.slice(0, 6).join(", ") + (m.authors.length > 6 ? " et al." : "") : ""}`,
    );
    L.push(
      `> Explained for a ${LEVEL_NAMES[this.level]} · crawled by Paper Crawler, explained by Gemini`,
      "",
    );
    const tl = entries.find((e) => e.label === "TL;DR");
    if (tl) L.push("## TL;DR", "", tl.text, "");
    const secs = entries.filter(
      (e) => e.kind === "section" && e.label !== "TL;DR",
    );
    if (secs.length) {
      L.push("## Section by section", "");
      for (const e of secs) {
        L.push(`### ${e.title}`, "", e.text, "");
        if (e.keyPhrase) L.push(`**Key:** \`${e.keyPhrase}\``, "");
      }
    }
    const sels = entries.filter((e) => e.kind === "selection");
    if (sels.length) {
      L.push("## Passages I asked about", "");
      for (const e of sels) L.push(`> ${e.quote}`, "", e.text, "");
    }
    const results = this.notes.filter((n) => n.type === "metric");
    const keys = entries
      .filter((e) => e.keyPhrase)
      .map((e) => `- **${e.keyPhrase}** - ${e.title}`);
    if (results.length || keys.length) {
      L.push("## Key results", "");
      L.push(...keys);
      for (const n of results)
        L.push(
          `- ${n.text} - *${n.section}*${n.sentence ? ": " + n.sentence : ""}`,
        );
      L.push("");
    }
    download(`${P.id}-breakdown.md`, L.join("\n"), "text/markdown");
  }

  exportNotes() {
    if (!this.paper) return;
    const out = {
      paper: { id: this.paper.id, title: this.paper.meta.title },
      exportedAt: new Date().toISOString(),
      notes: this.notes,
    };
    download(
      `${this.paper.id}-crawler-notes.json`,
      JSON.stringify(out, null, 2),
      "application/json",
    );
  }
}

/** 45000000 ms -> "12h 30m" (used for the quota reset countdown). */
function humanTime(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s / 60) + "m";
  return Math.floor(s / 3600) + "h " + Math.floor((s % 3600) / 60) + "m";
}

/** First word span inside a selection Range (the spider walks there). */
function firstWord(range) {
  let n = range.startContainer;
  let el = n.nodeType === 1 ? n : n.parentElement;
  let hit = el && el.closest(".w");
  if (hit) return hit;
  const root =
    range.commonAncestorContainer.nodeType === 1
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
  for (const w of root.querySelectorAll(".w"))
    if (range.intersectsNode(w)) return w;
  return null;
}

function download(name, text, mime) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(
    new Blob([text], { type: mime + ";charset=utf-8" }),
  );
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
