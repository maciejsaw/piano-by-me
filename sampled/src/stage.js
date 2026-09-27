// The picture above the keyboard: every note played rises from its key as a
// bar, long while the key is held, and drifts up and away after -- one
// colour for white keys, one for black. Under the bars, each string the resonance is
// sounding glows faintly from the keyboard up, as tall as it is loud.
//
// Laid out on the same key positions as the keyboard (keyboard.js), so a bar
// stands exactly over its key. Draws only while something moves or rings.
const WHITE = [0, 2, 4, 5, 7, 9, 11];
const isBlack = (m) => !WHITE.includes(m % 12);
const SPEED = 70;        // CSS px per second the bars rise
const MAX_NOTES = 400;

/** Key m's left edge and width as fractions of the keyboard, as keyboard.js lays it out. */
export function keyGeometry(lo, hi) {
  let n = 0;
  for (let m = lo; m <= hi; m++) if (!isBlack(m)) n++;
  const W = 1 / n, geo = new Map();
  let x = 0;
  for (let m = lo; m <= hi; m++) {
    if (isBlack(m)) continue;
    geo.set(m, { x, w: W, black: false });
    x += W;
  }
  for (let m = lo; m <= hi; m++) {
    if (!isBlack(m)) continue;
    let prev = m - 1;
    while (prev >= lo && isBlack(prev)) prev--;
    const px = geo.get(prev)?.x ?? 0;
    geo.set(m, { x: px + W * 0.66, w: W * 0.66, black: true });
  }
  return geo;
}

// Two colours only: a note on a white key, a note on a black key.
// Each a shade with a little yellow in it, strongest at the keys and gone
// by the top of the picture.
const WHITE_NOTE = [250, 236, 200], BLACK_NOTE = [232, 184, 92];

export function createStage(canvas, { lo, hi, res }) {
  const g = canvas.getContext('2d');
  const geo = keyGeometry(lo, hi);
  const notes = [];                  // { m, t0, t1 (null while held) }
  const heldNote = new Map();        // m -> its note, while down
  let raf = 0, lastRes = false;

  const now = () => performance.now() / 1000;

  function frame() {
    raf = 0;
    const dpr = devicePixelRatio || 1;
    const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
    if (!w || !h) return;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const t = now();

    // No background: the canvas is clear, so whatever is behind it shows.
    g.clearRect(0, 0, w, h);

    // Resonance: a glow per sounding string, on a 48 dB scale.
    const r = res();
    let ringing = false;
    if (r) {
      for (let i = 0; i < r.n; i++) {
        const e = r.level[i];
        if (!(e > 0)) continue;
        const k = geo.get(r.lo + i);
        if (!k) continue;
        const v = Math.max(0, Math.min(1, 1 + 20 * Math.log10(e) / 48));
        if (v <= 0) continue;
        ringing = true;
        const top = h - v * h * 0.8;
        const grad = g.createLinearGradient(0, h, 0, top);
        grad.addColorStop(0, `rgba(240,190,90,${(0.1 + 0.3 * v).toFixed(3)})`);
        grad.addColorStop(1, 'rgba(240,190,90,0)');
        g.fillStyle = grad;
        const cx = (k.x + k.w / 2) * w, bw = Math.max(1 * dpr, k.w * w * 0.3);
        g.fillRect(cx - bw / 2, top, bw, h - top);
      }
    }

    // Notes, rising.
    const px = SPEED * dpr;
    const fadeUp = ([r, gg, b]) => {
      const f = g.createLinearGradient(0, h, 0, 0);
      f.addColorStop(0, `rgba(${r},${gg},${b},0.95)`);
      f.addColorStop(0.6, `rgba(${r},${gg},${b},0.35)`);
      f.addColorStop(1, `rgba(${r},${gg},${b},0)`);
      return f;
    };
    const fills = [fadeUp(WHITE_NOTE), fadeUp(BLACK_NOTE)];
    g.shadowColor = 'rgba(255,200,90,0.55)';
    g.shadowBlur = 8 * dpr;
    let live = false;
    for (let i = notes.length - 1; i >= 0; i--) {
      const n = notes[i];
      const bottom = h - (n.t1 == null ? 0 : (t - n.t1) * px);
      const top = h - (t - n.t0) * px - 3 * dpr;
      if (bottom < 0) { notes.splice(i, 1); continue; }
      live = true;
      const k = geo.get(n.m);
      const bw = Math.max(2 * dpr, k.w * w * 0.55), x = k.x * w + (k.w * w - bw) / 2;
      // A thin bar with a soft glow, fading toward the top.
      g.fillStyle = fills[k.black ? 1 : 0];
      roundRect(g, x, top, bw, Math.max(2 * dpr, bottom - top), bw / 2);
      g.fill();
    }
    g.shadowBlur = 0;

    // Only the rising notes need every frame; resonance is
    // polled, and tick() asks for a frame when it has something to show.
    if (live) start();
    lastRes = ringing;
  }

  function start() { if (!raf) raf = requestAnimationFrame(frame); }

  return {
    noteOn(m) {
      if (!geo.has(m)) return;
      const n = { m, t0: now(), t1: null };
      heldNote.get(m) && (heldNote.get(m).t1 = n.t0);
      heldNote.set(m, n);
      notes.push(n);
      if (notes.length > MAX_NOTES) notes.splice(0, notes.length - MAX_NOTES);
      start();
    },
    noteOff(m) {
      const n = heldNote.get(m);
      if (n) { n.t1 = now(); heldNote.delete(m); }
      start();
    },
    clear() { for (const n of notes) if (n.t1 == null) n.t1 = now(); heldNote.clear(); start(); },
    /** From the resonance poll: a frame if anything rings, or just stopped. */
    tick() {
      const r = res();
      const ringing = !!r && r.level.some((e) => e > 0);
      if (ringing || lastRes) start();
    },
  };
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
