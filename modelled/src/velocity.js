// Velocity response: how hard you hit, and what the hammer does about it.
//
// In the model one number -- hammer speed -- decides both how loud a note is
// and how bright, because that is what a real hammer does: a faster blow is a
// shorter contact, and a shorter contact reaches higher partials. That is the
// physics and it stays. What these two curves add is a say over each half of
// it separately, the way the sampled piano's volume and layer curves do:
//
//   volume     where the strike lands, in dB below a full-velocity strike of
//              the same note. Off, the level is whatever the hammer speed
//              gives; on, it is the drawn curve, and the speed only decides
//              the timbre.
//   hardness   added to the felt's hardness for that one strike -- the same
//              exponent as the Felt hardness voicing curve, so a harder felt
//              for loud playing (as a real, voiced hammer effectively is) is
//              one line drawn upward to the right.
//
// Both are drawn over MIDI velocity 1..127.

/** A hand-drawn, single-valued velocity -> value curve, linearly interpolated. */
export class VelMap {
  constructor({ min, max, points, enabled = true }) {
    this.min = min; this.max = max;
    this.enabled = enabled;
    this.defaults = points.map((p) => ({ ...p }));
    this.points = points.map((p) => ({ ...p }));
  }

  at(v) {
    v = Math.max(1, Math.min(127, v));
    const p = this.points;
    if (v <= p[0].v) return p[0].y;
    for (let i = 0; i < p.length - 1; i++) {
      if (v <= p[i + 1].v) {
        const u = (v - p[i].v) / Math.max(1e-6, p[i + 1].v - p[i].v);
        return p[i].y + (p[i + 1].y - p[i].y) * u;
      }
    }
    return p[p.length - 1].y;
  }

  reset() { this.points = this.defaults.map((p) => ({ ...p })); }

  toJSON() { return { enabled: this.enabled, points: this.points.map((p) => ({ v: p.v, y: p.y })) }; }
  fromJSON(o) {
    if (!o) return;
    if (o.enabled != null) this.enabled = !!o.enabled;
    if (Array.isArray(o.points) && o.points.length >= 2) {
      this.points = o.points
        .map((p) => ({ v: Math.max(1, Math.min(127, p.v)), y: Math.max(this.min, Math.min(this.max, p.y)) }))
        .sort((a, b) => a.v - b.v);
      this.points[0].v = 1; this.points[this.points.length - 1].v = 127;
    }
  }
}

// Level below a full-velocity strike. -72 dB is silence for practical purposes.
export const VOL_FLOOR = -72;

/**
 * The volume curve. Its default is what the hammer does on its own, measured
 * across the compass (it is within a couple of dB of that everywhere), so
 * switching the curve on changes nothing until a point is moved.
 */
export const volumeMap = () => new VelMap({
  min: VOL_FLOOR, max: 0, enabled: false,
  points: [{ v: 1, y: -38 }, { v: 38, y: -30 }, { v: 64, y: -24 }, { v: 89, y: -16 }, { v: 114, y: -6 }, { v: 127, y: 0 }],
});

/** The hardness curve: flat at zero, which is the voicing exactly as fitted. */
export const hardnessMap = () => new VelMap({
  min: -1, max: 1,
  points: [{ v: 1, y: 0 }, { v: 127, y: 0 }],
});

/**
 * The interactive editor for a VelMap.
 *
 * Click empty space to add a point, drag to move it, double-click to remove.
 * The end points are pinned to velocity 1 and 127; the ones between cannot
 * cross their neighbours, so the curve stays single-valued. `markVel()` may
 * return the last velocity struck, drawn as a line so a hit shows where it fell.
 */
export function createVelMapEditor(canvas, map, { grid = [], label = (y) => y.toFixed(1), zero = null, markVel = () => null, onChange } = {}) {
  const ctx = canvas.getContext('2d');
  const dpr = () => window.devicePixelRatio || 1;
  const span = () => map.max - map.min;
  const xOf = (v, w) => (v - 1) / 126 * w;
  const yOf = (y, h) => (1 - (y - map.min) / span()) * h;
  const vOf = (px, w) => Math.max(1, Math.min(127, Math.round(1 + px / w * 126)));
  const valOf = (py, h) => Math.max(map.min, Math.min(map.max, map.min + (1 - py / h) * span()));
  let drag = -1;

  function draw() {
    const w = canvas.width = canvas.clientWidth * dpr();
    const h = canvas.height = canvas.clientHeight * dpr();
    ctx.fillStyle = '#17150f'; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#2b261d'; ctx.fillStyle = '#6d6458';
    ctx.font = `${9 * dpr()}px ui-monospace,monospace`; ctx.textAlign = 'left';
    for (const g of grid) {
      const y = yOf(g, h);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      ctx.fillText(label(g), 3 * dpr(), Math.max(10 * dpr(), Math.min(h - 3, y - 3)));
    }
    for (const v of [32, 64, 96]) {
      const x = xOf(v, w);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      ctx.fillText(`${v}`, x + 3, h - 3);
    }
    if (zero != null) {
      ctx.strokeStyle = '#4a4134';
      ctx.beginPath(); ctx.moveTo(0, yOf(zero, h)); ctx.lineTo(w, yOf(zero, h)); ctx.stroke();
    }
    const mv = markVel();
    if (mv) {
      ctx.strokeStyle = 'rgba(111,168,220,0.6)'; ctx.lineWidth = 1.5 * dpr();
      ctx.beginPath(); ctx.moveTo(xOf(mv, w), 0); ctx.lineTo(xOf(mv, w), h); ctx.stroke();
      ctx.fillStyle = 'rgba(111,168,220,0.9)';
      ctx.beginPath(); ctx.arc(xOf(mv, w), yOf(map.at(mv), h), 3.5 * dpr(), 0, 7); ctx.fill();
    }
    ctx.strokeStyle = map.enabled ? '#d9a441' : '#6d6458'; ctx.lineWidth = 2 * dpr(); ctx.beginPath();
    for (let v = 1; v <= 127; v++) {
      const x = xOf(v, w), y = yOf(map.at(v), h);
      v === 1 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.fillStyle = map.enabled ? '#ffeec0' : '#8b8172';
    for (const p of map.points) {
      ctx.beginPath(); ctx.arc(xOf(p.v, w), yOf(p.y, h), 4 * dpr(), 0, 7); ctx.fill();
    }
  }

  const local = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width * canvas.width, y: (e.clientY - r.top) / r.height * canvas.height };
  };
  const hit = (x, y) => {
    const w = canvas.width, h = canvas.height, R = 12 * dpr();
    for (let i = 0; i < map.points.length; i++) {
      if (Math.hypot(x - xOf(map.points[i].v, w), y - yOf(map.points[i].y, h)) < R) return i;
    }
    return -1;
  };

  canvas.addEventListener('pointerdown', (e) => {
    const { x, y } = local(e);
    let i = hit(x, y);
    if (i < 0) {
      const p = { v: vOf(x, canvas.width), y: valOf(y, canvas.height) };
      if (p.v <= 1 || p.v >= 127) return;
      map.points.push(p); map.points.sort((a, b) => a.v - b.v);
      i = map.points.indexOf(p);
    }
    drag = i;
    canvas.setPointerCapture(e.pointerId);
    draw();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (drag < 0) return;
    const { x, y } = local(e);
    const p = map.points[drag], last = map.points.length - 1;
    p.y = valOf(y, canvas.height);
    if (drag > 0 && drag < last) {
      const lo = map.points[drag - 1].v + 1, hi = map.points[drag + 1].v - 1;
      p.v = Math.max(lo, Math.min(hi, vOf(x, canvas.width)));
    }
    draw(); onChange?.();
  });
  const end = (e) => { if (drag >= 0) { drag = -1; try { canvas.releasePointerCapture(e.pointerId); } catch { /* */ } onChange?.(); } };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('dblclick', (e) => {
    const { x, y } = local(e);
    const i = hit(x, y);
    if (i > 0 && i < map.points.length - 1) { map.points.splice(i, 1); draw(); onChange?.(); }
  });

  draw();
  return { draw };
}
