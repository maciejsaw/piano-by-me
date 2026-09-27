// The picture above the keyboard: every note played rises from its key as a
// bar, long while the key is held, brighter the harder it was struck, and
// drifts up and away after. Under the bars, each string the resonance is
// sounding glows from the keyboard up, as tall as it is loud, over a faint
// wash on every string whose damper is off.
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

/** A velocity's colour: cool and dim for pianissimo, warm gold for fortissimo. */
function tint(vel, a) {
  const t = Math.max(0, Math.min(1, (vel - 1) / 126));
  const h = 210 - 172 * t, s = 45 + 40 * t, l = 52 + 14 * t;
  return `hsla(${h.toFixed(0)},${s.toFixed(0)}%,${l.toFixed(0)}%,${a.toFixed(3)})`;
}

export function createStage(canvas, { lo, hi, res, undamped }) {
  const g = canvas.getContext('2d');
  const geo = keyGeometry(lo, hi);
  const notes = [];                  // { m, vel, t0, t1 (null while held) }
  const heldNote = new Map();        // m -> its note, while down
  let raf = 0, lastRes = false, lastOff = -1;

  const now = () => performance.now() / 1000;

  function frame() {
    raf = 0;
    const dpr = devicePixelRatio || 1;
    const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
    if (!w || !h) return;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const t = now();

    // Background: a soft vertical fade, a guide at every C.
    const bg = g.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#0f0d0b'); bg.addColorStop(1, '#1a1612');
    g.fillStyle = bg; g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(236,229,218,0.045)';
    for (let m = lo; m <= hi; m++) if (m % 12 === 0) g.fillRect(Math.round(geo.get(m).x * w), 0, Math.max(1, dpr), h);

    // Strings with their dampers off.
    const off = undamped();
    if (off?.size) {
      for (const m of off) {
        const k = geo.get(m);
        if (!k) continue;
        const grad = g.createLinearGradient(0, h, 0, h * 0.55);
        grad.addColorStop(0, 'rgba(217,164,65,0.10)'); grad.addColorStop(1, 'rgba(217,164,65,0)');
        g.fillStyle = grad;
        g.fillRect(k.x * w, h * 0.55, k.w * w, h * 0.45);
      }
    }

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
        grad.addColorStop(0, `rgba(240,190,90,${(0.25 + 0.55 * v).toFixed(3)})`);
        grad.addColorStop(1, 'rgba(240,190,90,0)');
        g.fillStyle = grad;
        const cx = (k.x + k.w / 2) * w, bw = Math.max(2 * dpr, k.w * w * 0.9);
        g.fillRect(cx - bw / 2, top, bw, h - top);
      }
    }

    // Notes, rising.
    const px = SPEED * dpr;
    let live = false;
    for (let i = notes.length - 1; i >= 0; i--) {
      const n = notes[i];
      const bottom = h - (n.t1 == null ? 0 : (t - n.t1) * px);
      const top = h - (t - n.t0) * px - 3 * dpr;
      if (bottom < 0) { notes.splice(i, 1); continue; }
      live = true;
      const k = geo.get(n.m);
      const bw = Math.max(3 * dpr, k.w * w - 2 * dpr), x = k.x * w + (k.w * w - bw) / 2;
      const fade = Math.max(0.15, 1 - (h - bottom) / h);
      const grad = g.createLinearGradient(0, top, 0, bottom);
      grad.addColorStop(0, tint(n.vel, 0.95 * fade));
      grad.addColorStop(1, tint(n.vel, 0.35 * fade));
      g.fillStyle = grad;
      roundRect(g, x, top, bw, Math.max(2 * dpr, bottom - top), Math.min(bw / 2, 4 * dpr));
      g.fill();
      if (n.t1 == null) {        // held: a bright lip where it meets the key
        g.fillStyle = tint(n.vel, 1);
        g.fillRect(x, h - 2 * dpr, bw, 2 * dpr);
      }
    }

    // Only the rising notes need every frame; resonance and dampers are
    // polled, and tick() asks for a frame when they have something to show.
    if (live) start();
    lastRes = ringing; lastOff = off?.size ?? 0;
  }

  function start() { if (!raf) raf = requestAnimationFrame(frame); }

  return {
    noteOn(m, vel) {
      if (!geo.has(m)) return;
      const n = { m, vel, t0: now(), t1: null };
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
    /** From the resonance poll: a frame if anything rings, or just stopped, or the dampers changed. */
    tick() {
      const r = res();
      const ringing = !!r && r.level.some((e) => e > 0);
      if (ringing || lastRes || (undamped()?.size ?? 0) !== lastOff) start();
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
