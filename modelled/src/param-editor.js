// The parameter editor: a slider and a drawable per-key curve for everything.
//
// Two controls per parameter, and they add:
//
//   the slider    one offset for the whole keyboard, centred on the fitted
//                 curve. Centre is always "as shipped", so however far an
//                 edit wanders there is a defined way back.
//   the canvas    a per-key offset on top of that, drawn by dragging across
//                 it. Bars rise and fall from a centre line rather than from
//                 the floor, because what is being drawn is a departure from
//                 the fit and not a value -- a bar at the line means "leave
//                 this note alone".
//
// Precision is a ZOOM on both, not a separate parameter. The stored number is
// an absolute offset, so tightening the range to draw a fine curve on one note
// cannot silently rescale what was drawn at a coarser setting earlier. That is
// the trap in this kind of editor and it is worth the extra field to avoid.
import { PARAMS } from './dsp/offsets.js';
import { DEFAULT_SCALE, lerpTable } from './dsp/scale.js';

const LOW = 21, KEYS = 88;
const ZOOMS = [1, 0.5, 0.25, 0.1, 0.04];
const KEY_W = 9, CANVAS_H = 96;
const BLACK = new Set([1, 3, 6, 8, 10]);
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (m) => NAMES[m % 12] + (Math.floor(m / 12) - 1);

export function createEditor(root, { offsets, onChange, selectedNote = () => 60 }) {
  const rows = [];
  const groups = new Map();
  for (const p of PARAMS) {
    if (!groups.has(p.group)) groups.set(p.group, []);
    groups.get(p.group).push(p);
  }

  const notify = () => onChange(offsets.toJSON());
  // Dragging produces a lot of edits; the engine only needs the latest.
  let pending = null, timer = 0;
  const notifySoon = () => {
    pending = true;
    if (timer) return;
    timer = setTimeout(() => { timer = 0; if (pending) { pending = false; notify(); } }, 70);
  };

  function baseAt(p, midi) {
    if (p.scope === 'global') return p.base;
    const table = DEFAULT_SCALE.voicing[p.key];
    return table ? lerpTable(table, midi) : 0;
  }
  const effective = (p, midi) => offsets.apply(p.key, midi, baseAt(p, midi));

  function fmt(v) {
    if (v === 0) return '0';
    const a = Math.abs(v);
    if (a >= 1000) return v.toFixed(0);
    if (a >= 10) return v.toFixed(1);
    if (a >= 1) return v.toFixed(2);
    if (a >= 0.01) return v.toFixed(3);
    return v.toExponential(1);
  }

  for (const [group, list] of groups) {
    const h = document.createElement('h3');
    h.className = 'pe-group';
    h.textContent = group;
    root.appendChild(h);
    for (const p of list) rows.push(makeRow(p));
  }

  function makeRow(p) {
    const wrap = document.createElement('div');
    wrap.className = 'pe-row';
    const perKey = p.scope !== 'global';
    wrap.innerHTML = `
      <div class="pe-head">
        <label title="${p.key}">${p.label}</label>
        <input type="range" class="pe-slider" min="-1" max="1" step="0.001" value="0">
        <output class="pe-out"></output>
        <select class="pe-zoom" title="precision — zooms the slider and the chart">
          ${ZOOMS.map((z, i) => `<option value="${i}">±${(p.span * z).toPrecision(2)}</option>`).join('')}
        </select>
        ${perKey ? '<button class="pe-draw" title="per-key offsets">draw</button>' : ''}
        <button class="pe-reset" title="back to the fitted curve">reset</button>
      </div>`;
    const slider = wrap.querySelector('.pe-slider');
    const out = wrap.querySelector('.pe-out');
    const zoomSel = wrap.querySelector('.pe-zoom');
    let zoom = 0, canvas = null, ctx2d = null;

    const span = () => p.span * ZOOMS[zoom];

    const paintOut = () => {
      const midi = selectedNote();
      const g = offsets.global.get(p.key) ?? 0;
      const sign = g > 0 ? '+' : '';
      const off = p.mode === 'add' ? `${sign}${fmt(g)}` : `${sign}${fmt(g)} oct`;
      out.textContent = `${off}  ·  ${noteName(midi)} ${fmt(effective(p, midi))}${p.unit ? ' ' + p.unit : ''}`;
    };

    slider.addEventListener('input', () => {
      offsets.setGlobal(p.key, +slider.value * span());
      paintOut(); paintCanvas(); notifySoon();
    });
    // A slider whose centre is the default deserves a way back to it that does
    // not involve aiming at one pixel.
    slider.addEventListener('dblclick', () => {
      slider.value = 0; offsets.setGlobal(p.key, 0); paintOut(); paintCanvas(); notify();
    });
    zoomSel.addEventListener('change', () => {
      zoom = +zoomSel.value;
      // Keep the stored offset and move the HANDLE, rather than the reverse.
      const g = offsets.global.get(p.key) ?? 0;
      slider.value = Math.max(-1, Math.min(1, g / span()));
      paintOut(); paintCanvas();
    });
    wrap.querySelector('.pe-reset').addEventListener('click', () => {
      offsets.clear(p.key); slider.value = 0; paintOut(); paintCanvas(); notify();
    });

    if (perKey) {
      const holder = document.createElement('div');
      holder.className = 'pe-canvas-wrap';
      holder.style.display = 'none';
      canvas = document.createElement('canvas');
      canvas.width = KEYS * KEY_W;
      canvas.height = CANVAS_H;
      holder.appendChild(canvas);
      const hint = document.createElement('div');
      hint.className = 'pe-hint';
      hint.textContent = 'drag to draw · shift-drag flattens back to the curve · double-click clears';
      holder.appendChild(hint);
      wrap.appendChild(holder);
      ctx2d = canvas.getContext('2d');

      wrap.querySelector('.pe-draw').addEventListener('click', (e) => {
        const open = holder.style.display === 'none';
        holder.style.display = open ? 'block' : 'none';
        e.target.classList.toggle('on', open);
        if (open) paintCanvas();
      });

      let drawing = false, lastIdx = -1;
      const at = (e) => {
        const r = canvas.getBoundingClientRect();
        const x = ((e.clientX - r.left) / r.width) * KEYS;
        const y = (e.clientY - r.top) / r.height;
        return { idx: Math.max(0, Math.min(KEYS - 1, Math.floor(x))), v: (0.5 - y) * 2 * span() };
      };
      const put = (idx, v, flat) => offsets.setKey(p.key, idx + LOW, flat ? 0 : v);
      const stroke = (e) => {
        const { idx, v } = at(e);
        // Fill in what a fast drag skipped, or the curve comes out with holes.
        if (lastIdx >= 0 && Math.abs(idx - lastIdx) > 1) {
          const step = idx > lastIdx ? 1 : -1;
          for (let i = lastIdx + step; i !== idx; i += step) put(i, v, e.shiftKey);
        }
        put(idx, v, e.shiftKey);
        lastIdx = idx;
        paintCanvas(); paintOut(); notifySoon();
      };
      canvas.addEventListener('pointerdown', (e) => {
        drawing = true; lastIdx = -1; canvas.setPointerCapture(e.pointerId); stroke(e); e.preventDefault();
      });
      canvas.addEventListener('pointermove', (e) => { if (drawing) stroke(e); });
      const stop = () => { if (drawing) { drawing = false; notify(); } };
      canvas.addEventListener('pointerup', stop);
      canvas.addEventListener('pointercancel', stop);
      canvas.addEventListener('dblclick', () => {
        offsets.keys.delete(p.key); paintCanvas(); paintOut(); notify();
      });
    }

    function paintCanvas() {
      if (!ctx2d || wrap.querySelector('.pe-canvas-wrap').style.display === 'none') return;
      const g = ctx2d, h = CANVAS_H, mid = h / 2, s = span();
      g.clearRect(0, 0, KEYS * KEY_W, h);
      for (let i = 0; i < KEYS; i++) {
        const midi = i + LOW;
        g.fillStyle = BLACK.has(midi % 12) ? '#0f131c' : '#151b26';
        g.fillRect(i * KEY_W, 0, KEY_W - 1, h);
      }
      // Octave marks, so a note can be found without counting.
      g.fillStyle = '#343d4e';
      for (let i = 0; i < KEYS; i++) if ((i + LOW) % 12 === 0) g.fillRect(i * KEY_W, 0, 1, h);
      g.fillStyle = '#414c62';
      g.fillRect(0, mid, KEYS * KEY_W, 1);

      const arr = offsets.keys.get(p.key);
      for (let i = 0; i < KEYS; i++) {
        const v = arr ? arr[i] : 0;
        if (!v) continue;
        const clipped = Math.abs(v) > s;
        const px = Math.max(-mid, Math.min(mid, (v / s) * mid));
        g.fillStyle = clipped ? '#c0392b' : (v > 0 ? '#d8c4a2' : '#8da1be');
        g.fillRect(i * KEY_W, px > 0 ? mid - px : mid, KEY_W - 1, Math.max(1, Math.abs(px)));
      }
      const sel = selectedNote() - LOW;
      if (sel >= 0 && sel < KEYS) {
        g.strokeStyle = '#e5e1dc';
        g.strokeRect(sel * KEY_W - 0.5, 0.5, KEY_W, h - 1);
      }
    }

    paintOut();
    root.appendChild(wrap);
    return { p, slider, zoomSel, paintOut, paintCanvas, sync() {
      const g = offsets.global.get(p.key) ?? 0;
      slider.value = Math.max(-1, Math.min(1, g / span()));
      paintOut(); paintCanvas();
    } };
  }

  return {
    /** Re-read everything from the offsets object (after a load or a reset). */
    sync() { rows.forEach((r) => r.sync()); },
    /** The selected key moved: only the readouts and the highlight change. */
    refreshSelection() { rows.forEach((r) => { r.paintOut(); r.paintCanvas(); }); },
  };
}
