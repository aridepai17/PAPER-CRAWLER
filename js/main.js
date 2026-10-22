/**
 * main.js - wires loader + crawler + analyst + library together and handles the keyboard.
 *
 *   Space pause · F camera follow · T title caption · 1/2/3 markup intensity
 *   B/S/R explanation level · E explain selection · C clear markup · D re-drop spider
 *   L library (papers + table of contents) · ? keyboard help
 *   Mouse: move = spider chases the cursor · click = send it there
 *   ?debug = IK skeleton, foot targets, step thresholds, FPS, window.__crawler
 *
 * The app remembers where you were: the last paper, the reading level and the
 * scroll position are kept in localStorage, so opening the app drops you back
 * into the section you were reading.
 */
import { listPapers, loadPaper, setTitleOverlay } from "./loader.js";
import { Crawler } from "./crawler.js";
import { Analyst, toast } from "./analyst.js";
import { Library } from "./library.js";

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const STATE_KEY = "pc.state";

const crawler = new Crawler($("#spider"), { debug: params.has("debug") });
const analyst = new Analyst(crawler);
const library = new Library({
  onOpenPaper: (id) => openPaper(id),
  onGoSection: (sec) => crawler.goToSection(sec),
});
let paper = null;
let titleOn = false;
let state = loadState();

if (params.has("debug")) {
  // handy from the console: window.__analyst.queue / .results / .busy
  window.__analyst = analyst;
}

/* ------------------------------------------------------------------ state */
function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STATE_KEY) || "{}");
    return s && typeof s === "object" ? s : {};
  } catch (_) {
    return {};
  }
}

function saveState(patch = {}) {
  state = { ...state, ...patch };
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch (_) {
    /* private mode: no persistence, no problem */
  }
}

/** Load a paper, hand it to the spider and the explainer, then drop the spider onto it. */
async function openPaper(id, opts = {}) {
  crawler.mode = "idle";
  crawler.vm.visible = false;
  if (paper) paper.dispose();
  window.scrollTo(0, 0);
  try {
    paper = await loadPaper(id);
  } catch (e) {
    $("#paper-title").textContent = "Could not load “" + id + "”";
    $("#paper-body").textContent = e.message;
    return;
  }
  crawler.attach(paper);
  analyst.attach(paper);
  // two frames: let fonts/images settle so heading positions are right before we drop
  await new Promise((r) =>
    requestAnimationFrame(() => requestAnimationFrame(r)),
  );
  paper.refreshLayout();
  library.setCurrent(id);
  library.setOutline(paper.sections);

  if (opts.level) analyst.setLevel(opts.level);

  if (opts.resume) {
    // Come back to where the reader was: the same scroll position, and the
    // spider dropped into the section that was on screen.
    const y = Math.max(0, opts.scrollY || 0);
    window.scrollTo(0, y);
    paper.refreshLayout();
    const sec =
      paper.sections.find((s) => s.id === opts.sectionId) ||
      paper.sectionAt(y) ||
      paper.sections[0];
    crawler.drop(sec, { keepScroll: true, scrollY: y });
    saveState({ paperId: id, level: analyst.level, scrollY: y });
  } else {
    crawler.drop();
    saveState({ paperId: id, level: analyst.level, scrollY: 0 });
  }
  setUrl(id, analyst.level);
}

/** The URL is the shareable truth about which paper you are reading. */
function setUrl(id, level) {
  const u = new URL(location.href);
  u.searchParams.set("paper", id);
  if (level) u.searchParams.set("level", level);
  history.replaceState(null, "", u);
}

/* ------------------------------------------------------------------- init */
const LEVELS_OK = (l) => ["beginner", "student", "researcher"].includes(l);

async function init() {
  const papers = await listPapers();
  if (!papers.length) {
    $("#paper-title").textContent = "No papers yet";
    const d = document.createElement("div");
    d.className = "empty-state";
    d.append(
      "Add one from the library (press ",
      Object.assign(document.createElement("kbd"), { textContent: "L" }),
      "), or download it from a terminal: ",
      Object.assign(document.createElement("code"), {
        textContent: "python fetch_paper.py 1706.03762",
      }),
    );
    $("#paper-body").append(d);
    library.show();
    return;
  }
  const want = params.get("paper");
  const saved = state.paperId;
  const id = [want, saved, "1706.03762", papers[0].id].find(
    (p) => p && papers.some((x) => x.id === p),
  );
  const level = params.get("level") || state.level || "student";
  const resume =
    !want && saved === id && papers.some((p) => p.id === id) ? state : null;
  await openPaper(id, {
    level: LEVELS_OK(level) ? level : "student",
    resume: resume && typeof resume.scrollY === "number",
    scrollY: resume ? resume.scrollY : 0,
    sectionId: resume ? resume.sectionId : null,
  });
}

/* ------------------------------------------------------------ controls */
const setOn = (el, on) => el.classList.toggle("on", !!on);
function setIntensity(n) {
  crawler.setIntensity(n);
  document
    .querySelectorAll("#intensity button")
    .forEach((b) => setOn(b, b.dataset.i === n));
  toast("Markup: " + n);
}
function togglePause() {
  $("#btn-pause").textContent = crawler.togglePause() ? "▶" : "⏸";
}
function toggleFollow() {
  const on = crawler.toggleFollow();
  setOn($("#btn-follow"), on);
  toast("Camera follow " + (on ? "on" : "off"));
}
function toggleTitle() {
  titleOn = setTitleOverlay(!titleOn);
  setOn($("#btn-title"), titleOn);
}
function setLevel(level) {
  analyst.setLevel(level);
  if (analyst.level !== level) return;
  saveState({ level });
  if (paper) setUrl(paper.id, level);
}
function toggleHelp() {
  const h = $("#help");
  h.hidden = !h.hidden;
}

document
  .querySelectorAll("#intensity button")
  .forEach((b) => b.addEventListener("click", () => setIntensity(b.dataset.i)));
$("#btn-pause").addEventListener("click", togglePause);
$("#btn-follow").addEventListener("click", toggleFollow);
$("#btn-drop").addEventListener("click", () => crawler.drop());
$("#btn-clear").addEventListener("click", () => crawler.clearMarkup());
$("#btn-title").addEventListener("click", toggleTitle);
$("#btn-library").addEventListener("click", () => library.toggle());
$("#btn-help").addEventListener("click", toggleHelp);
$("#help-close").addEventListener("click", toggleHelp);
$("#help").addEventListener("click", (e) => {
  if (e.target.id === "help") toggleHelp();
});

/* ------------------------------------------------------------- remember me */
let scrollT = 0;
addEventListener(
  "scroll",
  () => {
    if (scrollT) return;
    scrollT = setTimeout(() => {
      scrollT = 0;
      if (paper) saveState({ scrollY: window.scrollY });
    }, 700);
  },
  { passive: true },
);

// The spider tells us which section it is standing in -> remember it.
crawler.on("section", (sec) => {
  if (!paper || !sec) return;
  saveState({ sectionId: sec.id, scrollY: window.scrollY });
});

addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
  if (e.key === "Escape") {
    if (!$("#help").hidden) toggleHelp();
    else if (library.open) library.close();
    return;
  }
  switch (e.key.toLowerCase()) {
    case " ":
      e.preventDefault();
      togglePause();
      break;
    case "f":
      toggleFollow();
      break;
    case "t":
      toggleTitle();
      break;
    case "l":
      library.toggle();
      break;
    case "?":
      toggleHelp();
      break;
    case "1":
      setIntensity("calm");
      break;
    case "2":
      setIntensity("normal");
      break;
    case "3":
      setIntensity("wild");
      break;
    case "b":
      setLevel("beginner");
      break;
    case "s":
      setLevel("student");
      break;
    case "r":
      setLevel("researcher");
      break;
    case "e":
      analyst.explainSelection();
      break;
    case "c":
      crawler.clearMarkup();
      toast("Markup cleared");
      break;
    case "d":
      crawler.drop();
      break;
  }
});

init();
