// Per-key parameters, and the editor that draws them.
//
// Everything a player would want to differ from note to note is a curve across
// the keyboard rather than a single number: velocity response, level, stereo
// position, tuning, how much a key joins in sympathetically. Each parameter
// has one slider that moves the whole compass and one canvas you can draw a
// per-key departure on. Both add, and both are stored as offsets from the
// default -- so zero is always "as shipped" and however far an edit wanders
// there is a defined way back.
//
// This is the same arrangement as the physically modelled variant's parameter
// editor, for the same reason: on an 88-key instrument, a control that is not
// per-key is a control that is wrong for most of the keyboard.

export const LOW = 21, HIGH = 108, KEYS = HIGH - LOW + 1;
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const noteName = (m) => NAMES[m % 12] + (Math.floor(m / 12) - 1);
const BLACK = new Set([1, 3, 6, 8, 10]);

export const PARAMS = [
  { key: 'dynamic', label: 'Dynamic range', group: 'Velocity response', def: -42, span: 18, unit: 'dB at vel 1',
    hint: 'How far below fortissimo a velocity of 1 lands. A real grand runs 35-45 dB; the recordings themselves only span 18, so the rest is gain and this is where it is set.' },
  { key: 'gamma', label: 'Curve', group: 'Velocity response', def: 1, span: 0.9, unit: '',
    hint: 'Below 1 the keyboard gets loud early (light action, easier to play); above 1 it holds back until you push. Applied per key, so you can flatten a hot note without touching the rest.' },
  { key: 'trim', label: 'Level trim', group: 'Velocity response', def: 0, span: 9, unit: 'dB',
    hint: 'Per-key gain. The honest use is evening out the seams where one recording hands over to the next.' },
  { key: 'layerBias', label: 'Layer bias', group: 'Velocity response', def: 0, span: 5, unit: 'layers',
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
    this.k = {};                 // per-key offsets, allocated only when drawn on
    this.def = {};
    for (const p of PARAMS) { this.g[p.key] = 0; this.k[p.key] = null; this.def[p.key] = p.def; }
  }
  /**
   * The value in force at `midi`: default + global offset + per-key offset.
   *
   * Called a few times per note-on and 88 times per stereo refresh, so the
   * defaults are hoisted into a plain object rather than found by scanning
   * PARAMS on every lookup.
   */
  at(key, midi) {
    const per = this.k[key];
    return this.def[key] + this.g[key] + (per ? per[midi - LOW] : 0);
  }
  setGlobal(key, v) { this.g[key] = v; }
  setKey(key, midi, v) {
    let a = this.k[key];
    if (!a) a = this.k[key] = new Float32Array(KEYS);
    a[midi - LOW] = v;
  }
  reset(key) { this.g[key] = 0; this.k[key] = null; }
  toJSON() {
    const o = { g: { ...this.g }, k: {} };
    for (const [key, a] of Object.entries(this.k)) if (a) o.k[key] = Array.from(a, (v) => +v.toFixed(3));
    return o;
  }
  fromJSON(o) {
    if (!o) return;
    for (const p of PARAMS) {
      this.g[p.key] = o.g?.[p.key] ?? 0;
      this.k[p.key] = o.k?.[p.key] ? Float32Array.from(o.k[p.key]) : null;
    }
  }
}

const ZOOMS = [1, 0.4, 0.15, 0.05];

/** Build the editor UI into `root`. `onChange` fires (coalesced) on every edit. */
export function createEditor(root, curves, onChange, selected = () => 60) {
  const rows = [];
  let timer = 0;
  const notify = () => { if (timer) return; timer = setTimeout(() => { timer = 0; onChange(); }, 60); };

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
    const s = a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : v.toFixed(2);
    return `${s}${p.unit ? ' ' + p.unit : ''}`;
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
        <button class="pe-reset" title="back to the shipped value">reset</button>
      </div>
      <div class="pe-canvas-wrap"><canvas height="${72 * devicePixelRatio}"></canvas>
        <div class="pe-hint">drag to draw per-key · shift-drag to flatten toward the line</div></div>`;
    root.appendChild(wrap);

    const slider = wrap.querySelector('.pe-slider');
    const out = wrap.querySelector('.pe-out');
    const zoom = wrap.querySelector('.pe-zoom');
    const canvas = wrap.querySelector('canvas');
    const ctx = canvas.getContext('2d');
    let zi = 0;

    const span = () => p.span * ZOOMS[zi];
    const draw = () => {
      const w = canvas.clientWidth * devicePixelRatio;
      if (canvas.width !== w) canvas.width = w;
      const h = canvas.height, mid = h / 2, bw = w / KEYS;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = '#17150f'; ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < KEYS; i++) {
        if (!BLACK.has((LOW + i) % 12)) continue;
        ctx.fillStyle = '#100e0a'; ctx.fillRect(i * bw, 0, bw, h);
      }
      ctx.strokeStyle = '#4a4134'; ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke();
      const per = curves.k[p.key];
      for (let i = 0; i < KEYS; i++) {
        const v = per ? per[i] : 0;
        const y = mid - (v / span()) * (h / 2 - 2);
        ctx.fillStyle = v === 0 ? '#3a3328' : (v > 0 ? '#d9a441' : '#6fa8dc');
        const top = Math.min(y, mid), hh = Math.max(1, Math.abs(y - mid));
        ctx.fillRect(i * bw + 0.5, top, Math.max(1, bw - 1), hh);
      }
      const sel = selected() - LOW;
      if (sel >= 0 && sel < KEYS) {
        ctx.strokeStyle = '#ece5da'; ctx.lineWidth = 1;
        ctx.strokeRect(sel * bw + 0.5, 0.5, Math.max(1, bw - 1), h - 1);
      }
      const at = curves.at(p.key, selected());
      out.textContent = `${noteName(selected())} ${fmt(p, at)}`;
    };

    slider.oninput = () => { curves.setGlobal(p.key, +slider.value * span()); draw(); notify(); };
    zoom.onchange = () => {
      zi = +zoom.value;
      // The stored value is absolute, so re-derive the slider position rather
      // than rescaling what it means -- otherwise a curve drawn at one
      // precision silently changes when you pick another.
      slider.value = Math.max(-1, Math.min(1, curves.g[p.key] / span()));
      draw();
    };
    wrap.querySelector('.pe-reset').onclick = () => {
      curves.reset(p.key); slider.value = 0; draw(); notify();
    };

    let drawing = false;
    const paint = (e) => {
      const r = canvas.getBoundingClientRect();
      const i = Math.max(0, Math.min(KEYS - 1, Math.floor((e.clientX - r.left) / r.width * KEYS)));
      const rel = 1 - (e.clientY - r.top) / r.height * 2;      // +1 top, -1 bottom
      const v = e.shiftKey ? (curves.k[p.key]?.[i] ?? 0) * 0.6 : rel * span();
      curves.setKey(p.key, LOW + i, v);
      draw(); notify();
    };
    canvas.onpointerdown = (e) => { drawing = true; canvas.setPointerCapture(e.pointerId); paint(e); };
    canvas.onpointermove = (e) => { if (drawing) paint(e); };
    canvas.onpointerup = canvas.onpointercancel = () => { drawing = false; };

    draw();
    return { p, draw, slider, refresh: () => { slider.value = Math.max(-1, Math.min(1, curves.g[p.key] / span())); draw(); } };
  }

  return { refresh: () => rows.forEach((r) => r.refresh()) };
}
