// What pitch is this recording, actually?
//
// Harder than it sounds, and the naive answer is wrong exactly where it
// matters most. On A0 the fundamental is 37 dB BELOW the fourth partial --
// a 27 Hz string radiates almost nothing at 27 Hz, which is why pianos have
// wound bass strings and big soundboards rather than 2-metre ones -- so
// looking for a peak near 27.5 Hz finds room rumble and reports a pitch eight
// cents out, differently for every velocity layer of the same note.
//
// So: fit f0 and B together across two dozen partials, the way the model's own
// fitting pipeline does. Combining
//
//     f_n = n * f0 * sqrt(1 + B n^2)      ->      (f_n / n)^2 = f0^2 + f0^2 B n^2
//
// makes it a straight line in n^2, so one weighted least-squares pass gives
// both, weighted by how much signal each partial actually has.
//
// The difference from tools/fit/features.mjs, which does the same fit, is
// entirely cost. That one refines each partial with findPeak -- 300 Goertzels
// over 131072 samples apiece, about 9 billion multiply-adds per note, which is
// right for a one-off scale fit and quite wrong when a build needs 118 of
// them. One windowed FFT gives the whole spectrum for 24 Mflop, and parabolic
// interpolation on the peak recovers a fraction of a bin. Measured against the
// Goertzel version across the compass the two agree to about a cent, and this
// one is roughly a thousand times faster.
import { fft, hann } from './fft.mjs';

const B_LADDER = [0, 1e-4, 3e-4, 1e-3, 3e-3, 1e-2, 3e-2];

function spectrum(x, fs, start) {
  let n = 1 << 17;                                   // 2.7 s at 48 kHz
  while (n > 1 << 13 && start + n > x.length) n >>= 1;
  const w = hann(n);
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const s = start + i;
    re[i] = s < x.length ? x[s] * w[i] : 0;
  }
  fft(re, im, false);
  const half = n >> 1;
  const mag = new Float64Array(half + 1);
  for (let k = 0; k <= half; k++) mag[k] = Math.hypot(re[k], im[k]);
  return { mag, n, binHz: fs / n };
}

const magAt = (mag, bin) => {
  if (bin <= 0 || bin >= mag.length - 1) return 0;
  const i = bin | 0, t = bin - i;
  return mag[i] + (mag[i + 1] - mag[i]) * t;
};

/** The true peak near `bin`, by parabolic interpolation in dB. */
function refine(mag, bin, window) {
  let k = Math.round(bin), best = 0;
  const lo = Math.max(1, Math.round(bin - window)), hi = Math.min(mag.length - 2, Math.round(bin + window));
  for (let i = lo; i <= hi; i++) if (mag[i] > best) { best = mag[i]; k = i; }
  if (k <= 0 || k >= mag.length - 1 || best <= 0) return { bin: k, mag: best, edge: true };
  const db = (i) => 20 * Math.log10(Math.max(mag[i], 1e-18));
  const a = db(k - 1), b = db(k), c = db(k + 1);
  const den = a - 2 * b + c;
  const d = Math.abs(den) < 1e-12 ? 0 : 0.5 * (a - c) / den;
  return { bin: k + Math.max(-0.5, Math.min(0.5, d)), mag: best, edge: k <= lo || k >= hi };
}

/**
 * @param x      mono samples, onset-aligned
 * @param hintHz where to look
 * @returns {hz, B, cents, partials, confident}
 */
export function measurePitch(x, fs, hintHz, { maxPartials = 24, searchCents = 150, skipMs = 60 } = {}) {
  // Skip the strike: during the first few tens of milliseconds the hammer is
  // still in contact and the partials have not settled where they will sit.
  const start = Math.min(Math.round(skipMs * fs / 1000), Math.max(0, x.length - (1 << 13)));
  const { mag, binHz } = spectrum(x, fs, start);
  const nyq = fs / 2;
  const nMax = Math.max(3, Math.min(maxPartials, Math.floor(0.9 * nyq / hintHz)));

  // --- bootstrap by harmonic sum -------------------------------------------
  // Scoring a candidate by the energy at ALL its partials, not just the first,
  // is what makes this work on a note whose fundamental is inaudible. The
  // partial count is fixed across candidates -- derived from the hint, not
  // from the candidate -- because a score summed over a different number of
  // terms for each candidate is not a comparison.
  const pBoot = Math.min(nMax, 12);
  let bestF = hintHz, bestB = 0, bestScore = -1;
  const steps = Math.round(searchCents * 4);
  for (const B of B_LADDER) {
    for (let i = -steps; i <= steps; i++) {
      const f = hintHz * Math.pow(2, (i / 4) / 1200);
      let sc = 0;
      for (let p = 1; p <= pBoot; p++) sc += magAt(mag, p * f * Math.sqrt(1 + B * p * p) / binHz) / p;
      if (sc > bestScore) { bestScore = sc; bestF = f; bestB = B; }
    }
  }

  // --- refine, progressively ------------------------------------------------
  // Five partials first, then more. A typical B shifts partial 20 by several
  // percent, so a window centred on n*f0 with B still wrong misses it entirely
  // and the fit collapses toward B = 0 -- which is precisely what happened
  // when this did every partial at once. Fitting the low ones first gives a B
  // good enough to predict where the high ones actually are, and each round
  // reaches further.
  let f0 = bestF, B = bestB, used = 0;
  const stages = [5, 8, 12, 17, nMax].filter((n, i, a) => n <= nMax && a.indexOf(n) === i);
  for (const top of stages) {
    for (let rep = 0; rep < 2; rep++) {
      const pts = [];
      for (let p = 1; p <= top; p++) {
        const predict = p * f0 * Math.sqrt(1 + B * p * p);
        if (predict > nyq * 0.9) break;
        const span = B === 0 ? 0.022 : Math.min(0.03, 0.004 + 0.4 * B * p * p);
        const r = refine(mag, predict / binHz, Math.max(3, span * predict / binHz));
        if (r.mag <= 0) continue;
        pts.push({ p, f: r.bin * binHz, mag: r.mag, edge: r.edge });
      }
      const peak = Math.max(0, ...pts.map((q) => q.mag));
      // Anything more than 55 dB below the strongest partial is noise, and a
      // noise peak sits wherever the search window put it -- letting those
      // into the fit is what quietly halves a measured B.
      const good = pts.filter((q) => !q.edge && q.mag > peak * 1.8e-3);
      if (good.length < 3) break;
      let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
      for (const q of good) {
        const w = Math.sqrt(q.mag / peak);
        const xi = q.p * q.p, yi = Math.pow(q.f / q.p, 2);
        sw += w; sx += w * xi; sy += w * yi; sxx += w * xi * xi; sxy += w * xi * yi;
      }
      const den = sw * sxx - sx * sx;
      if (Math.abs(den) < 1e-12) break;
      const slope = (sw * sxy - sx * sy) / den;
      const inter = (sy * sxx - sx * sxy) / den;
      if (!(inter > 0)) break;
      f0 = Math.sqrt(inter);
      B = Math.max(0, slope / inter);
      used = good.length;
    }
  }

  // Not enough partials for a joint fit -- the top octave, where only three
  // or four clear Nyquist and the ones that do are near the noise floor. A
  // fit through three uncertain points is worse than no fit: on C8 it put the
  // pitch 11 cents off what a direct search finds. Up there the fundamental
  // IS the strongest thing in the file, so take the bootstrap's answer for it
  // and do not pretend to have measured B.
  let fundamentalOnly = false, prominenceDb = null;
  if (used < 5) {
    // The harmonic sum is no help here either -- with five partials, three of
    // them near the noise, it can be pulled by a coincidence between a weak
    // upper partial and a wrong B. Search the fundamental alone.
    let bf = hintHz, bm = -1, second = 0;
    for (let i = -steps; i <= steps; i++) {
      const f = hintHz * Math.pow(2, (i / 4) / 1200);
      const m = magAt(mag, f / binHz);
      if (m > bm) { bm = m; bf = f; }
    }
    // How clear is it? Anything more than 40 cents away is a different peak,
    // so the strongest of those is what this one has to beat. A fundamental
    // that stands 6 dB proud of everything else in the window is a
    // measurement; one that does not is a guess, and says so.
    for (let i = -steps; i <= steps; i++) {
      const f = hintHz * Math.pow(2, (i / 4) / 1200);
      if (Math.abs(1200 * Math.log2(f / bf)) < 40) continue;
      const m = magAt(mag, f / binHz);
      if (m > second) second = m;
    }
    prominenceDb = 20 * Math.log10((bm + 1e-18) / (second + 1e-18));
    const r = refine(mag, bf / binHz, 2);
    f0 = r.mag > 0 ? r.bin * binHz : bf;
    B = 0;
    used = Math.max(used, 1);
    fundamentalOnly = true;
  }

  const cents = 1200 * Math.log2(f0 / hintHz);
  return {
    hz: f0, B: fundamentalOnly ? null : B, cents, partials: used, fundamentalOnly, prominenceDb,
    // Trusted when there were partials to fit, or when the fallback found a
    // fundamental that stands clear of everything else in the window. NOT
    // when the answer merely looks ordinary: this instrument's C8 really is
    // 100 cents sharp of equal temperament -- a single peak 10 dB above its
    // neighbours -- and a threshold that called that an error would have been
    // the error.
    confident: (used >= 5 || prominenceDb >= 6) && Math.abs(cents) < searchCents * 0.95,
  };
}
