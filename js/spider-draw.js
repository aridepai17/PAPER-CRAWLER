/**
 * spider-draw.js - paints the spider + silk on the full-viewport <canvas>.
 *
 * This file only DRAWS. All the state (body, legs, thread, silk) lives in
 * crawler.js and arrives as one "view model" object each frame. Nothing here
 * touches the DOM except the canvas, so it is cheap and never forces layout.
 *
 * Coordinates: crawler.js works in PAGE space (so the spider rides along with
 * the paper when it scrolls). We subtract `view` (the scroll offset) to get
 * canvas pixels.
 */

const LEG = "#19c3d6"; // cyan/teal legs
const LEG_DARK = "#0e9aaa";
const RED = "#e0303a"; // knees + feet
const TAU = Math.PI * 2;

export class SpiderRenderer {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext("2d", { alpha: true });
    this.resize();
  }

  /** Match the backing store to the viewport (capped at 2x so 4K screens stay at 60fps). */
  resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.W = window.innerWidth;
    this.H = window.innerHeight;
    this.cv.width = Math.round(this.W * this.dpr);
    this.cv.height = Math.round(this.H * this.dpr);
  }

  draw(vm) {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.W, this.H);
    if (!vm.visible) return;

    const ox = vm.view.x,
      oy = vm.view.y; // page -> screen offset
    this.drawSilk(ctx, vm, ox, oy);
    this.drawThread(ctx, vm, ox, oy);
    this.drawShadow(ctx, vm, ox, oy);

    // planted legs first, lifted legs on top (they're "higher" above the page)
    const legs = vm.legs;
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < legs.length; i++) {
        const l = legs[i];
        if (l.lift > 0.05 === (pass === 1)) this.drawLeg(ctx, vm, l, ox, oy);
      }
    }
    this.drawBody(ctx, vm, ox, oy);
    if (vm.debug) this.drawDebug(ctx, vm, ox, oy);
  }

  /* ---- soft contact shadow so the spider sits ON the paper ---- */
  drawShadow(ctx, vm, ox, oy) {
    const b = vm.body,
      S = vm.S;
    ctx.save();
    ctx.translate(b.x - ox + 4 * S, b.y - oy + 6 * S);
    ctx.rotate(b.ang);
    ctx.fillStyle = "rgba(0,0,0,0.13)";
    ctx.beginPath();
    ctx.ellipse(-6 * S, 0, 22 * S, 12 * S, 0, 0, TAU);
    ctx.fill();
    ctx.restore();
    // leg shadows: one cheap offset pass
    ctx.strokeStyle = "rgba(0,0,0,0.10)";
    ctx.lineWidth = 1.6 * S;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    for (const l of vm.legs) {
      ctx.moveTo(l.hx - ox + 3 * S, l.hy - oy + 5 * S);
      ctx.lineTo(l.kx - ox + 3 * S, l.ky - oy + 5 * S);
      ctx.lineTo(l.ex - ox + 3 * S, l.ey - oy + 5 * S);
    }
    ctx.stroke();
  }

  /* ---- one leg: two thin segments + red knee and red foot ---- */
  drawLeg(ctx, vm, l, ox, oy) {
    const S = vm.S;
    const hx = l.hx - ox,
      hy = l.hy - oy,
      kx = l.kx - ox,
      ky = l.ky - oy,
      ex = l.ex - ox,
      ey = l.ey - oy;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = LEG;
    ctx.lineWidth = 2.5 * S; // femur: a touch thicker
    ctx.beginPath();
    ctx.moveTo(hx, hy);
    ctx.lineTo(kx, ky);
    ctx.stroke();
    ctx.strokeStyle = LEG_DARK;
    ctx.lineWidth = 1.7 * S; // tibia: thinner, tapering feel
    ctx.beginPath();
    ctx.moveTo(kx, ky);
    ctx.lineTo(ex, ey);
    ctx.stroke();

    // knee dot
    ctx.fillStyle = RED;
    ctx.beginPath();
    ctx.arc(kx, ky, 2.8 * S, 0, TAU);
    ctx.fill();
    // foot dot (grows slightly while lifted) + a ripple ring right after planting
    ctx.beginPath();
    ctx.arc(ex, ey, (2.3 + l.lift * 1.6) * S, 0, TAU);
    ctx.fill();
    if (l.pulse > 0.02) {
      ctx.strokeStyle = `rgba(224,48,58,${(l.pulse * 0.55).toFixed(3)})`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(ex, ey, (3 + (1 - l.pulse) * 11) * S, 0, TAU);
      ctx.stroke();
    }
  }

  /* ---- glossy black body: abdomen + thorax + head, eye dot, two palps ---- */
  drawBody(ctx, vm, ox, oy) {
    const b = vm.body,
      S = vm.S,
      t = vm.time;
    ctx.save();
    ctx.translate(b.x - ox, b.y - oy);
    ctx.rotate(b.ang); // +x is "forward" from here on

    // palps (short, twitchy): drawn first so the head overlaps their base
    ctx.strokeStyle = LEG_DARK;
    ctx.lineWidth = 1.5 * S;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const side of [-1, 1]) {
      const w = vm.calm
        ? 0
        : Math.sin(t * 9 + side * 1.7) * 1.4 * S * (vm.moving ? 1.4 : 0.6);
      ctx.beginPath();
      ctx.moveTo(14 * S, side * 2.2 * S);
      ctx.lineTo(19.5 * S, side * (4.6 * S) + w);
      ctx.lineTo(23.5 * S, side * (2.6 * S) + w * 0.5);
      ctx.stroke();
    }

    const breathe = vm.calm ? 1 : 1 + Math.sin(t * 2.2) * 0.025;
    // abdomen (back), thorax (middle)
    const ga = ctx.createRadialGradient(
      -17 * S,
      -4 * S,
      1 * S,
      -15 * S,
      0,
      16 * S,
    );
    ga.addColorStop(0, "#3a4650");
    ga.addColorStop(0.35, "#10151a");
    ga.addColorStop(1, "#040506");
    ctx.fillStyle = ga;
    ctx.beginPath();
    ctx.ellipse(-15 * S, 0, 15 * S * breathe, 10.5 * S, 0, 0, TAU);
    ctx.fill();

    const gt = ctx.createRadialGradient(2 * S, -3 * S, 1 * S, 4 * S, 0, 11 * S);
    gt.addColorStop(0, "#3d4953");
    gt.addColorStop(0.4, "#12181d");
    gt.addColorStop(1, "#050607");
    ctx.fillStyle = gt;
    ctx.beginPath();
    ctx.ellipse(4 * S, 0, 10 * S, 7.5 * S, 0, 0, TAU);
    ctx.fill();

    // head
    ctx.fillStyle = "#0a0d10";
    ctx.beginPath();
    ctx.ellipse(13 * S, 0, 5 * S, 4.6 * S, 0, 0, TAU);
    ctx.fill();

    // glossy specular streak on the abdomen + thorax
    ctx.fillStyle = "rgba(255,255,255,0.30)";
    ctx.beginPath();
    ctx.ellipse(-19 * S, -4.6 * S, 5.5 * S, 1.8 * S, -0.25, 0, TAU);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.22)";
    ctx.beginPath();
    ctx.ellipse(3 * S, -3.6 * S, 3.6 * S, 1.3 * S, -0.2, 0, TAU);
    ctx.fill();

    // tiny white eye dot
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(14.6 * S, 0, 1.35 * S, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  /* ---- the silk thread the spider drops on (anchored to the top of the SCREEN) ---- */
  drawThread(ctx, vm, ox, oy) {
    const T = vm.thread;
    if (!T) return;
    const sp = vm.spin; // spinneret = tip of the abdomen (page coords)
    const sx = sp.x - ox,
      sy = sp.y - oy;
    ctx.lineCap = "round";
    if (T.alive) {
      const x0 = T.topX,
        y0 = T.topY; // screen coords, fixed to the viewport top
      const sway =
        Math.sin(vm.time * 1.3 + 0.7) * 6 + Math.sin(vm.time * 2.9) * 2;
      ctx.strokeStyle = "rgba(70,84,96,0.62)";
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.quadraticCurveTo((x0 + sx) / 2 + sway, (y0 + sy) / 2, sx, sy);
      ctx.stroke();
      // a faint highlight strand makes it read as silk, not a pen line
      ctx.strokeStyle = "rgba(255,255,255,0.55)";
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(x0 + 0.8, y0);
      ctx.quadraticCurveTo(
        (x0 + sx) / 2 + sway + 0.8,
        (y0 + sy) / 2,
        sx + 0.8,
        sy,
      );
      ctx.stroke();
    } else if (T.fade > 0.01) {
      // snapped: the loose strand whips back up toward the top of the screen
      ctx.strokeStyle = `rgba(70,84,96,${(0.6 * T.fade).toFixed(3)})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(T.topX, T.topY);
      ctx.quadraticCurveTo(
        T.topX + T.curl,
        (T.topY + T.freeY) / 2,
        T.freeX,
        T.freeY,
      );
      ctx.stroke();
    }
  }

  /* ---- faint silk lines from the abdomen to recently touched words ---- */
  drawSilk(ctx, vm, ox, oy) {
    if (!vm.silk.length) return;
    const sp = vm.spin,
      sx = sp.x - ox,
      sy = sp.y - oy;
    ctx.lineWidth = 0.8;
    ctx.lineCap = "round";
    for (const s of vm.silk) {
      const a = Math.max(0, 1 - s.age / 3.6) * 0.42;
      if (a <= 0.01) continue;
      const tx = s.x - ox,
        ty = s.y - oy;
      const d = Math.hypot(tx - sx, ty - sy);
      ctx.strokeStyle = `rgba(60,75,88,${a.toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.quadraticCurveTo((sx + tx) / 2, (sy + ty) / 2 + d * 0.14, tx, ty); // slight sag
      ctx.stroke();
    }
  }

  /* ---- ?debug overlay: IK skeleton, hip, rest targets, step-threshold circles ---- */
  drawDebug(ctx, vm, ox, oy) {
    ctx.save();
    ctx.lineWidth = 1;
    ctx.font = "10px monospace";
    for (const l of vm.legs) {
      // rest pose + step threshold circle: when the foot leaves this circle it wants to step
      ctx.strokeStyle = l.stepping
        ? "rgba(255,160,0,.9)"
        : "rgba(255,0,200,.55)";
      ctx.beginPath();
      ctx.arc(l.rx - ox, l.ry - oy, vm.thr, 0, TAU);
      ctx.stroke();
      ctx.fillStyle = "rgba(255,0,200,.9)";
      ctx.fillRect(l.rx - ox - 2, l.ry - oy - 2, 4, 4);
      // IK skeleton hip -> knee -> end
      ctx.strokeStyle = "#000";
      ctx.beginPath();
      ctx.moveTo(l.hx - ox, l.hy - oy);
      ctx.lineTo(l.kx - ox, l.ky - oy);
      ctx.lineTo(l.ex - ox, l.ey - oy);
      ctx.stroke();
      // foot TARGET (where the foot is anchored / heading)
      const tx = (l.stepping ? l.tx : l.fx) - ox,
        ty = (l.stepping ? l.ty : l.fy) - oy;
      ctx.strokeStyle = l.stepping ? "#f80" : "#0a0";
      ctx.beginPath();
      ctx.moveTo(tx - 5, ty);
      ctx.lineTo(tx + 5, ty);
      ctx.moveTo(tx, ty - 5);
      ctx.lineTo(tx, ty + 5);
      ctx.stroke();
      ctx.fillStyle = "#000";
      ctx.fillText(l.name, l.ex - ox + 6, l.ey - oy - 4);
    }
    ctx.fillStyle = "#000";
    ctx.fillText(
      `mode:${vm.mode}  group:${vm.group}`,
      vm.body.x - ox + 30,
      vm.body.y - oy - 30,
    );
    ctx.restore();
  }
}
