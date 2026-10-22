/**
 * crawler.js - the spider's brain.
 *
 * READ THIS FIRST (the whole thing in 8 bullets, handy for explaining on camera):
 *
 *  1. PAGE SPACE. Everything is simulated in page coordinates (x, y from the top
 *     of the document). The canvas just subtracts the scroll offset when drawing,
 *     so the spider rides along with the paper when it scrolls.
 *  2. BODY. A point with a velocity and a heading. It steers toward a goal
 *     (reading frontier / mouse / click / AI "KEY" phrase) with smooth acceleration.
 *  3. LEGS = TWO-BONE IK. Each leg has a hip (fixed to the body), a foot (planted on
 *     the page) and two bones (femur, tibia). Given hip + foot we solve for the knee
 *     with the law of cosines  -> solveIK().
 *  4. GAIT = ALTERNATING TETRAPOD. Legs are split into two groups of four
 *     (L1,R2,L3,R4) and (R1,L2,R3,L4). One group swings while the other holds the
 *     body up. A foot steps when it drifts too far from its "rest pose" (where it
 *     would naturally sit under the body), or at once if it is over-extended.
 *  5. FEET LAND ON WORDS. A step's target is the rest pose; we snap it to the nearest
 *     <span class="w"> using document.elementFromPoint. While planted, the foot
 *     tracks its word (if the text reflows away, it lets go and re-steps).
 *  6. MARKUP. Every plant may annotate the word (highlights, boxes, blow-ups...).
 *     Words that look important (metrics, model/dataset names, citations,
 *     claims) are ~3x more likely to get the dramatic effects.
 *  7. FRAME DISCIPLINE. Each frame: READ (scroll, rects, elementFromPoint)
 *     -> update() -> draw() -> commit(). update()/draw() NEVER write to the DOM;
 *     writes are queued in this.q and applied once in commit(). No layout thrashing.
 *  8. CAMERA. Follows the spider down the paper; manual scrolling pauses it 2.5 s;
 *     it stops at References.
 */
import { SpiderRenderer } from "./spider-draw.js";
import { TEXT_BLOCKS } from "./loader.js";

/* ============================================================== helpers */
const TAU = Math.PI * 2;
const HALF_PI = Math.PI / 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];
const easeInOut = (t) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const easeOutBack = (t) => {
  const c1 = 1.70158,
    c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};
function angDiff(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

/** 1-D value noise in [-1, 1]: smooth random wobble for the wandering. */
const _perm = Float32Array.from({ length: 256 }, () => Math.random());
function noise1(x) {
  const i = Math.floor(x),
    f = x - i,
    u = f * f * (3 - 2 * f);
  const a = _perm[i & 255],
    b = _perm[(i + 1) & 255];
  return (a + (b - a) * u) * 2 - 1;
}

/* ============================================================== tunables */
const FEMUR = 50,
  TIBIA = 64; // bone lengths at scale 1 (px). Reach = 114.
const STEP_THRESHOLD = 30; // foot may drift this far from rest before stepping
const CRUISE = 105,
  SPRINT = 270; // body speeds (px/s)
const READ_SPEED = 30; // how fast the reading frontier moves down the page (px/s)
const THREAD_SNAP = 640; // thread snaps after the spider has walked this far
const BLOCK_SEL = TEXT_BLOCKS + ", li, td, th";

/** Leg layout in the body's local frame (forward = +f, right = +r), px at scale 1.
 *  hf: where the hip sits along the body.  rf/rr: where the foot rests (forward/sideways). */
const LEG_DEFS = [
  // index 0..3 = left legs L1..L4, 4..7 = right legs R1..R4
  { name: "L1", side: -1, hf: 10, rf: 66, rr: 62, front: true },
  { name: "L2", side: -1, hf: 4, rf: 30, rr: 86, front: true },
  { name: "L3", side: -1, hf: -4, rf: -22, rr: 86, front: false },
  { name: "L4", side: -1, hf: -11, rf: -68, rr: 64, front: false },
  { name: "R1", side: 1, hf: 10, rf: 66, rr: 62, front: true },
  { name: "R2", side: 1, hf: 4, rf: 30, rr: 86, front: true },
  { name: "R3", side: 1, hf: -4, rf: -22, rr: 86, front: false },
  { name: "R4", side: 1, hf: -11, rf: -68, rr: 64, front: false },
];
/** Alternating tetrapod: group A = L1,R2,L3,R4 (indices 0,5,2,7). Everything else is group B. */
const GROUP_A = new Set([0, 5, 2, 7]);

/** Probe offsets (px) used to find a word near a foot target. */
const PROBES = [
  [0, 0],
  [16, 0],
  [-16, 0],
  [0, 13],
  [0, -13],
  [30, 0],
  [-30, 0],
  [0, 26],
  [0, -26],
];

/** Markup intensity presets (key: 1/2/3). */
const INTENSITY = {
  calm: {
    apply: 0.22,
    smart: 0.8,
    near: 0.05,
    line: 0.015,
    dramatic: 0.5,
    extra: 0.05,
  },
  normal: {
    apply: 0.42,
    smart: 0.95,
    near: 0.14,
    line: 0.04,
    dramatic: 1.0,
    extra: 0.15,
  },
  wild: {
    apply: 0.8,
    smart: 1.0,
    near: 0.35,
    line: 0.1,
    dramatic: 1.6,
    extra: 0.4,
  },
};

/* ======================================================= two-bone IK ======
 * Given the hip H, the foot target F, and bone lengths l1 (femur), l2 (tibia),
 * the knee K must be l1 from H and l2 from F. That's a triangle with known sides
 * (l1, l2, d = |HF|), so the law of cosines gives the angle at the hip:
 *        cos(theta) = (l1^2 + d^2 - l2^2) / (2 * l1 * d)
 * The knee's distance ALONG the hip->foot line is a = l1*cos(theta), and its distance
 * OFF the line is h = sqrt(l1^2 - a^2). Which side of the line it bends to is the
 * `sign` (+1 / -1), fixed per leg so a knee never flips mid-walk.
 * If the target is out of reach we clamp d, so the leg just stretches straight.
 * Output goes into `out` (kx,ky = knee; ex,ey = where the foot really ends). */
export function solveIK(hx, hy, tx, ty, l1, l2, sign, out) {
  let dx = tx - hx,
    dy = ty - hy;
  let d = Math.hypot(dx, dy);
  if (d < 1e-4) {
    dx = 1;
    dy = 0;
    d = 1e-4;
  }
  const ux = dx / d,
    uy = dy / d;
  const dc = clamp(d, Math.abs(l1 - l2) + 0.01, l1 + l2 - 0.01);
  const a = (l1 * l1 - l2 * l2 + dc * dc) / (2 * dc);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  // perpendicular to (ux,uy) is (-uy, ux)
  out.kx = hx + ux * a - uy * h * sign;
  out.ky = hy + uy * a + ux * h * sign;
  out.ex = hx + ux * dc;
  out.ey = hy + uy * dc;
  return out;
}

/* ================================================= "what is this word?" ===
 * Smart targeting. classify() looks at a word span and says which category it is.
 * Categories: heading | cite | eq | metric | dataset | claim | model | plain */
const DATASETS = new Set(
  (
    "imagenet coco glue superglue mmlu squad wmt cifar cifar-10 cifar-100 mnist wikitext lambada humaneval " +
    "gsm8k c4 laion treebank ptb librispeech cityscapes ade20k kinetics imdb snli mnli boolq hellaswag winogrande triviaqa " +
    "openwebtext bookcorpus commoncrawl pascal celeba"
  ).split(" "),
);
const MODEL_WORDS = new Set(
  (
    "transformer transformers bert gpt resnet lstm gru cnn rnn vit clip lora t5 llama gan vae unet " +
    "seq2seq word2vec glove elmo roberta xlnet albert distilbert mamba rwkv"
  ).split(" "),
);
const CAPS_STOP = new Set(
  (
    "THE AND FOR WITH OF IN TO ON A I II III IV V VI VII VIII IX X NOTE PDF URL ID USA UK TABLE FIGURE " +
    "SECTION ABSTRACT APPENDIX REFERENCES INTRODUCTION CONCLUSION AS OR IS IF"
  ).split(" "),
);
const UNIT =
  /^(bleu|f1|accuracy|acc|ppl|rouge|top-?[15]|em|mrr|ndcg|wer|fid|psnr|ssim|mAP|auc|points?|pp|percent)$/i;
const RE_CITE_YEAR = /^\(?(19|20)\d\d[a-z]?\)[.,;:]?$/;
const RE_CITE_NUM = /^\[\d+(?:[,\u2013\u2014-]\s?\d+)*\][.,;:]?$/;
const RE_EQNO = /^\(\d+(?:\.\d+)?\)[.,;:]?$/;
const RE_CLAIM =
  /^(propose[sd]?|introduce[sd]?|outperform(?:s|ed)?|novel|surpass(?:es|ed)?|achiev(?:e|es|ed)|significantly)$/i;
const strip = (s) => s.replace(/^[(\[“"'‘]+|[)\].,;:”"'’]+$/g, "");

export function classify(el) {
  const raw = el.textContent || "";
  const t = strip(raw);
  if (!t) return { cat: "plain", text: raw };
  if (el.closest("h1,h2,h3,h4,.ltx_title")) return { cat: "heading", text: t };
  if (
    el.closest("cite,.ltx_cite") ||
    RE_CITE_NUM.test(raw) ||
    RE_CITE_YEAR.test(raw)
  )
    return { cat: "cite", text: t };
  if (RE_EQNO.test(raw) || el.closest(".ltx_tag_equation,.ltx_eqn_eqno"))
    return { cat: "eq", text: raw };

  const nx = el.nextElementSibling,
    pv = el.previousElementSibling;
  const next = nx && nx.classList.contains("w") ? strip(nx.textContent) : "";
  const prev = pv && pv.classList.contains("w") ? strip(pv.textContent) : "";
  const isNum = (s) => /^[+\-−±]?\d+(?:[.,]\d+)?%?$/.test(s);

  // metrics & results: "92.1%", "+3.2", "28.4 BLEU", "3.2x", "state-of-the-art"
  if (
    /^\d+(?:\.\d+)?%$/.test(t) ||
    /^[+\-−±]\d/.test(t) ||
    /^\d+(?:\.\d+)?[x×]$/i.test(t)
  )
    return { cat: "metric", text: t };
  if (isNum(t) && UNIT.test(next))
    return { cat: "metric", text: `${t} ${next}` };
  if (UNIT.test(t) && isNum(prev))
    return { cat: "metric", text: `${prev} ${t}` };
  if (/^(state-of-the-art|sota)$/i.test(t)) return { cat: "metric", text: t };

  if (DATASETS.has(t.toLowerCase())) return { cat: "dataset", text: t };
  if (
    RE_CLAIM.test(t) ||
    (t.toLowerCase() === "results" && prev.toLowerCase() === "our")
  )
    return { cat: "claim", text: t };
  if (
    MODEL_WORDS.has(t.toLowerCase()) ||
    /^[A-Z][a-z]+\d?[A-Z][A-Za-z0-9]*$/.test(t) || // CamelCase: ResNet, LoRA
    (/^[A-Z]{2,}[A-Z0-9-]*$/.test(t) && !CAPS_STOP.has(t)) || // ALL-CAPS: BERT, GPT-3
    /^[A-Z]{2,}-?\d/.test(t)
  )
    return { cat: "model", text: t };
  return { cat: "plain", text: t };
}

/* ======================================================== markup effects ==
 * Each effect = one or more CSS classes (see css/style.css, section 6).
 * g = exclusive group (a word has at most one of each): fill | box | fx
 * w = base weight per word category; `dramatic` effects get x3 for smart categories. */
const FILL_CLS = [
  "m-hl-orange",
  "m-hl-purple",
  "m-hl-magenta",
  "m-hl-cyan",
  "m-hl-green",
  "m-big",
  "m-wide",
];
const BOX_CLS = [
  "m-box-teal",
  "m-box-purple",
  "m-box-orange",
  "m-box-red",
  "m-box-green",
];
const FX_CLS = [
  "m-blowup",
  "m-s2",
  "m-s3",
  "m-red",
  "m-rotate-green",
  "m-color-text",
  "m-c1",
  "m-c2",
  "m-c3",
  "m-c4",
  "m-c5",
];
const GROUP_CLS = { fill: FILL_CLS, box: BOX_CLS, fx: FX_CLS };

const EFFECTS = [
  {
    id: "hl-orange",
    g: "fill",
    cls: ["m-hl-orange"],
    dramatic: true,
    w: {
      plain: 0.7,
      metric: 2.5,
      model: 2,
      dataset: 1.2,
      cite: 0.6,
      eq: 1,
      claim: 3.5,
    },
  },
  {
    id: "hl-orange-big",
    g: "fill",
    cls: ["m-hl-orange", "m-big"],
    dramatic: true,
    w: { plain: 0, metric: 0.8, model: 0.5, claim: 1.4, eq: 0.5 },
  },
  {
    id: "hl-magenta",
    g: "fill",
    cls: ["m-hl-magenta"],
    dramatic: true,
    w: {
      plain: 0.5,
      metric: 0.8,
      model: 3,
      dataset: 1.5,
      cite: 0.3,
      claim: 0.8,
    },
  },
  {
    id: "hl-magenta-wide",
    g: "fill",
    cls: ["m-hl-magenta", "m-wide"],
    dramatic: true,
    w: { plain: 0.2, model: 1.6, dataset: 0.8, claim: 0.6 },
  },
  {
    id: "hl-green",
    g: "fill",
    cls: ["m-hl-green"],
    dramatic: false,
    w: {
      plain: 2.2,
      metric: 0.5,
      model: 0.6,
      dataset: 2.5,
      cite: 1.5,
      claim: 1,
      eq: 0.3,
    },
  },
  {
    id: "hl-purple",
    g: "fill",
    cls: ["m-hl-purple"],
    dramatic: true,
    w: { plain: 0.2, model: 0.6, dataset: 0.6, cite: 0.2 },
  },
  {
    id: "hl-cyan",
    g: "fill",
    cls: ["m-hl-cyan"],
    dramatic: false,
    w: { plain: 0.4, dataset: 1.2 },
  },
  {
    id: "box-teal",
    g: "box",
    cls: ["m-box-teal"],
    dramatic: false,
    w: {
      plain: 2,
      metric: 1,
      model: 1.5,
      dataset: 1.5,
      cite: 2.5,
      eq: 1,
      claim: 0.7,
    },
  },
  {
    id: "box-purple",
    g: "box",
    cls: ["m-box-purple"],
    dramatic: false,
    w: { plain: 1.6, model: 2, dataset: 1, cite: 3, eq: 1, claim: 0.7 },
  },
  {
    id: "box-orange",
    g: "box",
    cls: ["m-box-orange"],
    dramatic: true,
    w: { plain: 0.8, metric: 2.5, model: 1.5, dataset: 1, claim: 1.5, eq: 2 },
  },
  {
    id: "box-red",
    g: "box",
    cls: ["m-box-red"],
    dramatic: true,
    w: { plain: 0.5, metric: 2, eq: 3, claim: 1, cite: 0.5 },
  },
  {
    id: "box-green",
    g: "box",
    cls: ["m-box-green"],
    dramatic: false,
    w: { plain: 1.6, dataset: 2.5, cite: 1, model: 0.6 },
  },
  {
    id: "blowup",
    g: "fx",
    cls: ["m-blowup"],
    need: "digit",
    dramatic: true,
    w: { metric: 4, eq: 2, model: 0.4 },
  },
  {
    id: "rotate",
    g: "fx",
    cls: ["m-rotate-green"],
    phrase: true,
    dramatic: true,
    w: { claim: 2, plain: 0.15, model: 0.6, dataset: 0.3 },
  },
  {
    id: "color",
    g: "fx",
    cls: ["m-color-text"],
    dramatic: false,
    w: {
      plain: 2.4,
      cite: 1.5,
      model: 1,
      dataset: 1,
      claim: 0.7,
      metric: 0.6,
      eq: 0.5,
    },
  },
];

/* =================================================================== Crawler */
export class Crawler {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.renderer = new SpiderRenderer(canvas);
    this.debug = !!opts.debug;
    this.handlers = {};
    this.paper = null;

    // user-facing settings
    this.paused = false;
    this.follow = true;
    this.intensity = "normal";

    // clocks: `now` = real seconds (always runs), `time` = simulation seconds (stops when paused)
    this.now = 0;
    this.last = 0;
    this.time = 0;
    this.frame = 0;
    this.modeT = 0;

    // viewport + camera
    this.W = innerWidth;
    this.H = innerHeight;
    this.S = 1; // spider scale (bigger screen => bigger spider)
    this.sy = 0; // ACTUAL window.scrollY, read at the start of each frame
    this.camY = 0; // where we want the page to be (float, can be sub-pixel)
    this.view = { x: 0, y: 0 }; // offset used for drawing this frame
    this.maxScroll = 1e6;
    this.manualUntil = 0; // real-time until which manual scrolling overrides the camera
    this.pendingScroll = null;

    // the spider
    this.body = { x: 0, y: -300, vx: 0, vy: 0, ang: HALF_PI };
    this.speed = 0;
    this.legScale = 0.28;
    this.maxOver = 0; // most-stretched planted leg (0..1), used to slow the body
    this.lastGroup = 1;
    this.stepGroup = 0;
    this.thr = STEP_THRESHOLD;
    this.spin = { x: 0, y: 0 }; // spinneret (abdomen tip) in page space
    this.legs = LEG_DEFS.map((def, i) => ({
      def,
      name: def.name,
      i,
      // forward-bending knees on the front pair, backward on the rear pair; mirrored per side
      sign: (def.front ? 1 : -1) * (def.side < 0 ? 1 : -1),
      hx: 0,
      hy: 0,
      kx: 0,
      ky: 0,
      ex: 0,
      ey: 0, // hip / knee / actual foot end (for drawing)
      fx: 0,
      fy: 0, // foot position (planted or mid-swing)
      rx: 0,
      ry: 0, // rest pose
      ox: 0,
      oy: 0,
      tx: 0,
      ty: 0,
      tel: null,
      tcx: 0,
      tcy: 0, // step origin / target
      t: 0,
      dur: 0.15,
      stepping: false,
      lift: 0,
      pulse: 0,
      anchor: null,
      released: false,
      dist: 0,
      over: 0,
    }));

    // behaviour state machine: idle | drop | land | roam | goto
    this.mode = "idle";
    this.dropInfo = null;
    this.thread = null;
    this.target = null; // explicit goto target
    this.pendingTarget = null;
    this.frontier = 0; // reading frontier (page y)
    this.pauseUntil = 0;
    this.nextPause = 0;
    this.tapT = 0;
    this.mouse = { x: 0, y: 0, t: -99, on: false };
    this.silk = [];
    this.curSec = null;
    this.secCand = null;
    this.secT = 0;

    // DOM write queue + bookkeeping (see commit())
    this.q = [];
    this.touched = new Set(); // every word we marked (so C can clear them)
    this.wrappers = new Set(); // .m-phrase wrappers we created
    this.walked = new Set(); // paragraphs the spider stood on (priority for the AI)
    this.notesSeen = new Set();

    // the object handed to the renderer each frame (mutated in place, no per-frame allocation)
    this.vm = {
      visible: false,
      view: this.view,
      S: 1,
      time: 0,
      body: this.body,
      legs: this.legs,
      thread: null,
      spin: this.spin,
      silk: this.silk,
      debug: this.debug,
      calm: false, // set from prefers-reduced-motion (no idle jitter / breathing)
      thr: STEP_THRESHOLD,
      mode: "idle",
      group: 0,
      moving: false,
    };

    this.fps = { frames: 0, t: 0, el: null };
    if (this.debug) {
      window.__crawler = this;
      this.fps.el = document.createElement("div");
      this.fps.el.id = "fps";
      document.body.append(this.fps.el);
    }

    this.onResize();
    addEventListener("resize", () => this.onResize());
    // Respect the OS "reduce motion" setting: the spider still walks, but it
    // stops breathing and twitching.
    const calm = matchMedia("(prefers-reduced-motion: reduce)");
    this.vm.calm = calm.matches;
    calm.addEventListener?.("change", (e) => (this.vm.calm = e.matches));
    this.bindInput();
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  /* ----------------------------------------------------------- events */
  on(name, fn) {
    (this.handlers[name] ||= []).push(fn);
    return this;
  }
  emit(name, arg) {
    for (const fn of this.handlers[name] || []) fn(arg);
  }

  /* ----------------------------------------------------------- public API */
  attach(paper) {
    this.paper = paper;
    paper.autoFlush = false; // we flush lazy word-wrapping in commit()
    this.q.length = 0;
    this.touched.clear();
    this.wrappers.clear();
    this.walked.clear();
    this.notesSeen.clear();
    this.curSec = this.secCand = null;
    this.silk.length = 0;
    this.mode = "idle";
    this.vm.visible = false;
  }
  setIntensity(name) {
    if (INTENSITY[name]) this.intensity = name;
    return this.intensity;
  }
  togglePause() {
    return (this.paused = !this.paused);
  }
  toggleFollow() {
    return (this.follow = !this.follow);
  }
  clearMarkup() {
    this.q.push({ k: "clear" });
  }

  /**
   * Drop the spider on a silk thread from above the viewport (also the `D` key).
   * With a section, it lands in that section and the window scrolls there.
   * opts.keepScroll: don't move the window (used when resuming a session).
   */
  drop(section = null, opts = {}) {
    const P = this.paper;
    if (!P) return;
    const S = this.S,
      b = P.bounds;
    const curSy = window.scrollY; // where the page is right now
    const sec = section && section.headingEl ? section : null;
    // The landing spot: the section's first block (or its heading).
    const anchor = sec
      ? sec.blocks[0] || sec.headingEl
      : P.sections[0] && P.sections[0].blocks[0];
    const absY = anchor ? anchor.getBoundingClientRect().top + curSy : 260;
    // Where the window should be when the spider lands.
    let scrollTo = 0;
    if (sec)
      scrollTo = opts.keepScroll
        ? (opts.scrollY ?? curSy)
        : Math.max(0, absY - 140);
    this.pendingScroll = scrollTo;
    this.camY = scrollTo;
    this.view.y = this.camY;
    // The anchor's distance below the top of the viewport, and the landing spot.
    // The landing is clamped into the viewport: the spider always lands where
    // you can see it, even when the section starts above the current scroll.
    const viewY = absY - this.camY;
    const landY = opts.keepScroll
      ? this.camY + 0.12 * this.H
      : this.camY + clamp(viewY + 46, 0.12 * this.H, 0.62 * this.H);
    const tx = b.cx + rand(-50, 50);
    this.dropInfo = { t: 0, tx, landY };
    Object.assign(this.body, {
      x: tx,
      y: this.camY - 170 * S,
      vx: 0,
      vy: 0,
      ang: HALF_PI,
    });
    this.thread = {
      alive: true,
      walked: 0,
      topX: tx,
      topY: -24,
      freeX: 0,
      freeY: 0,
      curl: 0,
      fade: 0,
    };
    this.vm.thread = this.thread;
    this.legScale = 0.28;
    this.silk.length = 0;
    for (const l of this.legs) {
      l.stepping = false;
      l.anchor = null;
      l.released = false;
      l.lift = 0;
      l.fx = this.body.x;
      l.fy = this.body.y;
    }
    this.frontier = landY;
    this.setMode("drop");
    this.vm.visible = true;
  }

  /** Send the spider to a section (the table of contents in the library). */
  goToSection(sec) {
    const P = this.paper;
    if (!P || !sec) return false;
    const el = sec.headingEl;
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const y = r.top + scrollY + 30; // just below the heading
    const x = clamp(
      r.left + r.width / 2,
      P.bounds.left + 24,
      P.bounds.right - 24,
    );
    this.goTo(x, y, { dwell: 1.4, setFrontier: "set", maxT: 30 });
    return true;
  }

  /** Send the spider somewhere (page coords). cb runs when it arrives. */
  goTo(x, y, opts = {}) {
    const t = {
      x,
      y,
      dwell: opts.dwell ?? 1.6,
      cb: opts.cb,
      front: opts.setFrontier || "set",
      maxT: opts.maxT ?? 9,
      arrived: false,
      dwellT: 0,
    };
    if (this.mode === "drop" || this.mode === "land" || this.mode === "idle") {
      this.pendingTarget = t;
      return;
    }
    this.target = t;
    this.setMode("goto");
  }

  /** Walk to a list of word spans (the AI's KEY phrase / the user's selection). */
  pointAt(spans, opts = {}) {
    if (!spans || !spans.length) return false;
    const r = spans[0].getBoundingClientRect();
    const x = r.left + r.width / 2 + scrollX,
      y = r.top + r.height / 2 + scrollY;
    this.goTo(x, y, {
      dwell: opts.dwell ?? 2.6,
      setFrontier: opts.setFrontier || "max",
      cb: () => {
        if (opts.mark !== false) this.q.push({ k: "key", spans });
        if (opts.onArrive) opts.onArrive();
      },
    });
    return true;
  }

  setMode(m) {
    this.mode = m;
    this.modeT = 0;
  }

  /* ----------------------------------------------------------- input */
  bindInput() {
    // Clicks and pointer moves inside the app's own UI never steer the spider.
    const inUI = (e) =>
      e.target &&
      e.target.closest &&
      e.target.closest("#analyst, #toolbar, #library, #help, #toast");
    addEventListener(
      "pointermove",
      (e) => {
        if (inUI(e)) {
          this.mouse.on = false;
          return;
        }
        Object.assign(this.mouse, {
          x: e.clientX,
          y: e.clientY,
          t: this.time,
          on: true,
        });
      },
      { passive: true },
    );
    addEventListener("click", (e) => {
      if (inUI(e) || e.target.closest("a, button, select, input")) return;
      if (String(getSelection()).trim()) return; // user is selecting text, not steering
      this.goTo(e.clientX + scrollX, e.clientY + scrollY, {
        dwell: 1.8,
        setFrontier: "set",
      });
    });
    const manual = () => {
      this.manualUntil = performance.now() / 1000 + 2.5;
    };
    addEventListener("wheel", manual, { passive: true });
    addEventListener("touchmove", manual, { passive: true });
    addEventListener("keydown", (e) => {
      // typing in the library's search box must not scroll the paper
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName))
        return;
      if (
        ["PageDown", "PageUp", "ArrowDown", "ArrowUp", "Home", "End"].includes(
          e.key,
        )
      )
        manual();
    });
  }

  onResize() {
    this.W = innerWidth;
    this.H = innerHeight;
    this.S = clamp(Math.min(this.W, this.H * 1.25) / 1000, 0.62, 1.15);
    this.renderer.resize();
    if (this.paper) this.paper.layoutDirty = true;
  }

  /* ================================================================ LOOP ==
   * READ -> update -> draw -> commit. Only commit() writes to the DOM. */
  loop(ts) {
    requestAnimationFrame(this.loop);
    this.now = ts / 1000;
    const dt = Math.min(0.05, this.now - (this.last || this.now));
    this.last = this.now;
    this.frame++;

    this.readPhase();
    if (this.paper && !this.paused && this.mode !== "idle") this.update(dt);
    this.draw();
    this.commit();

    if (this.fps.el) {
      this.fps.frames++;
      if (this.now - this.fps.t > 0.5) {
        this.fps.el.textContent = `${Math.round(this.fps.frames / (this.now - this.fps.t))} fps · mode ${this.mode} · ${this.touched.size} marked`;
        this.fps.frames = 0;
        this.fps.t = this.now;
      }
    }
  }

  /** READ phase: the only place (besides update's probes) that touches layout. */
  readPhase() {
    this.sy = window.scrollY;
    // Someone else scrolled (wheel, scrollbar, keys)? Then the camera backs off for 2.5s.
    if (Math.abs(this.sy - this.camY) > 2.5) {
      if (this.pendingScroll === null) this.manualUntil = this.now + 2.5;
      this.camY = this.sy;
    }
    this.view.y = this.camY;
    if (this.frame % 20 === 0)
      this.maxScroll = Math.max(
        0,
        document.documentElement.scrollHeight - this.H,
      );
    if (this.mode !== "idle" && this.paper && this.paper.layoutDirty)
      this.paper.refreshLayout();
  }

  /* ============================================================== UPDATE */
  update(dt) {
    this.time += dt;
    this.modeT += dt;
    const B = this.body,
      S = this.S,
      P = this.paper;

    switch (this.mode) {
      case "drop":
        this.updateDrop(dt);
        break;
      case "land": {
        // legs splay out (overshoot ease), body settles, then we start walking
        this.legScale = lerp(
          0.28,
          1,
          easeOutBack(clamp(this.modeT / 0.75, 0, 1)),
        );
        B.vx *= 0.9;
        B.vy *= 0.9;
        this.speed = 0;
        if (this.modeT > 1.15) {
          this.setMode("roam");
          this.pauseUntil = this.time + 1.4;
          this.nextPause = this.pauseUntil + rand(3, 6);
          if (this.pendingTarget) {
            this.target = this.pendingTarget;
            this.pendingTarget = null;
            this.setMode("goto");
          }
        }
        break;
      }
      case "goto":
        this.updateGoto(dt);
        break;
      default:
        this.updateRoam(dt);
    }

    this.updateLegs(dt);
    this.updateThread(dt);
    this.updateSilk(dt);
    if (this.mode !== "drop") this.trackSection(dt);
    this.updateCamera(dt);

    const vm = this.vm;
    vm.S = S;
    vm.time = this.time;
    vm.thr = this.thr;
    vm.mode = this.mode;
    vm.group = this.stepGroup;
    vm.moving = this.speed > 12;
  }

  /* ---- entrance: hang from a thread, swaying, legs tucked ---- */
  updateDrop(dt) {
    const d = this.dropInfo,
      B = this.body,
      S = this.S;
    d.t += dt;
    const remain = d.landY - B.y;
    const ease = Math.min(1, d.t / 0.9);
    const vy = Math.min(300 * S, 60 * S + Math.max(0, remain) * 2.2) * ease;
    B.y += vy * dt;
    const k = clamp(remain / 160, 0.12, 1); // sway calms as it lands
    B.x = d.tx + Math.sin(d.t * 1.7) * 16 * S * k;
    B.vx = 0;
    B.vy = vy;
    this.speed = vy;
    B.ang = HALF_PI + Math.sin(d.t * 1.7 + 1) * 0.1 * clamp(k, 0.15, 1); // head down, rear (spinneret) up
    this.legScale = 0.28;
    if (remain < 3) this.setMode("land");
  }

  /* ---- reading: noise-based wandering + a frontier that creeps down the page ---- */
  updateRoam(dt) {
    const B = this.body,
      S = this.S,
      b = this.paper.bounds,
      t = this.time;
    const halfW = (b.right - b.left) / 2;
    const sec = this.curSec;
    const inRefs = sec && sec.isRefs;
    const chasing = this.mouse.on && t - this.mouse.t < 1.2;

    let gx, gy, speed;
    if (chasing) {
      // chase the cursor: hover near it
      gx = clamp(this.mouse.x + scrollX, b.left - 60, b.right + 60);
      gy = this.mouse.y + this.sy;
      speed = 215 * S;
      this.frontier = B.y; // resume reading from wherever it ends up
    } else {
      // pauses to "read"
      if (t > this.nextPause && t >= this.pauseUntil) {
        this.pauseUntil = t + rand(0.9, 2.3);
        this.nextPause = this.pauseUntil + rand(3, 7);
      }
      const reading = t < this.pauseUntil;
      const lastY = this.paper.bounds.bottom - 160;
      if (
        !reading &&
        !inRefs &&
        Math.hypot(B.x - gx0(this), B.y - this.frontier) < 190 * S
      ) {
        this.frontier = Math.min(lastY, this.frontier + READ_SPEED * S * dt); // creep down the page
      }
      gx = gx0(this);
      gy = this.frontier + noise1(t * 0.31 + 17) * 42 * S;
      speed = reading ? CRUISE * S * 0.12 : CRUISE * S;
      // while "reading", tap nearby words with the front legs (that's what leaves marks)
      this.tapT -= dt;
      if (reading && this.tapT <= 0) {
        this.tapT = rand(0.22, 0.45);
        this.tap();
      }
    }
    this.moveBody(gx, gy, speed, dt);
    function gx0(c) {
      return (b.left + b.right) / 2 + noise1(c.time * 0.34) * halfW * 0.82;
    }
  }

  /* ---- go to an explicit target (click / AI KEY / selection) ---- */
  updateGoto(dt) {
    const T = this.target,
      S = this.S,
      B = this.body;
    if (!T) {
      this.setMode("roam");
      return;
    }
    if (!T.arrived) {
      // Long jumps (a section far down the paper) get a faster sprint, so the
      // reader does not wait a minute for the spider to cross the page.
      const dist = Math.hypot(T.x - B.x, T.y - B.y);
      this.moveBody(T.x, T.y, SPRINT * S * clamp(dist / 600, 1, 9), dt);
      if (
        Math.hypot(B.x - T.x, B.y - T.y) < 38 * S ||
        this.modeT > (T.maxT || 9)
      ) {
        T.arrived = true;
        T.dwellT = T.dwell;
        if (T.cb) T.cb(); // e.g. blow up the KEY phrase
      }
    } else {
      this.moveBody(T.x, T.y, 0, dt);
      this.tapT -= dt;
      if (this.tapT <= 0) {
        this.tapT = rand(0.25, 0.4);
        this.tap();
      }
      T.dwellT -= dt;
      if (T.dwellT <= 0) {
        this.frontier = T.front === "max" ? Math.max(this.frontier, T.y) : T.y;
        this.target = null;
        this.setMode("roam");
      }
    }
  }

  /** Steer the body toward (gx, gy). Velocity eases toward the desired velocity (smooth accel). */
  moveBody(gx, gy, speed, dt) {
    const B = this.body,
      S = this.S,
      b = this.paper.bounds;
    const dx = gx - B.x,
      dy = gy - B.y,
      d = Math.hypot(dx, dy) || 1;
    let sp = speed * clamp(d / (70 * S), 0, 1); // slow down on arrival
    sp *= 1 - 0.6 * clamp((this.maxOver - 0.86) / 0.12, 0, 1); // let the legs catch up
    const k = Math.min(1, dt * 5);
    B.vx += ((dx / d) * sp - B.vx) * k;
    B.vy += ((dy / d) * sp - B.vy) * k;
    B.x = clamp(B.x + B.vx * dt, b.left - 70, b.right + 70);
    B.y = clamp(B.y + B.vy * dt, 40, b.bottom);
    const v = Math.hypot(B.vx, B.vy);
    this.speed = v;
    if (v > 14 * S)
      B.ang +=
        angDiff(B.ang, Math.atan2(B.vy, B.vx)) *
        Math.min(1, dt * (5 + v / (60 * S)));
    else B.ang += noise1(this.time * 0.4) * dt * 0.35; // idle head-wobble
  }

  /* ============================================================== LEGS ====
   * 1. hips + rest poses follow the body
   * 2. decide which feet step (tetrapod groups)
   * 3. advance swinging feet; on touchdown: anchor to the word + markup
   * 4. track anchored words (scroll is free in page space; reflow needs a check)
   * 5. solve IK for every leg */
  updateLegs(dt) {
    const B = this.body,
      S = this.S,
      legs = this.legs;
    const fx = Math.cos(B.ang),
      fy = Math.sin(B.ang); // forward
    const rx = -fy,
      ry = fx; // right-hand side (y points down on screen)
    const l1 = FEMUR * S,
      l2 = TIBIA * S,
      reach = l1 + l2;
    const sc = this.legScale;
    const thr = STEP_THRESHOLD * S;
    this.thr = thr;
    const lead = 0.13; // land a little ahead of where the body is going

    this.spin.x = B.x - fx * 24 * S;
    this.spin.y = B.y - fy * 24 * S;

    const gaitOn =
      this.mode !== "drop" && !(this.mode === "land" && this.modeT < 0.3);
    let anyStep = false,
      needA = 0,
      needB = 0,
      maxOver = 0;

    for (const l of legs) {
      const d = l.def;
      l.hx = B.x + fx * d.hf * S + rx * d.side * 3.5 * S;
      l.hy = B.y + fy * d.hf * S + ry * d.side * 3.5 * S;
      l.rx =
        B.x + fx * d.rf * S * sc + rx * d.side * d.rr * S * sc + B.vx * lead;
      l.ry =
        B.y + fy * d.rf * S * sc + ry * d.side * d.rr * S * sc + B.vy * lead;
      if (l.stepping) anyStep = true;
      if (!gaitOn) {
        // hanging / splaying: feet just dangle after the rest pose
        const k = Math.min(1, dt * 9);
        l.fx += (l.rx - l.fx) * k;
        l.fy += (l.ry - l.fy) * k;
        continue;
      }
      l.dist = Math.hypot(l.fx - l.rx, l.fy - l.ry);
      l.over = Math.hypot(l.fx - l.hx, l.fy - l.hy) / reach;
      if (!l.stepping) {
        if (l.over > maxOver) maxOver = l.over;
        const ex = Math.max(0, l.dist - thr);
        if (GROUP_A.has(l.i)) needA += ex;
        else needB += ex;
      }
    }
    this.maxOver = maxOver;

    if (gaitOn) {
      // a) let go of reflowed words right away
      for (const l of legs) if (l.released && !l.stepping) this.startStep(l);
      if (!anyStep) {
        // b) nobody swinging: the group that needs it most goes (ties alternate)
        if (needA > 0 || needB > 0) {
          const g =
            needA === needB ? 1 - this.lastGroup : needA > needB ? 0 : 1;
          this.stepGroup = this.lastGroup = g;
          for (const l of legs)
            if (
              (GROUP_A.has(l.i) ? 0 : 1) === g &&
              l.dist > thr * 0.3 &&
              !l.stepping
            )
              this.startStep(l);
        }
      } else {
        for (const l of legs) {
          if (l.stepping) continue;
          if (l.over > 0.97)
            this.startStep(l); // emergency: over-extended
          else if (
            (GROUP_A.has(l.i) ? 0 : 1) === this.stepGroup &&
            l.dist > thr
          )
            this.startStep(l); // join the swing
        }
      }
    }

    // advance swinging legs
    for (const l of legs) {
      if (l.pulse > 0) l.pulse = Math.max(0, l.pulse - dt * 3.2);
      if (!l.stepping) continue;
      l.t += dt / l.dur;
      const t = Math.min(1, l.t),
        e = easeInOut(t);
      l.fx = lerp(l.ox, l.tx, e);
      l.fy = lerp(l.oy, l.ty, e);
      l.lift = Math.sin(t * Math.PI); // arc height (drawn as bigger foot dot)
      if (l.t >= 1) {
        l.stepping = false;
        l.lift = 0;
        l.fx = l.tx;
        l.fy = l.ty;
        l.pulse = 1;
        l.anchor = l.tel
          ? {
              el: l.tel,
              cx: l.tcx,
              cy: l.tcy,
              dx: l.tx - l.tcx,
              dy: l.ty - l.tcy,
            }
          : null;
        this.onPlant(l);
      }
    }

    // anchored-word tracking: check ONE leg per frame (8 legs -> each checked ~7x/sec)
    const tl = legs[this.frame & 7];
    if (!tl.stepping && tl.anchor) {
      const a = tl.anchor;
      if (!a.el.isConnected) {
        tl.anchor = null;
        tl.released = true;
      } else {
        const r = a.el.getBoundingClientRect();
        const cx = r.left + r.width / 2 + scrollX,
          cy = r.top + r.height / 2 + this.sy;
        const mx = cx - a.cx,
          my = cy - a.cy;
        if (Math.abs(mx) + Math.abs(my) > 1.5) {
          a.cx = cx;
          a.cy = cy;
          tl.fx = cx + a.dx;
          tl.fy = cy + a.dy; // glide with the word
          if (Math.hypot(mx, my) > 60) {
            tl.anchor = null;
            tl.released = true;
          } // reflowed away: re-step
        }
      }
    }

    // IK for all legs
    for (const l of legs) solveIK(l.hx, l.hy, l.fx, l.fy, l1, l2, l.sign, l);
  }

  /** Begin swinging a foot toward its rest pose (or an explicit target), snapped to a word. */
  startStep(l, tx, ty) {
    const goalX = tx ?? l.rx,
      goalY = ty ?? l.ry;
    const snap = this.snap(goalX, goalY);
    l.ox = l.fx;
    l.oy = l.fy;
    l.tx = snap.x;
    l.ty = snap.y;
    l.tel = snap.el;
    l.tcx = snap.cx;
    l.tcy = snap.cy;
    const fast = clamp(this.speed / (250 * this.S), 0, 1);
    l.dur = lerp(rand(0.15, 0.18), rand(0.12, 0.14), fast); // 120-180 ms
    l.t = 0;
    l.stepping = true;
    l.anchor = null;
    l.released = false;
  }

  /** While "reading", one front foot taps a nearby word. */
  tap() {
    const free = this.legs.filter(
      (l) => !l.stepping && l.def.front && l.dist <= this.thr * 1.6,
    );
    if (!free.length) return;
    const l = pick(free),
      S = this.S;
    this.startStep(l, l.rx + rand(-34, 34) * S, l.ry + rand(-26, 26) * S);
  }

  /**
   * Find the word under (page-space) x,y. We ask the browser what element is at that screen point
   * (elementFromPoint, pointer-events:none on our canvas lets it see through), and probe a few
   * offsets if we land between words. No word nearby (margin, figure)? Plant on bare paper.
   * Returns {x, y, el, cx, cy}: foot position, the element, and that element's centre (page space).
   */
  snap(x, y) {
    const sx = x - scrollX,
      sy = y - this.sy;
    const bare = { x, y, el: null, cx: 0, cy: 0 };
    if (sy < 2 || sy > this.H - 2 || sx < 2 || sx > this.W - 2) return bare;
    for (const [ox, oy] of PROBES) {
      const el = document.elementFromPoint(sx + ox, sy + oy);
      if (!el) continue;
      if (el.closest("#analyst, #toolbar")) return bare;
      const hit = el.closest(".w, a, td, th");
      if (!hit) continue;
      const r = hit.getBoundingClientRect();
      const isWord = hit.classList.contains("w");
      const px = clamp(sx + ox, r.left + 2, r.right - 2);
      const py = isWord
        ? r.top + r.height * 0.6
        : clamp(sy + oy, r.top + 2, r.bottom - 2);
      return {
        x: px + scrollX,
        y: py + this.sy,
        el: hit,
        cx: r.left + r.width / 2 + scrollX,
        cy: r.top + r.height / 2 + this.sy,
      };
    }
    return bare;
  }

  /* ========================================================= silk + thread */
  updateThread(dt) {
    const T = this.thread;
    if (!T) return;
    if (T.alive) {
      T.topX = this.dropInfo ? this.dropInfo.tx : T.topX;
      if (this.mode !== "drop") T.walked += this.speed * dt;
      if (T.walked > THREAD_SNAP * this.S && this.mode !== "land") {
        T.alive = false;
        T.fade = 1; // SNAP: the free end whips up to the screen top
        T.freeX = this.spin.x - this.view.x;
        T.freeY = this.spin.y - this.view.y;
        T.curl = rand(-40, 40);
      }
    } else if (T.fade > 0) {
      const k = Math.min(1, dt * 2.4);
      T.freeX += (T.topX - T.freeX) * k;
      T.freeY += (T.topY - T.freeY) * k;
      T.fade -= dt / 1.3;
    }
  }
  updateSilk(dt) {
    for (const s of this.silk) s.age += dt;
    while (this.silk.length && this.silk[0].age > 3.6) this.silk.shift();
  }

  /* ======================================================== section tracking */
  trackSection(dt) {
    const sec = this.paper.sectionAt(this.body.y);
    if (sec !== this.secCand) {
      this.secCand = sec;
      this.secT = 0;
    }
    this.secT += dt;
    if (sec !== this.curSec && (this.secT > 0.5 || !this.curSec)) {
      this.curSec = sec;
      this.emit("section", sec);
    }
  }

  /* ================================================================ CAMERA */
  updateCamera(dt) {
    const H = this.H;
    let next = this.camY;
    const manual = this.now < this.manualUntil;
    const inRefs = this.curSec && this.curSec.isRefs && this.mode === "roam"; // stop auto-scroll at References
    if (
      !manual &&
      this.follow &&
      !inRefs &&
      this.mode !== "drop" &&
      this.mode !== "land"
    ) {
      const want = this.body.y - H * 0.42,
        err = want - this.camY;
      let maxV;
      if (this.mode === "goto")
        maxV = 2600; // run to the target: whip the camera along
      else if (this.mouse.on && this.time - this.mouse.t < 1.2) {
        // chasing: only scroll near screen edges
        const sy = this.body.y - this.camY;
        maxV = sy > H * 0.82 || sy < H * 0.12 ? 500 : 0;
      } else maxV = Math.max(90, Math.abs(err) * 0.8); // slow reading drift
      next = this.camY + clamp(err * 2.4, -maxV, maxV) * dt;
    }
    next = clamp(next, 0, this.maxScroll);
    this.camY = next;
    this.view.y = next;
    if (Math.abs(next - this.sy) > 0.01) this.pendingScroll = next;
  }

  /* ================================================================ DRAW */
  draw() {
    this.renderer.draw(this.vm);
  }

  /* ============================================================== COMMIT ==
   * The ONLY place that writes to the DOM: queued markup, scrolling, lazy word-wrapping. */
  commit() {
    const q = this.q;
    for (let i = 0; i < q.length; i++) {
      const op = q[i];
      switch (op.k) {
        case "mark": {
          const el = op.el;
          if (!el.isConnected) break;
          el.classList.remove(...GROUP_CLS[op.g]);
          el.classList.add(...op.cls);
          this.touched.add(el);
          break;
        }
        case "phrase": {
          const w = this.wrapSpans(op.els, op.cls);
          if (!w)
            for (const el of op.els) {
              el.classList.add(...op.cls);
              this.touched.add(el);
            }
          break;
        }
        case "key":
          this.applyKey(op.spans);
          break;
        case "clear":
          this.doClear();
          break;
      }
    }
    q.length = 0;
    if (this.pendingScroll !== null) {
      window.scrollTo({
        top: this.pendingScroll,
        left: 0,
        behavior: "instant",
      });
      this.pendingScroll = null;
    }
    if (this.paper) this.paper.flush(3);
  }

  /** Wrap consecutive word spans (same parent) in <span class="m-phrase ...">. */
  wrapSpans(spans, cls) {
    const first = spans[0],
      last = spans[spans.length - 1];
    const parent = first.parentNode;
    if (
      !parent ||
      last.parentNode !== parent ||
      parent.classList.contains("m-phrase")
    )
      return null;
    const nodes = [];
    let n = first,
      guard = 0;
    while (n && guard++ < 60) {
      nodes.push(n);
      if (n === last) break;
      n = n.nextSibling;
    }
    if (nodes[nodes.length - 1] !== last) return null;
    const w = document.createElement("span");
    w.className = "m-phrase " + cls.join(" ");
    parent.insertBefore(w, first);
    for (const x of nodes) w.appendChild(x);
    this.wrappers.add(w);
    for (const s of spans) this.touched.add(s);
    return w;
  }

  /** The AI "pointed" at this phrase: orange blow-up + box. */
  applyKey(spans) {
    spans = spans.filter((s) => s.isConnected);
    if (!spans.length) return;
    for (const s of spans) {
      this.touched.add(s);
      s.__mk = this.time;
    }
    if (spans.length === 1) {
      spans[0].classList.remove(...FX_CLS, ...FILL_CLS, ...BOX_CLS);
      spans[0].classList.add("m-blowup", "m-s3", "m-box-red");
      return;
    }
    if (spans.length <= 4 && this.wrapSpans(spans, ["m-key"])) return;
    spans.forEach((s) => {
      s.classList.remove(...FILL_CLS);
      s.classList.add("m-hl-orange", "m-keyrun");
    });
  }

  doClear() {
    for (const w of this.wrappers) {
      if (w.parentNode) {
        while (w.firstChild) w.parentNode.insertBefore(w.firstChild, w);
        w.remove();
      }
    }
    this.wrappers.clear();
    for (const el of this.touched) {
      el.classList.remove(
        ...[...el.classList].filter((c) => c.startsWith("m-")),
      );
      el.__mk = 0;
    }
    this.touched.clear();
  }

  /* ========================================================= MARKUP BRAIN ==
   * Called when a foot lands. Decides (a) whether to mark the word, (b) with what. */
  onPlant(l) {
    const a = l.anchor;
    if (!a) return;
    const el = a.el;
    if (!el.classList.contains("w")) return; // table cell / link not wrapped yet
    this.silk.push({ x: l.fx, y: l.fy, age: 0 });
    if (this.silk.length > 5) this.silk.shift();
    const blk = el.closest(BLOCK_SEL);
    if (blk) this.walked.add(blk);
    if (el.__mk) return; // each word is annotated at most once
    el.__mk = this.time;
    this.touched.add(el);
    this.decide(el);
  }

  decide(el) {
    const I = INTENSITY[this.intensity];
    const info = classify(el);
    const cat = info.cat;
    if (cat === "metric" || cat === "model" || cat === "dataset")
      this.logNote(el, info);
    if (cat === "heading") {
      this.markHeading(el);
      return;
    }

    const smart = cat !== "plain";
    if (Math.random() > (smart ? I.smart : I.apply)) return;
    const eff = this.pickEffect(cat, info.text, I, null);
    if (!eff) return;
    this.applyEffect(el, eff);
    if (Math.random() < I.extra) {
      const e2 = this.pickEffect(cat, info.text, I, eff.g);
      if (e2) this.applyEffect(el, e2);
    }
    if (Math.random() < I.near) this.markNeighbors(el, I);
    if (Math.random() < I.line) this.markLine(el);
  }

  /** Weighted random pick. Smart categories get x3 on the dramatic effects. */
  pickEffect(cat, text, I, excludeGroup) {
    let total = 0;
    const ws = EFFECTS.map((e) => {
      if (e.g === excludeGroup) return 0;
      if (e.need === "digit" && !/\d/.test(text)) return 0;
      let w = e.w[cat] ?? (cat === "plain" ? 0 : (e.w.plain || 0) * 0.5);
      if (e.dramatic) {
        if (cat !== "plain") w *= 3;
        w *= I.dramatic;
      }
      total += w;
      return w;
    });
    if (total <= 0) return null;
    let r = Math.random() * total;
    for (let i = 0; i < EFFECTS.length; i++) {
      r -= ws[i];
      if (r <= 0) return EFFECTS[i];
    }
    return EFFECTS[EFFECTS.length - 1];
  }

  applyEffect(el, eff) {
    let cls = eff.cls;
    if (eff.id === "blowup")
      cls = [
        "m-blowup",
        Math.random() < 0.5 ? "m-s2" : "m-s3",
        ...(Math.random() < 0.4 ? ["m-red"] : []),
      ];
    else if (eff.id === "color")
      cls = ["m-color-text", "m-c" + (1 + ((Math.random() * 5) | 0))];
    if (eff.phrase) {
      // rotate a 1-3 word phrase
      const spans = [el];
      let n = el.nextElementSibling,
        extra = (Math.random() * 3) | 0;
      while (extra-- > 0 && n && n.classList.contains("w")) {
        spans.push(n);
        n = n.nextElementSibling;
      }
      if (spans.length > 1) {
        this.q.push({ k: "phrase", els: spans, cls });
        return;
      }
    }
    this.q.push({ k: "mark", el, g: eff.g, cls });
  }

  /** Section headings: the whole heading gets the purple monospace bar. */
  markHeading(el) {
    const h = el.closest("h1,h2,h3,h4,.ltx_title");
    for (const w of h.querySelectorAll(".w")) {
      w.__mk = this.time;
      this.touched.add(w);
      this.q.push({ k: "mark", el: w, g: "fill", cls: ["m-hl-purple"] });
    }
  }

  /** Occasionally a neighbour or two gets a calm effect too. */
  markNeighbors(el, I) {
    const calm = EFFECTS.filter((e) => !e.dramatic && !e.need);
    let n =
      Math.random() < 0.5 ? el.nextElementSibling : el.previousElementSibling;
    for (
      let k = 1 + ((Math.random() * 2) | 0);
      k > 0 && n && n.classList.contains("w");
      k--
    ) {
      if (!n.__mk) {
        n.__mk = this.time;
        this.touched.add(n);
        this.applyEffect(n, pick(calm));
      }
      n = n.nextElementSibling;
    }
  }

  /** Whole-line cyan strip: every word on the same visual line. */
  markLine(el) {
    const top = el.getBoundingClientRect().top;
    const words = [el];
    for (const dir of ["previousElementSibling", "nextElementSibling"]) {
      let n = el[dir];
      while (
        n &&
        n.classList.contains("w") &&
        words.length < 18 &&
        Math.abs(n.getBoundingClientRect().top - top) < 6
      ) {
        words.push(n);
        n = n[dir];
      }
    }
    if (words.length < 3) return;
    for (const w of words) {
      w.__mk = this.time;
      this.touched.add(w);
      this.q.push({ k: "mark", el: w, g: "fill", cls: ["m-hl-cyan"] });
    }
  }

  /** Crawler Notes: remember every metric / model / dataset the spider touched. */
  logNote(el, info) {
    const sec = this.curSec;
    const key = `${info.cat}|${info.text.toLowerCase()}|${sec ? sec.idx : -1}`;
    if (this.notesSeen.has(key)) return;
    this.notesSeen.add(key);
    this.emit("note", {
      type: info.cat,
      text: info.text,
      section: sec ? sec.title : "",
      sectionIdx: sec ? sec.idx : -1,
      sentence: sentenceAround(el),
    });
  }
}

/** The sentence containing `el` (read-only: uses a Range to find the word's offset in its paragraph). */
function sentenceAround(el) {
  const blk = el.closest(BLOCK_SEL);
  if (!blk) return "";
  const r = document.createRange();
  r.selectNodeContents(blk);
  r.setEnd(el, 0);
  const at = r.toString().length;
  const full = blk.textContent.replace(/\s+/g, " ");
  const left = full.slice(0, at);
  const ends = [
    left.lastIndexOf(". "),
    left.lastIndexOf("? "),
    left.lastIndexOf("! "),
  ];
  const s = Math.max(...ends);
  const start = s < 0 ? 0 : s + 2;
  const m = /[.!?](\s|$)/.exec(full.slice(at));
  const end = m ? at + m.index + 1 : full.length;
  return full.slice(start, end).trim().slice(0, 320);
}

export const __test = { solveIK, classify, noise1, INTENSITY, EFFECTS };
