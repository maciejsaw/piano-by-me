// Per-key parameters, and the editor that draws them.
//
// Everything a player would want to differ from note to note is a curve across
// the keyboard rather than a single number: velocity response, level, stereo
// position, tuning, how much a key joins in sympathetically.
//
// One control per parameter, whose SCOPE you choose. That is the whole idea:
// you play, you notice something, and the fix is the same slider whether the
// something is the whole instrument, the top octave and a half, or one key.
//
//   all keys    the slider moves the whole compass
//   a range     the slider moves the keys you selected, FEATHERED at the
//               edges so the range does not end in a cliff
//   one key     the slider moves that key alone, and abruptly, because
//               sometimes one key really is just wrong
//
// The three tiers ADD, and they are all offsets from the shipped default, so
// zero is always "as shipped" and however far an edit wanders there is a
// defined way back.
//
// They add rather than average, which is worth being explicit about because
// averaging is the obvious alternative and it is wrong: under averaging,
// setting a per-key value does not give you that value, it gives you a third
// of it, and the number under your finger stops meaning anything. Summing
// keeps every tier a departure from what is underneath it.
//
// Feathering is what actually solves "I do not want one key to suddenly be
// different". A range edit is a rectangle with a raised-cosine ramp of a few
// keys on each side; at feather 0 it is a hard edge, which is occasionally
// what you want. The editor draws the TOTAL across the keyboard, not just the
// layer being edited, because a cliff is a thing you should be able to see.
//
// This is the same arrangement as the physically modelled variant's parameter
// editor, for the same reason: on an 88-key instrument, a control that is not
// per-key is a control that is wrong for most of the keyboard.

export const LOW = 21, HIGH = 108, KEYS = HIGH - LOW + 1;
// A0 is its own stub octave, then C1..C8: nine bands, which is how a piano is
// actually talked about ("the top octave is too bright", "lift the tenor").
export const OCTAVES = 9;
export const octaveOf = (midi) => Math.max(0, Math.min(OCTAVES - 1, Math.floor(midi / 12) - 1));
export const OCT_LABELS = ['A0', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8'];
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const noteName = (m) => NAMES[m % 12] + (Math.floor(m / 12) - 1);
const BLACK = new Set([1, 3, 6, 8, 10]);

export const PARAMS = [
  { key: 'dynamic', label: 'Dynamic range', group: 'Velocity response', def: -42, span: 18, unit: 'dB @v1',
    hint: 'How far below fortissimo a velocity of 1 lands. A real grand runs 35-45 dB; the recordings themselves only span 18, so the rest is gain and this is where it is set.' },
  { key: 'gamma', label: 'Curve', group: 'Velocity response', def: 1, span: 0.9, unit: '',
    hint: 'Below 1 the keyboard gets loud early (light action, easier to play); above 1 it holds back until you push. Applied per key, so you can flatten a hot note without touching the rest.' },
  { key: 'trim', label: 'Level trim', group: 'Velocity response', def: 0, span: 9, unit: 'dB',
    hint: 'Per-key gain. The honest use is evening out the seams where one recording hands over to the next.' },
  { key: 'layerBias', label: 'Layer bias', group: 'Velocity response', def: 0, span: 5, unit: 'lyr',
    hint: 'Which of the sixteen recorded layers a given velocity reaches for, without changing how loud it comes out. Positive is a harder, brighter recording at the same level.' },

  { key: 'pan', label: 'Position', group: 'Stereo', def: 0, span: 1, unit: '',
    hint: 'Where this key sits across the image, on top of the global spread.' },
  { key: 'width', label: 'Width', group: 'Stereo', def: 1, span: 1, unit: 'x',
    hint: 'Side-signal gain for this key. 0 is mono, 1 is the recording as made, above 1 widens.' },

  { key: 'tune', label: 'Tuning', group: 'Note', def: 0, span: 30, unit: 'cents',
    hint: 'Per-key detune. This library\'s own top octave runs up to 90 cents sharp of equal temperament; this is where you disagree with it.' },
  { key: 'resonance', label: 'Resonance send', group: 'Note', def: 1, span: 1, unit: 'x',
    hint: 'How strongly this key rings in sympathy when others are struck and its damper is off.' },
  { key: 'damping', label: 'Damper fall', group: 'Note', def: 1, span: 1.5, unit: 'x',
    hint: 'How fast the damper stops this string on key release. Real dampers are slower in the bass, and this scales that. The SHAPE of the fall is the release Bezier on the left.' },

  { key: 'releaseLevel', label: 'Key release', group: 'Release samples', def: 0, span: 18, unit: 'dB',
    hint: 'Level of this key\'s recorded key-up thud. Salamander recorded all 88 separately and they are not even; this is where you level them.' },
  { key: 'damperLevel', label: 'Damper release', group: 'Release samples', def: 0, span: 18, unit: 'dB',
    hint: 'Level of this key\'s damper-release string resonance — the sound of the damper stopping a ringing string. Scaled again by how long the key was held, on the hold curve.' },
];

const BY_KEY = new Map(PARAMS.map((p) => [p.key, p]));

export class Curves {
  constructor() {
    this.g = {};                 // one offset for the whole keyboard
    this.r = {};                 // feathered range offsets, in application order
    this.k = {};                 // per-key offsets, allocated only when drawn on
    this.baked = {};             // the ranges summed onto the keyboard, cached
    this.def = {};
    for (const p of PARAMS) {
      this.g[p.key] = 0;
      this.r[p.key] = [];
      this.k[p.key] = null;
      this.baked[p.key] = null;
      this.def[p.key] = p.def;
    }
  }

  /**
   * Sum the ranges onto the keyboard once, rather than per lookup.
   *
   * at() is called a few times per note-on and 88 times per stereo refresh,
   * and walking a list of ranges there would put the cost of the edit history
   * into the audio path.
   */
  bake(key) {
    const out = new Float32Array(KEYS);
    for (const r of this.r[key]) {
      const f = Math.max(0, r.feather);
      for (let i = 0; i < KEYS; i++) {
        const m = LOW + i;
        let w = 0;
        if (m >= r.lo && m <= r.hi) w = 1;
        else if (f > 0 && m >= r.lo - f && m < r.lo) w = 0.5 - 0.5 * Math.cos(Math.PI * (m - (r.lo - f)) / f);
        else if (f > 0 && m > r.hi && m <= r.hi + f) w = 0.5 - 0.5 * Math.cos(Math.PI * ((r.hi + f) - m) / f);
        if (w) out[i] += r.v * w;
      }
    }
    this.baked[key] = out;
    return out;
  }
  /**
   * The value in force at `midi`: default + global offset + per-key offset.
   *
   * Called a few times per note-on and 88 times per stereo refresh, so the
   * defaults are hoisted into a plain object rather than found by scanning
   * PARAMS on every lookup.
   */
  at(key, midi) {
    const i = midi - LOW;
    const per = this.k[key];
    const ranges = this.baked[key] ?? this.bake(key);
    return this.def[key] + this.g[key] + ranges[i] + (per ? per[i] : 0);
  }

  /** The total across the whole keyboard, for drawing. */
  curve(key) {
    const out = new Float32Array(KEYS);
    for (let i = 0; i < KEYS; i++) out[i] = this.at(key, LOW + i);
    return out;
  }
  setGlobal(key, v) { this.g[key] = v; }

  /**
   * The value currently in force for a scope, so a slider can show it.
   * `sel` is {lo, hi} -- the whole compass, a range, or one key.
   */
  scopeValue(key, sel) {
    if (!sel || (sel.lo <= LOW && sel.hi >= HIGH)) return this.g[key];
    if (sel.lo === sel.hi) return this.k[key]?.[sel.lo - LOW] ?? 0;
    return this.r[key].find((r) => r.lo === sel.lo && r.hi === sel.hi)?.v ?? 0;
  }

  /** Move whatever the selection points at. One slider, three tiers. */
  setScope(key, sel, v, feather = 3) {
    if (!sel || (sel.lo <= LOW && sel.hi >= HIGH)) { this.g[key] = v; return; }
    if (sel.lo === sel.hi) { this.setKey(key, sel.lo, v); return; }
    const list = this.r[key];
    const at = list.findIndex((r) => r.lo === sel.lo && r.hi === sel.hi);
    if (v === 0) { if (at >= 0) list.splice(at, 1); }
    else if (at >= 0) { list[at].v = v; list[at].feather = feather; }
    else list.push({ lo: sel.lo, hi: sel.hi, v, feather });
    this.baked[key] = null;
  }

  setFeather(key, sel, feather) {
    const r = this.r[key].find((x) => x.lo === sel.lo && x.hi === sel.hi);
    if (r) { r.feather = feather; this.baked[key] = null; }
  }

  /**
   * Smooth the per-key layer.
   *
   * Opt-in, and only this layer. Automatic smoothing would take away the
   * other half of what is wanted here -- one key really can just be wrong,
   * and fixing it has to stay possible without the fix bleeding into its
   * neighbours.
   */
  smooth(key, passes = 1) {
    const a = this.k[key];
    if (!a) return;
    for (let p = 0; p < passes; p++) {
      const src = Float32Array.from(a);
      for (let i = 0; i < KEYS; i++) {
        const l = src[Math.max(0, i - 1)], r = src[Math.min(KEYS - 1, i + 1)];
        a[i] = 0.25 * l + 0.5 * src[i] + 0.25 * r;
      }
    }
  }

  /** The biggest jump between adjacent keys in the finished curve. */
  worstStep(key) {
    const c = this.curve(key);
    let worst = 0, at = LOW;
    for (let i = 1; i < KEYS; i++) {
      const d = Math.abs(c[i] - c[i - 1]);
      if (d > worst) { worst = d; at = LOW + i; }
    }
    return { step: worst, midi: at };
  }
  setKey(key, midi, v) {
    let a = this.k[key];
    if (!a) a = this.k[key] = new Float32Array(KEYS);
    a[midi - LOW] = v;
  }
  reset(key) { this.g[key] = 0; this.r[key] = []; this.k[key] = null; this.baked[key] = null; }
  toJSON() {
    const out = { g: { ...this.g }, r: {}, k: {} };
    for (const [key, list] of Object.entries(this.r)) if (list.length) out.r[key] = list.map((x) => ({ ...x }));
    for (const [key, a] of Object.entries(this.k)) if (a) out.k[key] = Array.from(a, (v) => +v.toFixed(3));
    return out;
  }
  fromJSON(o) {
    if (!o) return;
    for (const p of PARAMS) {
      this.g[p.key] = o.g?.[p.key] ?? 0;
      this.r[p.key] = (o.r?.[p.key] ?? []).map((x) => ({ ...x }));
      // Saved edits from when this had nine fixed octave bands become nine
      // hard-edged ranges, which is exactly what they were.
      for (const [i, v] of (o.o?.[p.key] ?? []).entries()) {
        if (!v) continue;
        const lo = i === 0 ? LOW : 12 * (i + 1);
        this.r[p.key].push({ lo, hi: Math.min(HIGH, 12 * (i + 2) - 1), v, feather: 0 });
      }
      this.k[p.key] = o.k?.[p.key] ? Float32Array.from(o.k[p.key]) : null;
      this.baked[p.key] = null;
    }
  }
}

const ZOOMS = [1, 0.4, 0.15, 0.05];

/**
 * Build the editor into `root`.
 *
 * One slider per parameter, and a shared SCOPE that decides what it moves.
 * The scope is the thing being played with, so it lives once at the top
 * rather than eleven times down the side.
 */
export function createEditor(root, curves, onChange, selected = () => 60) {
  const rows = [];
  let timer = 0;
  const notify = () => { if (timer) return; timer = setTimeout(() => { timer = 0; onChange(); }, 60); };

  // The shared scope. Starts at the whole compass, because that is where
  // editing starts: you change the instrument, then you change a region of
  // it, then you change one key of it.
  const sel = { lo: LOW, hi: HIGH };
  let feather = 3;

  const scopeName = () => {
    if (sel.lo <= LOW && sel.hi >= HIGH) return 'all 88 keys';
    if (sel.lo === sel.hi) return `${noteName(sel.lo)} alone`;
    return `${noteName(sel.lo)}–${noteName(sel.hi)} (${sel.hi - sel.lo + 1} keys)`;
  };

  // ---- the scope strip ----------------------------------------------------
  const bar = document.createElement('div');
  bar.className = 'sel-bar';
  bar.innerHTML = `
    <div class="sel-head">
      <span>editing <b class="sel-what"></b></span>
      <span class="sel-actions">
        <button data-all>all keys</button>
        <button data-oct>this octave</button>
        <button data-one>selected key</button>
      </span>
    </div>
    <canvas class="sel-map" height="${34 * devicePixelRatio}"></canvas>
    <div class="sel-foot">
      <label title="How far a range edit fades out past its edges. Zero is a hard edge; a few keys is what stops a region sounding like it starts somewhere.">edge fade</label>
      <input type="range" class="sel-feather" min="0" max="14" step="1" value="3">
      <output class="sel-featherV"></output>
    </div>
    <div class="pe-hint">drag across the strip to pick a range · click one key for just that key</div>`;
  root.appendChild(bar);
  const map = bar.querySelector('.sel-map');
  const mapX = map.getContext('2d');

  function drawMap() {
    const w = map.clientWidth * devicePixelRatio;
    if (map.width !== w) map.width = w;
    const h = map.height, bw = w / KEYS;
    mapX.fillStyle = '#17150f'; mapX.fillRect(0, 0, w, h);
    for (let i = 0; i < KEYS; i++) {
      const m = LOW + i;
      const inSel = m >= sel.lo && m <= sel.hi;
      const f = feather;
      let edge = 0;
      if (!inSel && f > 0 && sel.lo !== sel.hi) {
        if (m >= sel.lo - f && m < sel.lo) edge = 0.5 - 0.5 * Math.cos(Math.PI * (m - (sel.lo - f)) / f);
        else if (m > sel.hi && m <= sel.hi + f) edge = 0.5 - 0.5 * Math.cos(Math.PI * ((sel.hi + f) - m) / f);
      }
      mapX.fillStyle = inSel ? '#d9a441' : edge ? `rgba(217,164,65,${edge * 0.55})` : (BLACK.has(m % 12) ? '#100e0a' : '#241f18');
      mapX.fillRect(i * bw, 0, Math.max(1, bw - 0.5), h - 11 * devicePixelRatio);
    }
    mapX.font = `${9 * devicePixelRatio}px ui-monospace,monospace`;
    mapX.textAlign = 'center';
    for (let m = 24; m <= HIGH; m += 12) {
      mapX.fillStyle = '#6d6458';
      mapX.fillText(noteName(m), (m - LOW) * bw + bw / 2, h - 1);
    }
    const cur = selected();
    if (cur >= LOW && cur <= HIGH) {
      mapX.strokeStyle = '#ece5da';
      mapX.strokeRect((cur - LOW) * bw + 0.5, 0.5, Math.max(1, bw - 1), h - 11 * devicePixelRatio - 1);
    }
    bar.querySelector('.sel-what').textContent = scopeName();
  }

  const keyAt = (e) => {
    const r = map.getBoundingClientRect();
    return Math.max(LOW, Math.min(HIGH, LOW + Math.floor((e.clientX - r.left) / r.width * KEYS)));
  };
  let anchor = null;
  map.onpointerdown = (e) => { anchor = keyAt(e); sel.lo = sel.hi = anchor; map.setPointerCapture(e.pointerId); refresh(); };
  map.onpointermove = (e) => {
    if (anchor == null) return;
    const k = keyAt(e);
    sel.lo = Math.min(anchor, k); sel.hi = Math.max(anchor, k);
    refresh();
  };
  map.onpointerup = map.onpointercancel = () => { anchor = null; };
  bar.querySelector('[data-all]').onclick = () => { sel.lo = LOW; sel.hi = HIGH; refresh(); };
  bar.querySelector('[data-oct]').onclick = () => {
    const o = octaveOf(selected());
    sel.lo = Math.max(LOW, o === 0 ? LOW : 12 * (o + 1));
    sel.hi = Math.min(HIGH, 12 * (o + 2) - 1);
    refresh();
  };
  bar.querySelector('[data-one]').onclick = () => { sel.lo = sel.hi = selected(); refresh(); };
  const fSlider = bar.querySelector('.sel-feather');
  fSlider.oninput = () => {
    feather = +fSlider.value;
    bar.querySelector('.sel-featherV').textContent = feather ? `${feather} keys` : 'hard edge';
    for (const p of PARAMS) curves.setFeather(p.key, sel, feather);
    refresh(); notify();
  };
  bar.querySelector('.sel-featherV').textContent = '3 keys';

  // ---- one row per parameter ---------------------------------------------
  const groups = new Map();
  for (const p of PARAMS) { if (!groups.has(p.group)) groups.set(p.group, []); groups.get(p.group).push(p); }
  for (const [name, list] of groups) {
    const h = document.createElement('h3');
    h.className = 'pe-group'; h.textContent = name;
    root.appendChild(h);
    for (const p of list) rows.push(makeRow(p));
  }

  function fmt(p, v) {
    const a = Math.abs(v);
    const s2 = a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : v.toFixed(2);
    return `${s2}${p.unit ? ' ' + p.unit : ''}`;
  }

  function makeRow(p) {
    const wrap = document.createElement('div');
    wrap.className = 'pe-row';
    wrap.innerHTML = `
      <div class="pe-head">
        <label title="${p.hint.replace(/"/g, '&quot;')}">${p.label}</label>
        <input type="range" class="pe-slider" min="-1" max="1" step="0.002" value="0">
        <output class="pe-out"></output>
        <select class="pe-zoom" title="precision — zooms the slider and the chart">
          ${ZOOMS.map((z, i) => `<option value="${i}">±${(p.span * z).toPrecision(2)}</option>`).join('')}
        </select>
        <button class="pe-smooth" title="round off the per-key layer, so a fix does not stand alone as a step">smooth</button>
        <button class="pe-reset" title="back to the shipped value, every tier">reset</button>
      </div>
      <div class="pe-canvas-wrap"><canvas class="pe-keys" height="${76 * devicePixelRatio}"></canvas>
        <div class="pe-hint pe-step"></div></div>`;
    root.appendChild(wrap);

    const slider = wrap.querySelector('.pe-slider');
    const out = wrap.querySelector('.pe-out');
    const zoom = wrap.querySelector('.pe-zoom');
    const canvas = wrap.querySelector('.pe-keys');
    const ctx = canvas.getContext('2d');
    let zi = 0;
    const span = () => p.span * ZOOMS[zi];

    const draw = () => {
      const w = canvas.clientWidth * devicePixelRatio;
      if (canvas.width !== w) canvas.width = w;
      const h = canvas.height, mid = h / 2, bw = w / KEYS;
      ctx.fillStyle = '#17150f'; ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < KEYS; i++) {
        const m = LOW + i;
        if (m >= sel.lo && m <= sel.hi) { ctx.fillStyle = '#211c13'; ctx.fillRect(i * bw, 0, bw, h); }
        else if (BLACK.has(m % 12)) { ctx.fillStyle = '#131109'; ctx.fillRect(i * bw, 0, bw, h); }
      }
      ctx.strokeStyle = '#4a4134'; ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke();

      const per = curves.k[p.key];
      for (let i = 0; i < KEYS; i++) {
        const v = per ? per[i] : 0;
        if (!v) continue;
        const y = mid - (v / span()) * (h / 2 - 2);
        ctx.fillStyle = v > 0 ? '#8a6a2a' : '#3f627e';
        ctx.fillRect(i * bw + 0.5, Math.min(y, mid), Math.max(1, bw - 1), Math.max(1, Math.abs(y - mid)));
      }

      // The TOTAL -- global plus ranges plus per key -- because a cliff is a
      // property of the sum and nothing else on screen would show it.
      const total = curves.curve(p.key);
      ctx.strokeStyle = '#d9a441'; ctx.lineWidth = 1.6 * devicePixelRatio;
      ctx.beginPath();
      for (let i = 0; i < KEYS; i++) {
        const off = total[i] - p.def;
        const y = Math.max(1, Math.min(h - 1, mid - (off / span()) * (h / 2 - 2)));
        const x = i * bw + bw / 2;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.stroke();

      const cur = selected();
      if (cur >= LOW && cur <= HIGH) {
        ctx.strokeStyle = '#ece5da'; ctx.lineWidth = 1;
        ctx.strokeRect((cur - LOW) * bw + 0.5, 0.5, Math.max(1, bw - 1), h - 1);
      }

      slider.value = Math.max(-1, Math.min(1, curves.scopeValue(p.key, sel) / span()));
      out.textContent = `${noteName(cur)} ${fmt(p, curves.at(p.key, cur))}`;
      const { step, midi } = curves.worstStep(p.key);
      wrap.querySelector('.pe-step').textContent = step > 1e-4
        ? `biggest jump between neighbours: ${fmt(p, step)} at ${noteName(midi)}`
        : 'flat across the keyboard';
    };

    slider.oninput = () => { curves.setScope(p.key, sel, +slider.value * span(), feather); draw(); notify(); };
    zoom.onchange = () => {
      zi = +zoom.value;
      // The stored value is absolute, so re-derive the slider position rather
      // than rescaling what it means -- otherwise a curve drawn at one
      // precision silently changes when you pick another.
      draw();
    };
    wrap.querySelector('.pe-smooth').onclick = () => { curves.smooth(p.key, 2); draw(); notify(); };
    wrap.querySelector('.pe-reset').onclick = () => { curves.reset(p.key); draw(); notify(); };

    // Drawing straight onto the chart still edits the per-key layer, which is
    // the fastest way to say "these four notes, not a region".
    let drawing = false;
    const paint = (e) => {
      const r = canvas.getBoundingClientRect();
      const i = Math.max(0, Math.min(KEYS - 1, Math.floor((e.clientX - r.left) / r.width * KEYS)));
      const rel = 1 - (e.clientY - r.top) / r.height * 2;
      curves.setKey(p.key, LOW + i, e.shiftKey ? (curves.k[p.key]?.[i] ?? 0) * 0.6 : rel * span() - (curves.at(p.key, LOW + i) - p.def - (curves.k[p.key]?.[i] ?? 0)));
      draw(); notify();
    };
    canvas.onpointerdown = (e) => { drawing = true; canvas.setPointerCapture(e.pointerId); paint(e); };
    canvas.onpointermove = (e) => { if (drawing) paint(e); };
    canvas.onpointerup = canvas.onpointercancel = () => { drawing = false; };

    draw();
    return { draw };
  }

  function refresh() { drawMap(); for (const r of rows) r.draw(); }
  drawMap();
  return { refresh };
}
