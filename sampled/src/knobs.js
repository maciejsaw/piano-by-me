// Round knobs that stand in for range inputs elsewhere on the page: turning
// one sets the input and fires its `input` event, and `change` when the turn
// is over (as a slider does when let go), so the input's own handlers do the
// work and the saving, and the two never disagree. Drag up / down
// (or left / right), scroll, or use the arrow keys; double-click resets to
// the input's value as shipped in the markup.
const A0 = -135, A1 = 135;     // degrees, from straight up

function arc(cx, cy, r, a0, a1) {
  const p = (a) => [cx + r * Math.sin(a * Math.PI / 180), cy - r * Math.cos(a * Math.PI / 180)];
  const [x0, y0] = p(a0), [x1, y1] = p(a1);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

/** A knob for `input` (a range), labelled `label`, showing the text of `out`. */
export function knob(input, label, out) {
  const min = +input.min, max = +input.max, step = +input.step || (max - min) / 200;
  const wrap = document.createElement('div');
  wrap.className = 'knob';
  wrap.innerHTML = `
    <div class="knob-dial" tabindex="0" role="slider" aria-label="${label}" aria-valuemin="${min}" aria-valuemax="${max}">
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <path class="knob-track" d="${arc(32, 32, 26, A0, A1)}"/>
        <path class="knob-fill"/>
        <circle class="knob-cap" cx="32" cy="32" r="19"/>
        <line class="knob-mark" x1="32" y1="18" x2="32" y2="24"/>
      </svg>
    </div>
    <div class="knob-label">${label}</div>
    <div class="knob-value"></div>`;
  const dial = wrap.querySelector('.knob-dial');
  const fill = wrap.querySelector('.knob-fill');
  const mark = wrap.querySelector('.knob-mark');
  const val = wrap.querySelector('.knob-value');
  let shown = null;

  const frac = () => (+input.value - min) / (max - min);
  function sync() {
    const v = input.value, text = out?.textContent ?? v;
    if (v === shown && val.textContent === text) return;
    shown = v;
    const a = A0 + (A1 - A0) * frac();
    fill.setAttribute('d', a > A0 + 0.5 ? arc(32, 32, 26, A0, a) : '');
    mark.setAttribute('transform', `rotate(${a.toFixed(1)} 32 32)`);
    val.textContent = text;
    dial.setAttribute('aria-valuenow', v);
    dial.setAttribute('aria-valuetext', text);
  }
  function set(v) {
    v = Math.max(min, Math.min(max, Math.round((v - min) / step) * step + min));
    if (+input.value === v) return;
    input.value = v;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    moved = true;
    sync();
  }

  // `change` once a turn is over: pointer up, key up, or a pause in scrolling.
  let moved = false, wheelT = 0;
  const done = () => { if (moved) { moved = false; input.dispatchEvent(new Event('change', { bubbles: true })); } };

  let drag = null;
  dial.addEventListener('pointerdown', (e) => {
    dial.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, y: e.clientY, f: frac() };
    e.preventDefault();
    dial.focus();
  });
  dial.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const d = (drag.y - e.clientY + e.clientX - drag.x) / (e.shiftKey ? 800 : 200);
    set(min + (max - min) * Math.max(0, Math.min(1, drag.f + d)));
  });
  const end = () => { drag = null; done(); };
  dial.addEventListener('pointerup', end);
  dial.addEventListener('pointercancel', end);
  dial.addEventListener('wheel', (e) => {
    e.preventDefault();
    set(+input.value - Math.sign(e.deltaY) * (max - min) / 100);
    clearTimeout(wheelT); wheelT = setTimeout(done, 300);
  }, { passive: false });
  dial.addEventListener('keyup', done);
  dial.addEventListener('keydown', (e) => {
    const k = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
    if (!k) return;
    e.preventDefault();
    e.stopPropagation();      // not a note on the computer keyboard
    set(+input.value + k * (max - min) / (e.shiftKey ? 200 : 50));
  });
  dial.addEventListener('dblclick', () => { set(+input.defaultValue); done(); });
  input.addEventListener('input', sync);

  sync();
  return { el: wrap, sync };
}
