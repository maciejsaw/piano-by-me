// Does each partial decay the way a real one does?
//
// The loss filter gives every partial one fixed exponential, so in dB its
// decay is a straight line by construction. A real string is coupled to the
// air and to the bridge, and the high partials lose their energy to both far
// faster at the start than at the end: the line bends. Past the bend the
// partial is no longer a clean line in the spectrum either -- it has spread
// out. That is what "blurry" looks like.
//
// So this measures two things per note:
//   curvature  early decay rate minus late decay rate, per partial. Positive
//              means the partial starts fast and goes soft, which is what a
//              piano does. Zero is a straight line, which is what we do.
//   blur       how much of the energy near a partial sits off its centre,
//              measured in successive windows. Rises through a real decay.

import { fft } from './comb.mjs';

const WIN = 4096;                                 // ~85 ms at 48 k, ~3 Hz bins

/** Magnitude spectrum of one window, Hann-windowed, zero-padded x2. */
function spectrumAt(x, start, n = WIN) {
  const N = n * 2;
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < n; i++) {
    const v = x[start + i] ?? 0;
    re[i] = v * 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  }
  fft(re, im);
  const half = N / 2, mag = new Float64Array(half);
  for (let k = 0; k < half; k++) mag[k] = Math.hypot(re[k], im[k]);
  return mag;
}

const partialHz = (f0, B, n) => n * f0 * Math.sqrt(1 + B * n * n);

/** Peak magnitude and its centre of gravity within +-cents of f. */
function peakNear(mag, fs, N, f, cents) {
  const lo = Math.max(1, Math.floor((f * Math.pow(2, -cents / 1200) * N) / fs));
  const hi = Math.min(mag.length - 1, Math.ceil((f * Math.pow(2, cents / 1200) * N) / fs));
  let peak = 0, sum = 0, wsum = 0, psum = 0;
  for (let k = lo; k <= hi; k++) {
    const p = mag[k] * mag[k];
    if (mag[k] > peak) peak = mag[k];
    sum += p; wsum += p * ((k * fs) / N); psum += p;
  }
  return { peak, power: sum, centre: psum ? wsum / psum : f, lo, hi };
}

/** Fit f0 and B to the sample's own early spectrum, so partials are tracked. */
export function estimateHarmonics(x, fs, f0Nominal, { nPartials = 16, startS = 0.2 } = {}) {
  const mag = spectrumAt(x, Math.round(startS * fs));
  const N = WIN * 2;
  let best = null;
  for (let c = -50; c <= 50; c += 2) {
    const f0 = f0Nominal * Math.pow(2, c / 1200);
    for (let B = 0; B <= 0.0012; B += 0.00002) {
      let s = 0;
      for (let n = 1; n <= nPartials; n++) {
        const f = partialHz(f0, B, n);
        if (f > fs / 2.2) break;
        s += peakNear(mag, fs, N, f, 15).peak;
      }
      if (!best || s > best.score) best = { f0, B, score: s };
    }
  }
  return best;
}

/**
 * Per-partial decay in dB, sampled on a grid, plus the blur measure.
 *   tracks[n] = { n, f, db[], tS[], early, late, curve, blur[] }
 * early/late are dB/s over the two halves of the usable span.
 */
export function partialDecay(x, fs, f0Nominal, opts = {}) {
  const { nPartials = 14, startS = 0.15, spanS = 6, hopS = 0.05, splitS = 1.5 } = opts;
  const h = estimateHarmonics(x, fs, f0Nominal, { nPartials, startS });
  const N = WIN * 2;
  const nHop = Math.floor(
    Math.min(spanS, (x.length - WIN) / fs - startS) / hopS,
  );
  const spectra = [], tS = [];
  for (let i = 0; i < nHop; i++) {
    const t = startS + i * hopS;
    spectra.push(spectrumAt(x, Math.round(t * fs)));
    tS.push(t);
  }

  const tracks = [];
  for (let n = 1; n <= nPartials; n++) {
    const f = partialHz(h.f0, h.B, n);
    if (f > fs / 2.2) break;
    const db = [], blur = [];
    for (const mag of spectra) {
      // Track the partial where it actually is: it drifts, and we follow.
      const wide = peakNear(mag, fs, N, f, 60);
      const fc = wide.centre;
      const core = peakNear(mag, fs, N, fc, 12);
      db.push(10 * Math.log10(core.power + 1e-20));
      // Blur: the share of the local energy that is NOT in the partial's core.
      blur.push(10 * Math.log10((wide.power - core.power + 1e-20) / (core.power + 1e-20)));
    }
    tracks.push({ n, f, db, blur, tS });
  }

  // Slopes over early and late halves, on the region where the partial is
  // still above its own noise floor (-55 dB from its own peak).
  for (const tr of tracks) {
    const top = Math.max(...tr.db);
    const live = tr.db.map((v, i) => (v > top - 55 ? i : -1)).filter((i) => i >= 0);
    const last = live.length ? live[live.length - 1] : tr.db.length - 1;
    const split = Math.min(Math.round((splitS - startS) / hopS), last);
    tr.early = slope(tS, tr.db, 0, split);
    tr.late = slope(tS, tr.db, split, last);
    tr.curve = tr.early - tr.late;                  // >0 : fast then soft
    tr.blurEarly = mean(tr.blur.slice(0, split));
    tr.blurLate = mean(tr.blur.slice(split, Math.max(split + 1, last)));
    tr.blurRise = tr.blurLate - tr.blurEarly;
    tr.liveS = (last - 0) * (opts.hopS ?? 0.05);
  }
  return { f0: h.f0, B: h.B, tracks };
}

function slope(t, y, a, b) {
  const n = b - a + 1;
  if (n < 3) return 0;
  let st = 0, sy = 0, stt = 0, sty = 0;
  for (let i = a; i <= b; i++) { st += t[i]; sy += y[i]; stt += t[i] * t[i]; sty += t[i] * y[i]; }
  const d = n * stt - st * st;
  return d ? (n * sty - st * sy) / d : 0;
}
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
