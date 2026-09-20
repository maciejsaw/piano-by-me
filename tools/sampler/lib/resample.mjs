// Fractional-ratio resampling by a Kaiser-windowed sinc.
//
// This is the part that actually moves the pitch. Everything else in the
// repitcher exists to undo a side effect of it.
//
// Sizing, since "use a good interpolator" is not a specification:
//
//   taps 128, beta 10   Kaiser's own design rule, N = (A-8)/(2.285*2*pi*df),
//                       gives ~100 dB stopband with a transition width of
//                       0.1 x Nyquist -- about 2.4 kHz at 48 kHz.
//   cutoff              min(0.86, 0.98/ratio) of Nyquist. The first term
//                       keeps the passband flat to 20.6 kHz; the second is
//                       what stops aliasing when the ratio is above 1, since
//                       reading faster folds everything above fs/(2*ratio).
//                       At the +1 semitone ratio the fold point is 22.65 kHz
//                       and the stopband has already started, so what folds
//                       is 80 dB down on content that is itself near the
//                       24-bit floor.
//   phases 4096         no interpolation between phase sets. The residual is
//                       a phase jitter of 1/8192 sample: -76 dB on a 20 kHz
//                       component, which in a piano sample sits around
//                       -135 dBFS in absolute terms.

/** Modified Bessel function of the first kind, order zero. */
function i0(x) {
  let sum = 1, term = 1;
  const y = x * x / 4;
  for (let k = 1; k < 60; k++) { term *= y / (k * k); sum += term; if (term < sum * 1e-17) break; }
  return sum;
}

export function makeSincTable({ taps = 128, phases = 4096, cutoff = 0.86, beta = 10 } = {}) {
  const half = taps >> 1;
  const table = new Float32Array(phases * taps);
  const norm = 1 / i0(beta);
  for (let p = 0; p < phases; p++) {
    const frac = p / phases;
    let sum = 0;
    const base = p * taps;
    for (let k = 0; k < taps; k++) {
      const u = k - half + 1 - frac;               // distance from the table centre, in input samples
      const w = u / half;                           // Kaiser argument, |w| <= 1
      const win = Math.abs(w) >= 1 ? 0 : i0(beta * Math.sqrt(1 - w * w)) * norm;
      const a = Math.PI * cutoff * u;
      const s = Math.abs(a) < 1e-9 ? cutoff : cutoff * Math.sin(a) / a;
      const v = s * win;
      table[base + k] = v;
      sum += v;
    }
    // Normalise each phase to unity DC gain. Without this the table's DC gain
    // ripples with the phase, which is a ~0.01 dB amplitude modulation at the
    // beat between the ratio and the sample rate -- audible as a faint whine
    // on a sustained low note.
    const g = 1 / sum;
    for (let k = 0; k < taps; k++) table[base + k] *= g;
  }
  return { table, taps, phases, half };
}

/**
 * y[j] = x[j * ratio], band-limited.
 *
 * ratio > 1 reads the source faster, so the pitch goes UP and the sample gets
 * shorter -- which is also what a real string a semitone higher does, so the
 * duration change is a feature and not something to compensate.
 */
export function resample(x, ratio, tab) {
  const { table, taps, phases, half } = tab;
  const n = x.length;
  const outLen = Math.max(1, Math.floor((n - taps) / ratio));
  const out = new Float32Array(outLen);
  for (let j = 0; j < outLen; j++) {
    const t = j * ratio;
    const i0f = Math.floor(t);
    const p = (t - i0f) * phases | 0;
    const base = p * taps;
    let start = i0f - half + 1;
    let acc = 0;
    if (start >= 0 && start + taps <= n) {
      for (let k = 0; k < taps; k++) acc += x[start + k] * table[base + k];
    } else {
      for (let k = 0; k < taps; k++) {
        const i = start + k;
        if (i >= 0 && i < n) acc += x[i] * table[base + k];
      }
    }
    out[j] = acc;
  }
  return out;
}
