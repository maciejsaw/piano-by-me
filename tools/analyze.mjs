// Offline measurement: does the rendered audio actually exhibit the physics
// the parameters asked for? This is the regression harness for the model.

/** Goertzel magnitude at an exact frequency -- no FFT bin quantisation. */
export function goertzel(x, fs, f, start = 0, len = x.length - start) {
  const k = (2 * Math.PI * f) / fs;
  const c = 2 * Math.cos(k);
  let s1 = 0, s2 = 0;
  for (let i = start; i < start + len; i++) {
    const s0 = x[i] + c * s1 - s2;
    s2 = s1; s1 = s0;
  }
  return Math.hypot(s1 - s2 * Math.cos(k), s2 * Math.sin(k)) / (len / 2);
}

/** Refine a partial's true frequency by parabolic search around a guess. */
export function findPeak(x, fs, fGuess, span = 0.02, start = 0, len = x.length - start) {
  let best = fGuess, bestMag = -1;
  const lo = fGuess * (1 - span), hi = fGuess * (1 + span);
  const steps = 240;
  for (let i = 0; i <= steps; i++) {
    const f = lo + ((hi - lo) * i) / steps;
    const m = goertzel(x, fs, f, start, len);
    if (m > bestMag) { bestMag = m; best = f; }
  }
  // local refine
  let step = (hi - lo) / steps;
  for (let it = 0; it < 30; it++) {
    const a = goertzel(x, fs, best + step, start, len);
    const b = goertzel(x, fs, best - step, start, len);
    if (a > bestMag) { best += step; bestMag = a; }
    else if (b > bestMag) { best -= step; bestMag = b; }
    else step *= 0.5;
  }
  return { f: best, mag: bestMag };
}

/**
 * Fit inharmonicity B from measured partial frequencies.
 *
 * Partials that the strike-position comb notches out carry no usable frequency
 * information -- the peak finder just locks onto noise at the search window's
 * edge -- so weak partials are skipped rather than fitted. `bHint` only centres
 * the search window; the returned B is measured from where the peaks actually
 * land.
 */
export function measureB(x, fs, f0, nMax = 12, start = 0, len = 32768, bHint = 0) {
  const span = 0.012;
  const raw = [];
  for (let n = 1; n <= nMax; n++) {
    const centre = n * f0 * Math.sqrt(1 + bHint * n * n);
    if (centre > 0.42 * fs) break;
    const { f, mag } = findPeak(x, fs, centre, span, start, Math.min(len, x.length - start));
    const atEdge = Math.abs(f / centre - 1) > span * 0.92;
    raw.push({ n, f, mag, atEdge });
  }
  // Partials the strike comb notches out sit 30-60 dB below their neighbours and
  // their apparent frequency is noise. Keep only partials within 20 dB of the
  // median, which is comfortably above the notch floor.
  const mags = raw.map((p) => p.mag).slice().sort((a, b) => b - a);
  const ref = mags[Math.floor(mags.length / 2)] || 1;
  const pts = raw.filter((p) => !p.atEdge && p.mag > ref / 10);
  if (pts.length < 3) return { B: NaN, f0: raw[0]?.f ?? f0, partials: raw, used: pts.length };

  const f0m = (pts.find((p) => p.n === 1) || pts[0]).f / (pts.find((p) => p.n === 1) ? 1 : pts[0].n);
  let num = 0, den = 0;
  for (const p of pts) {
    if (p.n === 1) continue;
    const y = Math.pow(p.f / (p.n * f0m), 2) - 1;
    const t = p.n * p.n;
    num += t * y; den += t * t;
  }
  return { B: den ? num / den : NaN, f0: f0m, partials: raw, used: pts.length };
}

/** T60 of one partial, from the slope of its log envelope. */
export function measureT60(x, fs, f, winMs = 120, spanS = null) {
  const win = Math.round((winMs * fs) / 1000);
  const hops = Math.floor((spanS ? spanS * fs : x.length) / win) - 1;
  const db = [];
  for (let h = 0; h < hops; h++) {
    const m = goertzel(x, fs, f, h * win, win);
    db.push({ t: (h * win) / fs, db: 20 * Math.log10(m + 1e-18) });
  }
  const usable = db.filter((d) => d.db > db[0].db - 45);
  if (usable.length < 4) return { t60: NaN, points: db };
  let sx = 0, sy = 0, sxx = 0, sxy = 0, n = usable.length;
  for (const d of usable) { sx += d.t; sy += d.db; sxx += d.t * d.t; sxy += d.t * d.db; }
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);    // dB per second
  return { t60: -60 / slope, points: db };
}

/** Amplitude envelope, for spotting beating between detuned unison strings. */
export function envelope(x, fs, f, winMs = 25, spanS = 4) {
  const win = Math.round((winMs * fs) / 1000);
  const hops = Math.min(Math.floor((spanS * fs) / win) - 1, Math.floor(x.length / win) - 1);
  const out = [];
  for (let h = 0; h < hops; h++) out.push(goertzel(x, fs, f, h * win, win));
  return { hopS: win / fs, values: out };
}

/**
 * Dominant modulation rate of an amplitude envelope, found spectrally.
 * Zero-crossing counting is far too noisy on a decaying envelope.
 */
export function beatRate(env, loHz = 0.05, hiHz = 25) {
  const v = env.values;
  if (v.length < 12) return NaN;
  const fsEnv = 1 / env.hopS;
  // Work in dB and remove the decay trend, leaving only the modulation.
  const db = v.map((a) => 20 * Math.log10(a + 1e-18));
  const n = db.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += db[i]; sxx += i * i; sxy += i * db[i]; }
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const mean = sy / n;
  const detr = db.map((d, i) => d - (mean + slope * (i - sx / n)));
  // Hann window, then scan modulation frequencies.
  const win = detr.map((d, i) => d * 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1))));
  let best = NaN, bestMag = -1;
  const hi = Math.min(hiHz, fsEnv / 2);
  for (let f = loHz; f <= hi; f *= 1.01) {
    let re = 0, im = 0;
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * f * i) / fsEnv;
      re += win[i] * Math.cos(a); im -= win[i] * Math.sin(a);
    }
    const m = Math.hypot(re, im);
    if (m > bestMag) { bestMag = m; best = f; }
  }
  return best;
}

export const rms = (x, start = 0, len = x.length - start) => {
  let s = 0;
  for (let i = start; i < start + len; i++) s += x[i] * x[i];
  return Math.sqrt(s / len);
};
export const peak = (x) => { let p = 0; for (const v of x) p = Math.max(p, Math.abs(v)); return p; };
