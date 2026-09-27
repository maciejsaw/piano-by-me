// Velocity response: how hard you hit and what comes out.
//
// A sampled piano has to answer two questions from one number, and the usual
// mistake is to answer them with one mechanism. They are:
//
//   how loud    a real grand runs 35-45 dB from pianissimo to fortissimo
//   how bright  which is not a filter, it is which recording gets played --
//               a hammer striking harder makes a different spectrum, not a
//               louder one
//
// Salamander's sixteen layers answer the second question perfectly and the
// first one only partly: measured across the library, the peak level of layer
// 1 is about 18 dB below layer 16, not 42. That is not a flaw in the
// recordings, it is how a piano works -- most of the dynamic range of a real
// instrument is in the spectrum, and the microphone's own range is narrower
// than the ear's impression of it. The SFZ covers the gap with a blanket
// amp_veltrack; this covers it per key, on a curve you can draw.
//
// So the two are separated:
//
//   layer  = which recording, from velocity through a per-key bias
//   gain   = the level the curve asked for, MINUS the level that recording
//            already has (measured, in the manifest)
//
// which means changing the curve never changes the timbre, and changing the
// layer bias never changes the level.

/** Level in dB relative to fortissimo, for velocity v on a curve (dyn, gamma). */
export function levelDb(v, dyn, gamma) {
  const u = Math.max(1, Math.min(127, v)) / 127;
  return dyn * (1 - Math.pow(u, gamma));
}

/**
 * Which of the recorded layers a velocity reaches for.
 *
 * Salamander's own velocity split is uneven -- layer 3 covers velocities 35
 * and 36 and nothing else -- because it was drawn against that instrument's
 * action. Following it exactly reproduces the library; `bias` is how you
 * disagree, in layers, and it is a per-key curve because one key being a
 * little too eager is a real thing that happens.
 */
export function pickLayer(v, hivel, layers, bias = 0) {
  let i = 0;
  while (i < hivel.length - 1 && v > hivel[i]) i++;
  const wanted = i + 1 + bias;
  let best = layers[0], bd = 1e9;
  for (const l of layers) { const d = Math.abs(l - wanted); if (d < bd) { bd = d; best = l; } }
  return best;
}

/**
 * Everything the engine needs for one note-on.
 *
 * `trimDb` from the library (for having had to settle for a neighbouring
 * layer) is folded in here rather than at the voice, so that a substitution
 * while a sample is still downloading is exactly level-matched and only the
 * timbre is approximate.
 */
/** The recorded layer value nearest a (possibly fractional) layer position. */
export function nearestLayer(layers, Lf) {
  let best = layers[0], bd = 1e9;
  for (const l of layers) { const d = Math.abs(l - Lf); if (d < bd) { bd = d; best = l; } }
  return best;
}

/**
 * The NATIVE level at a fractional layer position, in dB below fortissimo.
 *
 * Each recorded layer has a measured level relative to the loudest (relDb, <=0).
 * Interpolating between the two layers a fractional position falls between gives
 * a level that runs smoothly THROUGH the layers' own recorded loudnesses -- so
 * every layer sits at its native level in the middle of its span, and the level
 * at a layer boundary is the same from both sides. Timbre steps; level does not.
 */
export function nativeAt(rel, layers, Lf) {
  if (Lf <= layers[0]) return rel[layers[0]] ?? 0;
  for (let i = 0; i < layers.length - 1; i++) {
    if (Lf <= layers[i + 1]) {
      const a = rel[layers[i]] ?? 0, b = rel[layers[i + 1]] ?? 0;
      const u = (Lf - layers[i]) / Math.max(1e-6, layers[i + 1] - layers[i]);
      return a + (b - a) * u;
    }
  }
  return rel[layers[layers.length - 1]] ?? 0;
}

export function plan(curves, lib, midi, vel, extraBias = 0, velCurve = null, velLayer = null) {
  const layers = lib.layers;
  const bias = Math.round(curves.at('layerBias', midi)) + extraBias;
  // Which layer this velocity reaches for, as a CONTINUOUS position: the
  // hand-drawn velocity->layer curve if there is one, otherwise the library's
  // own hivel split. Per-key layer bias nudges it; the result is clamped so the
  // extremes are always reachable (the old additive bias could not do that).
  let Lf = velLayer ? velLayer.at(vel) : pickLayer(vel, lib.m.hivel, layers, 0);
  Lf = Math.max(layers[0], Math.min(layers[layers.length - 1], Lf + bias));
  // Timbre is the nearest actually-recorded layer to that position.
  const want = nearestLayer(layers, Lf);
  const got = lib.best(midi, want);
  if (!got) return null;

  const rel = lib.relDb[midi] ?? {};
  // Level: the hand-drawn VOLUME curve if it is on, otherwise the interpolated
  // NATIVE level -- each layer at its recorded loudness, ramped smoothly across
  // the boundary so nothing jumps. Per-key trim adds on top of either.
  const base = velCurve?.enabled ? velCurve.at(vel) : nativeAt(rel, layers, Lf);
  const target = base + curves.at('trim', midi);
  const already = rel[got.layer] ?? 0;
  return {
    key: got.key,
    frames: got.frames,
    dur: got.entry.dur,
    layer: got.layer,
    exact: got.layer === want,
    // Where this recording's attack front sits, in ms into the file (written
    // by sampled/tools/align.mjs). The engine lines these up; see startAt().
    t0: got.entry.t0,
    // gain restores the recording's true level, then moves it to where the
    // curve asked for it
    gain: got.entry.gain * Math.pow(10, (target - already) / 20),
    targetDb: target,
  };
}

// How far down the hand-drawn curve reaches, in dB below fortissimo. -72 is
// effectively silence once a layer's own low level is folded in, which is what
// lets the softest layer be pulled to nothing at velocity 1.
export const VEL_FLOOR = -72;

/**
 * A hand-drawn velocity -> level curve, in dB below fortissimo.
 *
 * A monotone list of points the user places directly, linearly interpolated.
 * The endpoints are pinned to velocity 1 and 127 (only their level moves); the
 * points between move freely in both axes but cannot cross their neighbours, so
 * the mapping stays single-valued. It replaces the dynamic/gamma formula when
 * enabled, which is the point: the two-parameter formula cannot, for instance,
 * take ONLY the softest layer down to silence while leaving the transitions
 * between the layers above it exactly as they were.
 */
export class VelCurve {
  constructor() {
    this.enabled = false;
    // A gentle default roughly matching the shipped -42 dB / gamma 1 curve.
    this.points = [
      { v: 1, db: -42 }, { v: 43, db: -24 }, { v: 85, db: -9 }, { v: 127, db: 0 },
    ];
  }

  at(v) {
    v = Math.max(1, Math.min(127, v));
    const p = this.points;
    if (v <= p[0].v) return p[0].db;
    for (let i = 0; i < p.length - 1; i++) {
      if (v <= p[i + 1].v) {
        const u = (v - p[i].v) / Math.max(1e-6, p[i + 1].v - p[i].v);
        return p[i].db + (p[i + 1].db - p[i].db) * u;
      }
    }
    return p[p.length - 1].db;
  }

  toJSON() { return { enabled: this.enabled, points: this.points.map((p) => ({ v: p.v, db: p.db })) }; }
  fromJSON(o) {
    if (!o) return;
    this.enabled = !!o.enabled;
    if (Array.isArray(o.points) && o.points.length >= 2) {
      this.points = o.points
        .map((p) => ({ v: Math.max(1, Math.min(127, p.v)), db: Math.max(VEL_FLOOR, Math.min(0, p.db)) }))
        .sort((a, b) => a.v - b.v);
      this.points[0].v = 1; this.points[this.points.length - 1].v = 127;
    }
  }
}

/**
 * The interactive editor for a VelCurve.
 *
 * Click empty space to add a point, drag to move it, double-click to remove.
 * The velocity->layer bands are painted behind, so balancing a layer is done
 * against the thing it actually controls; `markVel()` may return the most
 * recently played velocity, drawn as a fading line so a hit shows where it fell.
 */
export function createVelCurveEditor(canvas, vc, { layers, hivel, bias = () => 0, markVel = () => null, onChange } = {}) {
  const ctx = canvas.getContext('2d');
  const dpr = () => window.devicePixelRatio || 1;
  const RANGE = -VEL_FLOOR;
  const xOf = (v, w) => (v - 1) / 126 * w;
  const yOf = (db, h) => (-db / RANGE) * h;
  const vOf = (px, w) => Math.max(1, Math.min(127, Math.round(1 + px / w * 126)));
  const dbOf = (py, h) => Math.max(-RANGE, Math.min(0, -(py / h) * RANGE));
  let drag = -1;

  function draw() {
    const w = canvas.width = canvas.clientWidth * dpr();
    const h = canvas.height;
    ctx.fillStyle = '#0d1119'; ctx.fillRect(0, 0, w, h);
    // Layer bands.
    for (let v = 1; v <= 127; v++) {
      const l = pickLayer(v, hivel, layers, bias());
      ctx.fillStyle = l % 2 ? '#121722' : '#151b28';
      ctx.fillRect(xOf(v, w), 0, w / 127 + 1, h);
    }
    // dB grid.
    ctx.strokeStyle = '#222c40'; ctx.fillStyle = '#4f5c76';
    ctx.font = `${9 * dpr()}px ui-monospace,monospace`; ctx.textAlign = 'left';
    for (let d = 0; d >= VEL_FLOOR; d -= 12) {
      const y = yOf(d, h);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      ctx.fillText(d === VEL_FLOOR ? 'silent' : `${d}`, 3 * dpr(), Math.min(h - 2, y + 10 * dpr()));
    }
    // The most recent hit.
    const mv = markVel();
    if (mv) {
      ctx.strokeStyle = 'rgba(141,161,190,0.6)'; ctx.lineWidth = 1.5 * dpr();
      ctx.beginPath(); ctx.moveTo(xOf(mv, w), 0); ctx.lineTo(xOf(mv, w), h); ctx.stroke();
    }
    // The curve.
    ctx.strokeStyle = '#d8c4a2'; ctx.lineWidth = 2 * dpr(); ctx.beginPath();
    for (let v = 1; v <= 127; v++) {
      const x = xOf(v, w), y = yOf(vc.at(v), h);
      v === 1 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
    // The points.
    for (const p of vc.points) {
      ctx.fillStyle = '#eee4d3';
      ctx.beginPath(); ctx.arc(xOf(p.v, w), yOf(p.db, h), 4 * dpr(), 0, 7); ctx.fill();
    }
  }

  const local = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width * canvas.width, y: (e.clientY - r.top) / r.height * canvas.height };
  };
  const hit = (x, y) => {
    const w = canvas.width, h = canvas.height, R = 12 * dpr();
    for (let i = 0; i < vc.points.length; i++) {
      if (Math.hypot(x - xOf(vc.points[i].v, w), y - yOf(vc.points[i].db, h)) < R) return i;
    }
    return -1;
  };

  canvas.addEventListener('pointerdown', (e) => {
    const { x, y } = local(e);
    let i = hit(x, y);
    if (i < 0) {
      // Add a point where the pointer is, keeping the list sorted.
      const p = { v: vOf(x, canvas.width), db: dbOf(y, canvas.height) };
      vc.points.push(p); vc.points.sort((a, b) => a.v - b.v);
      i = vc.points.indexOf(p);
    }
    drag = i;
    canvas.setPointerCapture(e.pointerId);
    draw();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (drag < 0) return;
    const { x, y } = local(e);
    const p = vc.points[drag], last = vc.points.length - 1;
    p.db = dbOf(y, canvas.height);
    if (drag > 0 && drag < last) {
      // Middle point: free in velocity, but cannot cross its neighbours.
      const lo = vc.points[drag - 1].v + 1, hi = vc.points[drag + 1].v - 1;
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
    if (i > 0 && i < vc.points.length - 1) { vc.points.splice(i, 1); draw(); onChange?.(); }
  });

  draw();
  return { draw };
}

/**
 * A hand-drawn velocity -> layer map, replacing the single "layer bias" knob.
 *
 * Points are (velocity, layer); the layer output is continuous and linearly
 * interpolated, so it also drives the smooth native-level ramp between layers.
 * Because the whole 1..N range is drawable, every layer stays reachable -- the
 * old additive bias could push the top layers off the end of the keyboard.
 */
export class VelLayerCurve {
  constructor(min = 1, max = 16) {
    this.min = min; this.max = max;
    this.points = [{ v: 1, layer: min }, { v: 127, layer: max }];
  }

  /** A default that reproduces the library's own hivel split. */
  static fromHivel(hivel, layers) {
    const vc = new VelLayerCurve(layers[0], layers[layers.length - 1]);
    const pts = [{ v: 1, layer: layers[0] }];
    for (let i = 0; i < layers.length; i++) {
      const v = Math.max(1, Math.min(127, i < hivel.length ? hivel[i] : 127));
      if (v > pts[pts.length - 1].v) pts.push({ v, layer: layers[i] });
    }
    pts[pts.length - 1].v = 127;
    vc.points = pts;
    return vc;
  }

  at(v) {
    v = Math.max(1, Math.min(127, v));
    const p = this.points;
    let L;
    if (v <= p[0].v) L = p[0].layer;
    else {
      L = p[p.length - 1].layer;
      for (let i = 0; i < p.length - 1; i++) {
        if (v <= p[i + 1].v) {
          const u = (v - p[i].v) / Math.max(1e-6, p[i + 1].v - p[i].v);
          L = p[i].layer + (p[i + 1].layer - p[i].layer) * u;
          break;
        }
      }
    }
    return Math.max(this.min, Math.min(this.max, L));
  }

  toJSON() { return { min: this.min, max: this.max, points: this.points.map((p) => ({ v: p.v, layer: p.layer })) }; }
  fromJSON(o) {
    if (!o) return;
    if (o.min != null) this.min = o.min;
    if (o.max != null) this.max = o.max;
    if (Array.isArray(o.points) && o.points.length >= 2) {
      this.points = o.points
        .map((p) => ({ v: Math.max(1, Math.min(127, p.v)), layer: Math.max(this.min, Math.min(this.max, p.layer)) }))
        .sort((a, b) => a.v - b.v);
      this.points[0].v = 1; this.points[this.points.length - 1].v = 127;
    }
  }
}

/**
 * The editor for a VelLayerCurve: velocity across, layer up.
 *
 * Click to add a point, drag to move, double-click to remove -- the same
 * gestures as the volume editor. Horizontal bands are the layers; the marker is
 * the last velocity struck, so you can see which layer a real hit lands on.
 */
export function createVelLayerEditor(canvas, vc, { markVel = () => null, onChange } = {}) {
  const ctx = canvas.getContext('2d');
  const dpr = () => window.devicePixelRatio || 1;
  const span = () => Math.max(1e-6, vc.max - vc.min);
  const xOf = (v, w) => (v - 1) / 126 * w;
  const yOf = (L, h) => (1 - (L - vc.min) / span()) * h;   // low layer at bottom
  const vOf = (px, w) => Math.max(1, Math.min(127, Math.round(1 + px / w * 126)));
  const lOf = (py, h) => Math.max(vc.min, Math.min(vc.max, vc.min + (1 - py / h) * span()));
  let drag = -1;

  function draw() {
    const w = canvas.width = canvas.clientWidth * dpr();
    const h = canvas.height;
    ctx.fillStyle = '#0d1119'; ctx.fillRect(0, 0, w, h);
    // Layer bands.
    const n = Math.round(vc.max - vc.min) + 1;
    for (let i = 0; i < n; i++) {
      const L = vc.min + i;
      ctx.fillStyle = i % 2 ? '#121722' : '#151b28';
      ctx.fillRect(0, yOf(L + 0.5, h), w, Math.abs(yOf(L - 0.5, h) - yOf(L + 0.5, h)));
    }
    ctx.font = `${9 * dpr()}px ui-monospace,monospace`; ctx.fillStyle = '#4f5c76'; ctx.textAlign = 'left';
    ctx.fillText(`layer ${vc.max}`, 3 * dpr(), 10 * dpr());
    ctx.fillText(`layer ${vc.min}`, 3 * dpr(), h - 4 * dpr());
    // Last hit.
    const mv = markVel();
    if (mv) {
      ctx.strokeStyle = 'rgba(141,161,190,0.6)'; ctx.lineWidth = 1.5 * dpr();
      ctx.beginPath(); ctx.moveTo(xOf(mv, w), 0); ctx.lineTo(xOf(mv, w), h); ctx.stroke();
      ctx.fillStyle = 'rgba(141,161,190,0.9)';
      ctx.beginPath(); ctx.arc(xOf(mv, w), yOf(vc.at(mv), h), 3.5 * dpr(), 0, 7); ctx.fill();
    }
    // Curve.
    ctx.strokeStyle = '#d8c4a2'; ctx.lineWidth = 2 * dpr(); ctx.beginPath();
    for (let v = 1; v <= 127; v++) {
      const x = xOf(v, w), y = yOf(vc.at(v), h);
      v === 1 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
    for (const p of vc.points) {
      ctx.fillStyle = '#eee4d3';
      ctx.beginPath(); ctx.arc(xOf(p.v, w), yOf(p.layer, h), 4 * dpr(), 0, 7); ctx.fill();
    }
  }

  const local = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width * canvas.width, y: (e.clientY - r.top) / r.height * canvas.height };
  };
  const hit = (x, y) => {
    const w = canvas.width, h = canvas.height, R = 12 * dpr();
    for (let i = 0; i < vc.points.length; i++) {
      if (Math.hypot(x - xOf(vc.points[i].v, w), y - yOf(vc.points[i].layer, h)) < R) return i;
    }
    return -1;
  };

  canvas.addEventListener('pointerdown', (e) => {
    const { x, y } = local(e);
    let i = hit(x, y);
    if (i < 0) {
      const p = { v: vOf(x, canvas.width), layer: lOf(y, canvas.height) };
      vc.points.push(p); vc.points.sort((a, b) => a.v - b.v);
      i = vc.points.indexOf(p);
    }
    drag = i;
    canvas.setPointerCapture(e.pointerId);
    draw();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (drag < 0) return;
    const { x, y } = local(e);
    const p = vc.points[drag], last = vc.points.length - 1;
    p.layer = lOf(y, canvas.height);
    if (drag > 0 && drag < last) {
      const lo = vc.points[drag - 1].v + 1, hi = vc.points[drag + 1].v - 1;
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
    if (i > 0 && i < vc.points.length - 1) { vc.points.splice(i, 1); draw(); onChange?.(); }
  });

  draw();
  return { draw };
}
