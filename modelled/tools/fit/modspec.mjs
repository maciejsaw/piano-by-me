// Is the wobble a BEAT or is it NOISE?
//
// warble.mjs measures how much a partial's envelope moves. It cannot say what
// kind of movement, and the two sound nothing alike:
//
//   coherent   two strings a few thousandths of a Hz apart, cancelling and
//              reinforcing on a fixed cycle. Periodic, so its modulation
//              spectrum is a spike and its envelope autocorrelates strongly.
//              Heard as phasing, and the ear locks onto it.
//   incoherent a real string is not a rigid mathematical object: tension
//              wanders, the bridge moves, air moves. Broadband, so its
//              modulation spectrum is flat and it barely autocorrelates.
//              Heard as being alive.
//
// A model can match the energy figure exactly and still be wrong, if it puts a
// spike where the instrument has a floor. So this reports rate, tonality (spike
// height over the noise floor) and where the energy sits in rate.

import { goertzel } from '../analyze.mjs';

/** dB envelope of one partial, sampled every hop. */
export function dbEnvelope(x, fs, f, { winMs = 60, spanS = 14, startS = 0.25 } = {}) {
  const win = Math.round((winMs * fs) / 1000);
  const start = Math.round(startS * fs);
  const n = Math.min(Math.floor((spanS * fs) / win), Math.floor((x.length - start) / win));
  const out = [];
  for (let h = 0; h < n; h++) {
    const v = goertzel(x, fs, f, start + h * win, win);
    out.push(20 * Math.log10(v + 1e-18));
  }
  return { db: out, fsEnv: fs / win };
}

/** Remove the decay shape with a least-squares cubic, leaving the modulation. */
function detrend(db) {
  const n = db.length, X = [];
  for (let i = 0; i < n; i++) { const t = (2 * i) / (n - 1) - 1; X.push([1, t, t * t, t * t * t]); }
  const A = Array.from({ length: 4 }, () => new Float64Array(4)), b = new Float64Array(4);
  for (let i = 0; i < n; i++) for (let p = 0; p < 4; p++) {
    b[p] += X[i][p] * db[i];
    for (let q = 0; q < 4; q++) A[p][q] += X[i][p] * X[i][q];
  }
  for (let c = 0; c < 4; c++) {                         // gaussian elimination
    let piv = c; for (let r = c + 1; r < 4; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]]; [b[c], b[piv]] = [b[piv], b[c]];
    for (let r = 0; r < 4; r++) {
      if (r === c || !A[c][c]) continue;
      const m = A[r][c] / A[c][c];
      for (let k = c; k < 4; k++) A[r][k] -= m * A[c][k];
      b[r] -= m * b[c];
    }
  }
  const co = [0, 1, 2, 3].map((i) => (A[i][i] ? b[i] / A[i][i] : 0));
  return db.map((v, i) => v - X[i].reduce((s, xp, p) => s + xp * co[p], 0));
}

/**
 * Modulation character of one partial.
 *   rate     dominant modulation frequency, Hz
 *   tonality dB of the spectral peak over the median -- high means a beat,
 *            low means a noise floor
 *   slow/fast energy either side of 0.35 Hz, as RMS dB
 */
export function modSpectrum(x, fs, f, opts = {}) {
  const { db, fsEnv } = dbEnvelope(x, fs, f, opts);
  if (db.length < 32) return null;
  const d = detrend(db);
  const n = d.length;
  const w = d.map((v, i) => v * 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1))));
  const lo = opts.loHz ?? 0.08, hi = Math.min(opts.hiHz ?? 10, fsEnv / 2);
  const bins = [];
  for (let fr = lo; fr <= hi; fr *= 1.03) {
    let re = 0, im = 0;
    for (let i = 0; i < n; i++) { const a = (2 * Math.PI * fr * i) / fsEnv; re += w[i] * Math.cos(a); im -= w[i] * Math.sin(a); }
    bins.push({ f: fr, m: Math.hypot(re, im) * (2 / (n * 0.5)) });
  }
  const sorted = [...bins].map((b) => b.m).sort((a, b) => a - b);
  const med = sorted[sorted.length >> 1] || 1e-18;
  const pk = bins.reduce((a, b) => (b.m > a.m ? b : a));
  const band = (a, b) => {
    let e = 0; for (const x of bins) if (x.f >= a && x.f < b) e += x.m * x.m;
    return Math.sqrt(e);
  };
  return { rate: pk.f, tonality: 20 * Math.log10(pk.m / med), slow: band(lo, 0.35), fast: band(0.35, hi) };
}
