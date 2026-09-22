// Compare how the whole spectrum MOVES, band by band, frame by frame.
//
// Every metric here so far tracked named partials, which has two blind spots
// that matter to the ear. It only ever looked at the first handful, so the
// 1-4 kHz region -- where hearing is sharpest and where beat rates are highest,
// since partial n beats at n times partial 1's rate -- was never measured at
// all. And tracking a partial follows it as it moves, which hides exactly the
// spectral wobble that is being complained about.
//
// So: a short-time spectrum every 100 ms, pooled into third-octave bands. Each
// band's level over time is detrended to remove the decay, and what is left is
// the wobble in that band -- its depth, and its rate. That is what phasing is.

import { fft } from './comb.mjs';

const BANDS = (() => {
  const out = [];
  for (let f = 100; f < 8000; f *= Math.pow(2, 1 / 3)) out.push([f, f * Math.pow(2, 1 / 3)]);
  return out;
})();

/** Third-octave level trajectories, one value per hop, in dB. */
export function bandTracks(x, fs, { hopS = 0.1, winS = 0.2, startS = 0.15, spanS = 8 } = {}) {
  const win = 1 << Math.round(Math.log2(winS * fs));
  const hop = Math.round(hopS * fs);
  const start = Math.round(startS * fs);
  const frames = Math.min(Math.floor((spanS * fs) / hop), Math.floor((x.length - start - win) / hop));
  const tracks = BANDS.map(() => []);
  const re = new Float64Array(win), im = new Float64Array(win);
  for (let t = 0; t < frames; t++) {
    const o = start + t * hop;
    for (let i = 0; i < win; i++) { re[i] = x[o + i] * 0.5 * (1 - Math.cos((2 * Math.PI * i) / (win - 1))); im[i] = 0; }
    fft(re, im);
    for (let b = 0; b < BANDS.length; b++) {
      const [lo, hi] = BANDS[b];
      let e = 0;
      const k0 = Math.max(1, Math.ceil((lo * win) / fs)), k1 = Math.min(win / 2 - 1, Math.floor((hi * win) / fs));
      for (let k = k0; k <= k1; k++) e += re[k] * re[k] + im[k] * im[k];
      tracks[b].push(10 * Math.log10(e + 1e-20));
    }
  }
  return { tracks, bands: BANDS, fsEnv: 1 / hopS, frames };
}

/** Least-squares cubic, so a two-stage decay is not mistaken for wobble. */
function detrend(y) {
  const n = y.length, P = 4, X = [];
  for (let i = 0; i < n; i++) { const t = (2 * i) / (n - 1) - 1; X.push([1, t, t * t, t * t * t]); }
  const A = Array.from({ length: P }, () => new Float64Array(P)), b = new Float64Array(P);
  for (let i = 0; i < n; i++) for (let p = 0; p < P; p++) {
    b[p] += X[i][p] * y[i];
    for (let q = 0; q < P; q++) A[p][q] += X[i][p] * X[i][q];
  }
  for (let c = 0; c < P; c++) {
    let piv = c; for (let r = c + 1; r < P; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]]; [b[c], b[piv]] = [b[piv], b[c]];
    for (let r = 0; r < P; r++) {
      if (r === c || !A[c][c]) continue;
      const m = A[r][c] / A[c][c];
      for (let k = c; k < P; k++) A[r][k] -= m * A[c][k];
      b[r] -= m * b[c];
    }
  }
  const co = [0, 1, 2, 3].map((i) => (A[i][i] ? b[i] / A[i][i] : 0));
  return y.map((v, i) => v - X[i].reduce((s, xp, p) => s + xp * co[p], 0));
}

/** Per band: wobble depth (dB RMS) and the rate it wobbles at (Hz). */
export function bandWobble(x, fs, opts = {}) {
  const { tracks, bands, fsEnv } = bandTracks(x, fs, opts);
  return tracks.map((y, i) => {
    const d = detrend(y), n = d.length;
    const w = d.map((v, k) => v * 0.5 * (1 - Math.cos((2 * Math.PI * k) / (n - 1))));
    let best = { f: 0, m: -1 }, tot = 0;
    for (let f = 0.15; f <= Math.min(4.5, fsEnv / 2); f *= 1.06) {
      let re = 0, im = 0;
      for (let k = 0; k < n; k++) { const a = (2 * Math.PI * f * k) / fsEnv; re += w[k] * Math.cos(a); im -= w[k] * Math.sin(a); }
      const m = Math.hypot(re, im) * (2 / (n * 0.5));
      tot += m * m;
      if (m > best.m) best = { f, m };
    }
    const rms = Math.sqrt(d.reduce((s, v) => s + v * v, 0) / n);
    return { lo: bands[i][0], hi: bands[i][1], rms, rate: best.f, energy: Math.sqrt(tot) };
  });
}
