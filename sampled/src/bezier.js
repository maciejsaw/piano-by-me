// Cubic Bézier shapes, and the editor for dragging them.
//
// Every envelope in this instrument is one of these: two endpoints fixed at
// (0,0) and (1,1) and two control handles in between, exactly like a CSS
// easing curve. That is a deliberate choice over the usual attack/decay knob.
//
// An ADSR's shape is fixed -- linear, or exponential, or whatever the author
// picked -- and all you get to move is how long it takes. But the SHAPE is
// what a damper argument is about. A damper falling on a bass string does not
// decay exponentially: it grips slowly, then bites. A key-release thud does
// not fade linearly. With two handles you can say that, and with a time knob
// alone you cannot.
//
// Evaluation is by parameter, not by x, so a lookup needs solving x(s) = t for
// s. Newton from a good guess converges in three or four steps; bisection is
// there for the cases where the curve is nearly flat and Newton's derivative
// is uninformative. Nothing here runs per audio sample -- curves are baked
// into Float32Arrays and handed to setValueCurveAtTime, so the browser
// interpolates them on the audio thread and this code runs once per note.

const A = (a, b) => 1 - 3 * b + 3 * a;
const B_ = (a, b) => 3 * b - 6 * a;
const C = (a) => 3 * a;
const calc = (s, a, b) => ((A(a, b) * s + B_(a, b)) * s + C(a)) * s;
const slope = (s, a, b) => 3 * A(a, b) * s * s + 2 * B_(a, b) * s + C(a);

/** A shape: y as a function of x in [0,1], both ends pinned. */
export class Bezier {
  constructor(x1 = 0.33, y1 = 0.33, x2 = 0.67, y2 = 0.67) { this.set(x1, y1, x2, y2); }
  set(x1, y1, x2, y2) {
    // x must stay inside [0,1] or the curve is not a function of x; y is free,
    // so a handle can overshoot and give a curve that bulges past its endpoint.
    this.x1 = Math.min(1, Math.max(0, x1)); this.y1 = y1;
    this.x2 = Math.min(1, Math.max(0, x2)); this.y2 = y2;
    return this;
  }
  copy() { return new Bezier(this.x1, this.y1, this.x2, this.y2); }
  get linear() { return Math.abs(this.x1 - this.y1) < 1e-6 && Math.abs(this.x2 - this.y2) < 1e-6; }

  paramAt(t) {
    let s = t;
    for (let i = 0; i < 6; i++) {
      const d = slope(s, this.x1, this.x2);
      if (Math.abs(d) < 1e-6) break;
      const e = calc(s, this.x1, this.x2) - t;
      if (Math.abs(e) < 1e-7) return s;
      s -= e / d;
    }
    let lo = 0, hi = 1;
    s = t;
    for (let i = 0; i < 24; i++) {
      const x = calc(s, this.x1, this.x2);
      if (Math.abs(x - t) < 1e-7) break;
      if (x > t) hi = s; else lo = s;
      s = (lo + hi) / 2;
    }
    return s;
  }
  at(t) {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return calc(this.paramAt(t), this.y1, this.y2);
  }

  /**
   * Bake to a curve for setValueCurveAtTime.
   *
   * `from` and `to` are the real gain values the shape runs between, so the
   * same shape serves an attack (0 -> 1) and a release (whatever the voice is
   * at now -> 0). Values are floored just above zero because an exponential
   * ramp cannot reach zero and because a hard zero in a curve is a click.
   */
  curve(from, to, n = 128) {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const y = this.at(i / (n - 1));
      out[i] = Math.max(1e-5, from + (to - from) * y);
    }
    out[n - 1] = Math.max(1e-5, to);
    return out;
  }

  toJSON() { return [+this.x1.toFixed(4), +this.y1.toFixed(4), +this.x2.toFixed(4), +this.y2.toFixed(4)]; }
  static from(a, fallback) { return Array.isArray(a) && a.length === 4 ? new Bezier(...a) : fallback.copy(); }
}

/** Handy named shapes, as starting points rather than as presets. */
export const SHAPES = {
  linear: () => new Bezier(0.33, 0.33, 0.67, 0.67),
  // Fast at first, then long: how a string that is still ringing gives up.
  natural: () => new Bezier(0.08, 0.62, 0.32, 0.9),
  // Hangs, then drops: a damper gripping before it bites.
  grip: () => new Bezier(0.55, 0.06, 0.82, 0.42),
  soft: () => new Bezier(0.45, 0.02, 0.9, 0.55),
  fast: () => new Bezier(0.05, 0.75, 0.2, 0.98),
};

/**
 * The editor. One canvas, two draggable handles, and an optional ghost curve
 * drawn behind -- which is how the release-against-hold-time control shows
 * the selected note's MEASURED decay while you draw your own opinion over it.
 */
export function createBezierEditor(canvas, bez, onChange, opts = {}) {
  const ctx = canvas.getContext('2d');
  let drag = null;
  const R = 5;
  // A release is stored like every other shape, 0 -> 1 (the share of the fall
  // done), but drawn the way it sounds: full at the top left, falling to
  // silence at the bottom right. Only the drawing and the pointer are flipped.
  const flip = opts.falling ? (y) => 1 - y : (y) => y;

  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: flip(1 - (e.clientY - r.top) / r.height) };
  };
  const toPx = (x, y, w, h) => [x * w, (1 - flip(y)) * h];

  function draw() {
    const w = canvas.width = canvas.clientWidth * devicePixelRatio;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0d1119'; ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = '#19202f'; ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      ctx.beginPath(); ctx.moveTo(w * i / 4, 0); ctx.lineTo(w * i / 4, h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, h * i / 4); ctx.lineTo(w, h * i / 4); ctx.stroke();
    }

    if (opts.falling) {
      ctx.font = `${9 * devicePixelRatio}px ui-monospace,monospace`;
      ctx.fillStyle = '#4f5c76';
      ctx.textAlign = 'left'; ctx.fillText('full', 4 * devicePixelRatio, 11 * devicePixelRatio);
      ctx.textAlign = 'right'; ctx.fillText('silent', w - 4 * devicePixelRatio, h - 4 * devicePixelRatio);
    }

    const ghost = opts.ghost?.();
    if (ghost && ghost.length > 1) {
      ctx.strokeStyle = '#5c6778'; ctx.lineWidth = 1.5 * devicePixelRatio;
      ctx.setLineDash([4 * devicePixelRatio, 3 * devicePixelRatio]);
      ctx.beginPath();
      ghost.forEach(([gx, gy], i) => { const [px, py] = toPx(gx, gy, w, h); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // handle arms
    ctx.strokeStyle = '#363f51'; ctx.lineWidth = 1 * devicePixelRatio;
    for (const [hx, hy, ax, ay] of [[bez.x1, bez.y1, 0, 0], [bez.x2, bez.y2, 1, 1]]) {
      ctx.beginPath();
      ctx.moveTo(...toPx(ax, ay, w, h)); ctx.lineTo(...toPx(hx, hy, w, h)); ctx.stroke();
    }

    ctx.strokeStyle = '#d8c4a2'; ctx.lineWidth = 2 * devicePixelRatio;
    ctx.beginPath();
    for (let i = 0; i <= 96; i++) {
      const t = i / 96;
      const [px, py] = toPx(t, bez.at(t), w, h);
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    ctx.stroke();

    for (const [hx, hy, col] of [[bez.x1, bez.y1, '#8da1be'], [bez.x2, bez.y2, '#e08a6a']]) {
      const [px, py] = toPx(hx, hy, w, h);
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(px, py, R * devicePixelRatio, 0, 7); ctx.fill();
    }
  }

  canvas.onpointerdown = (e) => {
    const p = pos(e);
    const d1 = Math.hypot(p.x - bez.x1, p.y - bez.y1);
    const d2 = Math.hypot(p.x - bez.x2, p.y - bez.y2);
    drag = d1 < d2 ? 1 : 2;
    canvas.setPointerCapture(e.pointerId);
    move(e);
  };
  const move = (e) => {
    if (!drag) return;
    const p = pos(e);
    const y = Math.max(-0.25, Math.min(1.25, p.y));
    if (drag === 1) bez.set(p.x, y, bez.x2, bez.y2); else bez.set(bez.x1, bez.y1, p.x, y);
    draw(); onChange();
  };
  canvas.onpointermove = move;
  canvas.onpointerup = canvas.onpointercancel = () => { drag = null; };

  draw();
  return { draw };
}
