// Extract a PHYSICAL feature vector from piano audio — real recording or model
// render, the same code either way. This is the heart of the fitting pipeline.
//
// The point is that most of a piano model's parameters are not things you have
// to search for: they are directly measurable. Inharmonicity, tuning, per-partial
// decay rates and strike position all fall straight out of a recording. Only the
// hammer and the bridge response actually need optimisation, which turns a
// 20-dimensional black-box search into a handful of well-conditioned fits.

import { goertzel, findPeak } from '../analyze.mjs';

/**
 * Track partials, jointly refining f0 and B.
 *
 * Bootstrapping matters: at partial 20 a typical B already shifts the frequency
 * several percent, so a window centred on n*f0 misses it entirely. So we fit B
 * from the low partials first, then use it to predict where the high ones are.
 */
export function trackPartials(x, fs, f0Hint, opts = {}) {
  const nMax = opts.nMax ?? 24;
  const start = opts.start ?? 0;
  const len = Math.min(opts.len ?? 1 << 16, x.length - start);
  let f0 = findPeak(x, fs, f0Hint, 0.04, start, len).f;
  let pts = [];

  // Coarse B pre-scan.
  //
  // In the top octaves B reaches ~2e-2, which already shifts partial 2 by 4% --
  // more than any sane search window. Starting from B=0 therefore mistracks the
  // very first partial it needs and the fit never recovers. So: try a ladder of
  // plausible B values, score each by how much partial energy it actually finds,
  // and start the refinement from the winner.
  let B = 0;
  {
    let bestScore = -Infinity;
    for (const cand of [0, 1e-4, 3e-4, 1e-3, 3e-3, 8e-3, 2e-2, 5e-2]) {
      let score = 0, used = 0;
      for (let n = 2; n <= 8; n++) {
        const predict = n * f0 * Math.sqrt(1 + cand * n * n);
        if (predict > 0.45 * fs) break;
        const { mag } = findPeak(x, fs, predict, 0.004, start, len);
        score += Math.log(mag + 1e-18); used++;
      }
      if (used >= 3 && score / used > bestScore) { bestScore = score / used; B = cand; }
    }
  }

  const fitFrom = (list) => {
    // Threshold against the STRONGEST partial, not the median.
    //
    // Above the point where partials fall into the noise floor the tracker
    // returns whatever noise peak happens to sit in its search window, and those
    // fake partials are systematically flat of where real ones would be. A
    // median-relative cut lets them through as soon as half the partials are
    // noise, which quietly halves the fitted B. Anything more than 55 dB below
    // the strongest partial carries no usable frequency.
    const peak = Math.max(...list.map((p) => p.mag));
    const good = list.filter((p) => !p.atEdge && p.mag > peak * 1.8e-3);
    if (good.length < 3) return false;
    const med = peak;
    // Weighted least squares on (f_n/n)^2 = f0^2 + f0^2*B*n^2 -- linear in n^2.
    let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const p of good) {
      const w = Math.sqrt(p.mag / peak);
      const xi = p.n * p.n, yi = Math.pow(p.f / p.n, 2);
      sw += w; sx += w * xi; sy += w * yi; sxx += w * xi * xi; sxy += w * xi * yi;
    }
    const den = sw * sxx - sx * sx;
    if (Math.abs(den) < 1e-12) return false;
    const slope = (sw * sxy - sx * sy) / den;
    const inter = (sy * sxx - sx * sxy) / den;
    if (inter <= 0) return false;
    f0 = Math.sqrt(inter);
    B = Math.max(0, slope / inter);
    return true;
  };

  // Progressive extension. A typical B shifts partial 20 by several percent, so
  // a window centred on n*f0 misses it completely and the fit collapses toward
  // B=0. Fitting the low partials first gives a B good enough to predict where
  // the high ones actually are, and each round widens the reach.
  const stages = [5, 8, 12, 17, nMax].filter((n, i, a) => n <= nMax && a.indexOf(n) === i);
  for (const top of stages) {
    for (let rep = 0; rep < 2; rep++) {
      pts = [];
      for (let n = 1; n <= top; n++) {
        const predict = n * f0 * Math.sqrt(1 + B * n * n);
        if (predict > 0.45 * fs) break;
        // Search window widens with n, since the uncertainty in B*n^2 does too.
        // Before B is known at all the window must be generous, or the very
        // first fit misses the shift and collapses to B=0 permanently.
        const span = B === 0 ? 0.022 : Math.min(0.03, 0.004 + 0.4 * B * n * n);
        const { f, mag } = findPeak(x, fs, predict, span, start, len);
        pts.push({ n, f, mag, atEdge: Math.abs(f / predict - 1) > span * 0.9 });
      }
      if (!fitFrom(pts)) break;
    }
  }
  return { f0, B, partials: pts };
}

/**
 * Decay of one partial. Real piano partials decay in two stages — a quick fall
 * while the unison strings are in phase, then a long aftersound — so a single
 * exponential is the wrong model and fitting one gives a number that matches
 * neither stage.
 */
export function partialDecay(x, fs, f, opts = {}) {
  // The analysis window must span enough cycles of THIS partial to measure it,
  // so it scales with period. A fixed 60 ms window holds 1.6 cycles of a 27 Hz
  // fundamental, which is why every bass note failed to yield a decay at all.
  const winMs = opts.winMs ?? Math.max(50, 9000 / f);
  const spanS = opts.spanS ?? 3.0;
  const win = Math.round((winMs * fs) / 1000);
  const hops = Math.min(Math.floor((spanS * fs) / win), Math.floor(x.length / win)) - 1;
  if (hops < 6) return null;

  const db = [];
  for (let h = 0; h < hops; h++) {
    const m = goertzel(x, fs, f, h * win, win);
    db.push({ t: (h * win) / fs, db: 20 * Math.log10(m + 1e-18) });
  }

  // Beating between unison strings drives the envelope through deep nulls that
  // have nothing to do with decay. Fitting the UPPER envelope (a short running
  // maximum) tracks the decay through them instead of averaging them in.
  const w = Math.max(1, Math.round(hops / 12));
  const upper = db.map((d, i) => {
    let best = -Infinity;
    for (let j = Math.max(0, i - w); j <= Math.min(db.length - 1, i + w); j++)
      best = Math.max(best, db[j].db);
    return { t: d.t, db: best };
  });

  const peak = Math.max(...upper.map((d) => d.db));
  const usable = upper.filter((d) => d.db > peak - 45);
  if (usable.length < 6) return null;

  const slopeOf = (arr) => {
    const n = arr.length;
    if (n < 3) return NaN;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const d of arr) { sx += d.t; sy += d.db; sxx += d.t * d.t; sxy += d.t * d.db; }
    const den = n * sxx - sx * sx;
    return den ? (n * sxy - sx * sy) / den : NaN;     // dB/s
  };
  const split = Math.max(3, Math.round(usable.length * 0.35));
  const early = slopeOf(usable.slice(0, split));
  const late = slopeOf(usable.slice(split));
  const clamp = (r) => (isFinite(r) && r > 0.05 && r < 400 ? r : NaN);
  return {
    early, late, overall: slopeOf(usable),
    t60Early: clamp(-60 / early), t60Late: clamp(-60 / late),
    peakDb: peak, points: db,
  };
}

/**
 * Strike position, from the comb notch in the attack spectrum.
 *
 * Driving the string at one point cancels every partial with a node there, so
 * the attack amplitudes carry a |sin(pi*n*alpha)| envelope. Fitting that envelope
 * is far more robust than hunting for the dip, because the notch often falls
 * between two partials and is never a clean zero in a real recording.
 */
export function fitStrikePosition(partials, range = [0.07, 0.17]) {
  // Constrained to the physically plausible range. Every real piano strikes
  // between about 1/12 and 1/6 of the speaking length, and without that bound an
  // unconstrained fit happily returns alpha/2 or 2*alpha -- both of which place
  // SOME notch near a measured dip, and neither of which any piano has.
  // Only partials well clear of the noise floor carry usable notch information.
  const peak = Math.max(...partials.map((p) => p.mag));
  const good = partials.filter((p) => !p.atEdge && p.n <= 20 && p.mag > peak * 1e-3);
  if (good.length < 7) return NaN;
  const logs = good.map((p) => Math.log(p.mag));
  const xs = good.map((p) => Math.log(p.n));

  // Solve least squares for a cubic tilt in log(n) alongside the comb.
  //
  // The overall spectral slope is steep and NOT a power law -- it is the loop
  // resonance gain falling off, times the hammer's own rolloff. Modelling the
  // tilt as a straight line in log(n) leaves a big structured residual, and the
  // fit then prefers alpha/2 because a gentler comb lets the wrong tilt absorb
  // more error. A cubic has enough freedom for any plausible tilt while still
  // being far too smooth to imitate the comb's sharp notches, so only the notch
  // shape can drive alpha.
  const DEG = 3;
  const solve = (A, b) => {
    const n = b.length;
    for (let i = 0; i < n; i++) {
      let piv = i;
      for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[piv][i])) piv = r;
      if (Math.abs(A[piv][i]) < 1e-12) return null;
      [A[i], A[piv]] = [A[piv], A[i]]; [b[i], b[piv]] = [b[piv], b[i]];
      for (let r = i + 1; r < n; r++) {
        const f = A[r][i] / A[i][i];
        for (let c = i; c < n; c++) A[r][c] -= f * A[i][c];
        b[r] -= f * b[i];
      }
    }
    const out = new Array(n).fill(0);
    for (let i = n - 1; i >= 0; i--) {
      let acc = b[i];
      for (let c = i + 1; c < n; c++) acc -= A[i][c] * out[c];
      out[i] = acc / A[i][i];
    }
    return out;
  };

  let best = NaN, bestErr = Infinity;
  for (let a = range[0]; a <= range[1]; a += 0.0004) {
    const comb = good.map((p) => Math.log(Math.abs(Math.sin(Math.PI * p.n * a)) + 1e-3));
    const y = logs.map((v, i) => v - comb[i]);
    const A = [], bb = [];
    for (let i = 0; i <= DEG; i++) {
      A.push(new Array(DEG + 1).fill(0));
      bb.push(0);
      for (let k = 0; k < good.length; k++) {
        for (let j = 0; j <= DEG; j++) A[i][j] += Math.pow(xs[k], i + j);
        bb[i] += Math.pow(xs[k], i) * y[k];
      }
    }
    const coef = solve(A, bb);
    if (!coef) continue;
    let err = 0;
    for (let k = 0; k < good.length; k++) {
      let tilt = 0;
      for (let j = 0; j <= DEG; j++) tilt += coef[j] * Math.pow(xs[k], j);
      err += Math.pow(y[k] - tilt, 2);
    }
    if (err < bestErr) { bestErr = err; best = a; }
  }
  return best;
}

/** Everything, for one isolated note. */
export function extractFeatures(x, fs, f0Hint, opts = {}) {
  const attackStart = Math.round((opts.attackDelayS ?? 0.04) * fs);
  const tracked = trackPartials(x, fs, f0Hint, {
    nMax: opts.nMax ?? 24,
    start: attackStart,
    len: Math.min(Math.round(0.6 * fs), x.length - attackStart),
  });
  const { f0, B, partials } = tracked;

  const decays = partials.map((p) =>
    p.atEdge ? null : partialDecay(x, fs, p.f, { spanS: opts.decaySpanS ?? 3.0 }));

  const peakMag = Math.max(...partials.map((p) => p.mag));
  const strikeAlpha = fitStrikePosition(partials);

  const out = partials.map((p, i) => ({
    n: p.n, f: p.f, mag: p.mag,
    relDb: 20 * Math.log10(p.mag / peakMag),
    centsOffHarmonic: 1200 * Math.log2(p.f / (p.n * f0)),
    decay: decays[i],
    reliable: !p.atEdge && p.mag > peakMag * 1.8e-3,
  }));

  // Decay rate against frequency, which is what the loss filter is actually fitted
  // to. Reading it off the fundamental alone is wrong in the bass: A0's
  // fundamental sits 60 dB down because the soundboard cannot radiate 27 Hz, so
  // its "decay" is just noise. Every partial that is strong enough to trust
  // contributes a point instead.
  const curve = out
    .filter((p) => p.reliable && p.decay && isFinite(p.decay.early) && p.relDb > -42)
    .map((p) => ({ f: p.f, n: p.n, rateEarly: -p.decay.early, rateLate: -p.decay.late,
                   t60Early: p.decay.t60Early, t60Late: p.decay.t60Late, relDb: p.relDb }))
    .filter((c) => c.rateEarly > 0.3 && c.rateEarly < 300);

  // A single representative decay: the strongest partial's.
  const strongest = out.reduce((a, b) => (b.mag > (a?.mag ?? -1) ? b : a), null);

  return { f0, B, strikeAlpha, partials: out, decayCurve: curve, strongest };
}
