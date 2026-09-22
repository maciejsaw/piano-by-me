// The on-screen keyboard.
//
// Click to play, with the velocity taken from where on the key you clicked --
// near the front edge is soft, at the back is hard, which is at least in the
// same spirit as what a real key does. Shift-click lifts a key's dampers
// without striking it, which is the way to hear the sympathetic resonance on
// its own.
const WHITE = [0, 2, 4, 5, 7, 9, 11];
const isBlack = (m) => !WHITE.includes(m % 12);

export function buildKeyboard(inner, { lo, hi, onDown, onUp, onSelect, onSilent }) {
  inner.innerHTML = '';
  const el = new Map();
  const W = 15;
  let x = 0;
  const xs = new Map();
  for (let m = lo; m <= hi; m++) {
    if (isBlack(m)) continue;
    xs.set(m, x); x += W;
  }
  inner.style.width = `${x + 2}px`;

  const make = (m, cls, left, w, h) => {
    const d = document.createElement('div');
    d.className = cls;
    d.style.left = `${left}px`; d.style.width = `${w}px`; d.style.height = `${h}px`;
    d.dataset.m = m;
    if (!isBlack(m) && m % 12 === 0) d.innerHTML = `<span>C${Math.floor(m / 12) - 1}</span>`;
    inner.appendChild(d);
    el.set(m, d);
  };
  for (let m = lo; m <= hi; m++) if (!isBlack(m)) make(m, 'wk', xs.get(m), W - 1, 150);
  for (let m = lo; m <= hi; m++) {
    if (!isBlack(m)) continue;
    let prev = m - 1;
    while (prev >= lo && isBlack(prev)) prev--;
    make(m, 'bk', (xs.get(prev) ?? 0) + W * 0.66, W * 0.66, 95);
  }

  let held = null;
  const velFrom = (e, d) => {
    const r = d.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
    return Math.round(18 + 109 * (1 - t));      // back of the key is hard
  };
  inner.addEventListener('pointerdown', (e) => {
    const d = e.target.closest('.wk,.bk');
    if (!d) return;
    const m = +d.dataset.m;
    onSelect(m);
    if (e.shiftKey) { onSilent(m); return; }
    inner.setPointerCapture(e.pointerId);
    held = m;
    onDown(m, velFrom(e, d));
  });
  const up = () => { if (held != null) { onUp(held); held = null; } };
  inner.addEventListener('pointerup', up);
  inner.addEventListener('pointercancel', up);

  return {
    paint(m, { down, silent, selected, resonating }) {
      const d = el.get(m);
      if (!d) return;
      d.classList.toggle('dn', !!down);
      d.classList.toggle('sel', !!selected);
      d.classList.toggle('sil', !!silent);
      d.classList.toggle('res', !!resonating);
    },
    el,
  };
}
