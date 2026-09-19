// Parameter compiler: physical string spec -> waveguide filter coefficients.
// This is what keeps "tweak the physics" honest: the user edits tension and wire
// gauge, this module solves for the filters that reproduce them.

import { partialHz } from './physics.js';

// ---- complex helpers (tiny, local) ----
const cAdd = (a, b) => [a[0] + b[0], a[1] + b[1]];
const cDiv = (a, b) => {
  const d = b[0] * b[0] + b[1] * b[1];
  return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d];
};
const cMag = (a) => Math.hypot(a[0], a[1]);
const cArg = (a) => Math.atan2(a[1], a[0]);
const expjw = (w) => [Math.cos(w), Math.sin(w)];

// ---- one-pole loss filter:  H(z) = g(1-b) / (1 - b z^-1),  |H(0)| = g ----
export const lossResponse = (w, g, b) => {
  const z1 = expjw(-w);
  return cDiv([g * (1 - b), 0], cAdd([1, 0], [-b * z1[0], -b * z1[1]]));
};

/**
 * Design the loop loss filter from two decay times.
 * Per round trip the loop gain must be exp(-1/(f*tau)), tau = T60/6.9078.
 */
export function designLoss(fs, f0, t60Low, t60High, fHigh = 5000, kappa = 0) {
  // The bridge removes a fraction kappa of the wave per round trip. Dividing it
  // out here keeps the requested T60 honest: it stays the TOTAL decay time, with
  // the internal loss filter making up whatever the bridge does not already take.
  const bridgeLoss = 1 - kappa;
  // The wave completes f0 round trips per second REGARDLESS of which partial we
  // are specifying, so f0 -- not the partial frequency -- is the trip rate.
  // Using the partial frequency here leaves the high end ~20x underdamped.
  const loopGain = (t60) => Math.exp(-6.9078 / (f0 * Math.max(t60, 1e-3))) / bridgeLoss;
  const fh = Math.min(fHigh, 0.45 * fs);
  const G0 = Math.min(loopGain(t60Low), 0.99995);
  const Gh = Math.min(loopGain(t60High), 0.99995);
  const w0 = 2 * Math.PI * f0 / fs;
  const wh = 2 * Math.PI * fh / fs;

  // |H(w)| ratio depends only on b; bisect for the b matching G0/Gh.
  const denom = (w, b) => Math.sqrt(1 - 2 * b * Math.cos(w) + b * b);
  const target = G0 / Gh;
  let lo = 0, hi = 0.9995;
  if (target > 1) {
    for (let i = 0; i < 60; i++) {
      const b = 0.5 * (lo + hi);
      (denom(wh, b) / denom(w0, b) < target) ? (lo = b) : (hi = b);
    }
  }
  const b = 0.5 * (lo + hi);
  const g = Math.min(G0 * denom(w0, b) / (1 - b), 0.99995);
  return { g, b };
}

// ---- first-order dispersion allpass:  A(z) = (a + z^-1)/(1 + a z^-1) ----
export const allpassResponse = (w, a) => {
  const z1 = expjw(-w);
  return cDiv(cAdd([a, 0], z1), cAdd([1, 0], [a * z1[0], a * z1[1]]));
};

const phaseDelay = (w, resp) => {
  let ph = cArg(resp);
  while (ph > 0) ph -= 2 * Math.PI;     // unwrap to the lagging branch
  return -ph / w;
};

/**
 * Design the dispersion allpass chain that realises inharmonicity B.
 *
 * The loop resonates where total loop phase delay D(w_n) = n*fs/f_n, so we want
 * D(w_n) = fs / (f0 * sqrt(1 + B n^2)). Expanding for small B, the required
 * phase delay is a quadratic droop:  D(f) ~ D0 * (1 - (B/2)(f/f0)^2).
 *
 * A cascade of M identical first-order allpasses with a<0 droops in just that
 * way, but only while |a| is small -- a large |a| plunges far too steeply. So
 * accuracy comes from using MANY GENTLE sections rather than a few strong ones,
 * and the section count is bounded by how much of the period the chain may eat.
 * Treble notes have little delay budget, but they also have few audible partials,
 * so the error lands where it is least audible.
 *
 * All sections share one coefficient: a second free group measurably does not
 * help (the optimiser drives both groups to the same value), so this is a fast
 * 1-D golden-section search over `a` for each candidate M.
 */
export function designDispersion(fs, f0, B, loss, maxSections = 48) {
  const nyq = 0.45 * fs;
  const nMax = Math.max(2, Math.min(48, Math.floor(nyq / f0)));
  const period = fs / f0;
  const targetD = (n) => fs / (f0 * Math.sqrt(1 + B * n * n));
  const partialW = (n) => 2 * Math.PI * Math.min(partialHz(f0, n, B), nyq) / fs;

  const ws = [];
  for (let n = 1; n <= nMax; n++) ws.push(partialW(n));
  const lossPD = ws.map((w) => phaseDelay(w, lossResponse(w, loss.g, loss.b)));

  // Weighted log-delay error for a given (a, M); dLine is pinned so the
  // fundamental stays exactly in tune.
  const errorOf = (a, M) => {
    const ap = ws.map((w) => phaseDelay(w, allpassResponse(w, a)));
    const dLine = targetD(1) - (M * ap[0] + lossPD[0]);
    if (dLine < 6) return { err: Infinity, dLine, a, M };
    let err = 0, wsum = 0;
    for (let n = 2; n <= nMax; n++) {
      const i = n - 1;
      const e = Math.log((dLine + M * ap[i] + lossPD[i]) / targetD(n));
      const wt = 1 / n;                       // struck-string energy falls ~1/n
      err += wt * e * e; wsum += wt;
    }
    return { err: wsum ? err / wsum : 0, dLine, a, M };
  };

  // Golden-section search over a in [-0.98, 0] for fixed M.
  const bestA = (M) => {
    const gr = (Math.sqrt(5) - 1) / 2;
    let lo = -0.98, hi = 0;
    let c = hi - gr * (hi - lo), d = lo + gr * (hi - lo);
    let fc = errorOf(c, M).err, fd = errorOf(d, M).err;
    for (let i = 0; i < 60 && hi - lo > 1e-6; i++) {
      if (fc < fd) { hi = d; d = c; fd = fc; c = hi - gr * (hi - lo); fc = errorOf(c, M).err; }
      else         { lo = c; c = d; fc = fd; d = lo + gr * (hi - lo); fd = errorOf(d, M).err; }
    }
    return errorOf(0.5 * (lo + hi), M);
  };

  // The chain may eat at most ~65% of the period, leaving room for the delay line.
  const budget = Math.max(0, Math.floor(0.65 * period) - 8);
  const cap = Math.min(maxSections, budget);

  let best = { err: Infinity, dLine: period, a: 0, M: 0 };
  const tried = new Set();
  for (const M of [cap, Math.floor(cap / 2), Math.floor(cap / 4), 8, 4, 2, 1]) {
    if (M < 1 || tried.has(M)) continue;
    tried.add(M);
    const r = bestA(M);
    if (r.err < best.err) best = r;
  }
  return best;   // { a, M, dLine, err }
}

/** Measure what inharmonicity a compiled design actually produces, in cents. */
export function verifyDispersion(fs, f0, B, loss, design, nMax = 16) {
  const out = [];
  for (let n = 1; n <= nMax; n++) {
    const want = partialHz(f0, n, B);
    if (want > 0.45 * fs) break;
    const w = 2 * Math.PI * want / fs;
    const D = design.dLine
      + (design.M ? design.M * phaseDelay(w, allpassResponse(w, design.a)) : 0)
      + phaseDelay(w, lossResponse(w, loss.g, loss.b));
    const got = n * fs / D;          // resonance where loop delay = n periods
    out.push({ n, want, got, cents: 1200 * Math.log2(got / want) });
  }
  return out;
}

/** Compile one string's physical parameters into a runnable coefficient set. */
export function compileString(fs, phys, tuning) {
  const f0 = phys.f0 * Math.pow(2, (tuning.detuneCents ?? 0) / 1200);
  // Coupling is expressed as a FRACTION of the string's total per-round-trip
  // loss, not as an absolute number. The coupling loss can never exceed the total
  // loss (that would need an internal loop gain above 1), so this both guarantees
  // stability and automatically scales coupling correctly across the compass.
  const eps = 1 - Math.exp(-6.9078 / (f0 * Math.max(tuning.t60Low, 1e-3)));
  const kappa = Math.min(0.95, tuning.couplingFraction ?? 0) * eps;
  const loss = designLoss(fs, f0, tuning.t60Low, tuning.t60High, 5000, kappa);
  const disp = designDispersion(fs, f0, phys.B, loss, tuning.maxAllpass ?? 48);
  const damped = designLoss(fs, f0, tuning.t60Damped ?? 0.12, (tuning.t60Damped ?? 0.12) * 0.35, 5000, kappa);
  return {
    f0, B: phys.B, kappa, eps,
    delay: disp.dLine, allpassA: disp.a, allpassN: disp.M,
    dispErr: disp.err, loss,
    lossG: loss.g, lossB: loss.b,
    dampG: Math.min(damped.g, loss.g), dampB: Math.max(damped.b, loss.b),
    strikeDelay: Math.max(1, Math.round(disp.dLine * (tuning.strikePosition ?? 0.125))),
  };
}
