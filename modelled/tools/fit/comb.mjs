// Measure comb colouration -- the "flanger" artefact.
//
// A signal mixed with a delayed copy of itself has a magnitude spectrum with
// periodic ripple, and periodic ripple in log-magnitude is a single peak in the
// CEPSTRUM at a quefrency equal to the delay. So the artefact that is hard to
// name by ear has a sharp, unambiguous signature here.
//
// A pitched note also peaks at its own period (and multiples), because its
// harmonic series is itself periodic in frequency. Those peaks are signal, not
// artefact, so they are excluded by quefrency before anything is reported.
//
//   node tools/fit/comb.mjs <a.wav|midi> [b.wav|midi] ...

import { readWav } from './wavread.mjs';

/** In-place iterative radix-2 FFT. */
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k], ai = im[i + k];
        const br = re[i + k + len / 2], bi = im[i + k + len / 2];
        const tr = br * cr - bi * ci, ti = br * ci + bi * cr;
        re[i + k] = ar + tr; im[i + k] = ai + ti;
        re[i + k + len / 2] = ar - tr; im[i + k + len / 2] = ai - ti;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

/**
 * Real cepstrum of a window of x. Returns amplitude per quefrency sample, so
 * index i corresponds to a delay of i/fs seconds.
 */
export function cepstrum(x, fs, { startS = 0.3, lenPow = 16 } = {}) {
  const N = 1 << lenPow;
  const start = Math.round(startS * fs);
  if (start + N > x.length) throw new Error(`need ${((start + N) / fs).toFixed(2)}s, have ${(x.length / fs).toFixed(2)}s`);
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < N; i++) re[i] = x[start + i] * 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
  fft(re, im);
  // log magnitude, floored so silent bins cannot dominate the transform
  let peak = 0;
  const mag = new Float64Array(N);
  for (let i = 0; i < N; i++) { mag[i] = Math.hypot(re[i], im[i]); peak = Math.max(peak, mag[i]); }
  const floor = peak * 1e-6;
  for (let i = 0; i < N; i++) { re[i] = Math.log(Math.max(mag[i], floor)); im[i] = 0; }
  fft(re, im);            // forward again == inverse up to a flip and scale
  const c = new Float64Array(N / 2);
  for (let i = 0; i < N / 2; i++) c[i] = Math.hypot(re[i], im[i]) / N;
  return c;
}

/**
 * Strongest comb-like peak, ignoring quefrencies that belong to the pitch.
 * Returns delay in ms and prominence in dB over the local median.
 */
export function combPeak(c, fs, f0, { loMs = 1.0, hiMs = 14.0, pitchGuardCents = 180 } = {}) {
  const lo = Math.round((loMs * fs) / 1000), hi = Math.min(c.length - 1, Math.round((hiMs * fs) / 1000));
  const period = fs / f0;
  const guard = Math.pow(2, pitchGuardCents / 1200);
  // A quefrency is "pitch" if it sits near period/k or k*period for small k.
  const isPitch = (i) => {
    for (let k = 1; k <= 8; k++) {
      for (const p of [period * k, period / k]) {
        if (p >= lo && i > p / guard && i < p * guard) return true;
      }
    }
    return false;
  };
  const sorted = [...c.slice(lo, hi)].sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1];
  let best = null;
  for (let i = lo; i <= hi; i++) {
    if (isPitch(i)) continue;
    if (c[i] < c[i - 1] || c[i] < c[i + 1]) continue;       // local maxima only
    const db = 20 * Math.log10(c[i] / median);
    if (!best || db > best.db) best = { i, ms: (i * 1000) / fs, db };
  }
  return { ...best, median };
}

/** Peak-to-notch ripple, in dB, that a feedforward comb of this gain produces. */
export const combRippleDb = (g) => 20 * Math.log10((1 + g) / (1 - g));

if (import.meta.url === `file://${process.argv[1]}`) {
  const { Piano } = await import('../../src/dsp/piano.js');
  const { loadNote } = await import('./samples.mjs');
  const { readFileSync } = await import('node:fs');
  const FS = 48000, MIDI = 48, F0 = 130.813;

  const renderModel = (opts) => {
    const p = new Piano(FS, { quality: 32, ...opts });
    const N = FS * 3, x = new Float64Array(N), b = new Float32Array(256);
    p.noteOn(MIDI, 0.8);
    for (let i = 0; i < N; i += 256) { p.render(b, 256); for (let k = 0; k < 256 && i + k < N; k++) x[i + k] = b[k]; }
    return x;
  };
  const bodyF = JSON.parse(readFileSync(new URL('../../fitted/salamander-body.json', import.meta.url), 'utf8'));

  const cases = [
    ['SALAMANDER C3v12', loadNote('/home/user/samples/salamander/C3v12.wav').data, 48000],
    ['model, body on', renderModel({ body: { curve: bodyF.curve } }), FS],
    ['model, lid off', renderModel({ body: { curve: bodyF.curve, lidGain: 0 } }), FS],
    ['model, body off', renderModel({ body: { enabled: false } }), FS],
  ];
  console.log(`\n  lid comb ripple at default gain 0.28: ${combRippleDb(0.28).toFixed(1)} dB peak-to-notch\n`);
  for (const [name, x, fs] of cases) {
    const c = cepstrum(x, fs, { startS: 0.3 });
    const p = combPeak(c, fs, F0);
    console.log(`  ${name.padEnd(18)} strongest non-pitch peak: ${p.ms.toFixed(2)} ms  (${(1000 / p.ms).toFixed(0)} Hz spacing)  +${p.db.toFixed(1)} dB`);
  }
}
