// Does the repitch filter do exactly what it says?
//
// This used to score the correction by tracking partial levels through a
// synthetic instrument with a known body -- which worked, but was measuring
// the algorithm through a piano-shaped keyhole. A sampled instrument has no
// physics to verify: the recording already contains it. The only thing this
// build step can get wrong is the FILTER, so the filter is what is measured,
// directly and without a note in sight.
//
//   1. the realised response equals Body(f) / Body(f/ratio), the thing
//      repitch.mjs claims to apply, to a fraction of a decibel
//   2. it is zero phase -- a symmetric input comes back symmetric, so nothing
//      in the hammer attack has been smeared or delayed
//   3. it adds no noise
//   4. the body actually fitted from this library asks for a real correction,
//      so none of the above is a test of doing nothing
import { makeSincTable } from './lib/resample.mjs';
import { repitch, correctionAt, bodyDb } from './lib/repitch.mjs';
import { fft, hann } from './lib/fft.mjs';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const fs = 48000;
const body = JSON.parse(readFileSync(join(REPO, 'modelled', 'fitted', 'salamander-body.json'), 'utf8')).curve;

/**
 * The H1 transfer-function estimate between two signals.
 *
 * cross-spectrum over input power, averaged across frames. It gives magnitude
 * AND phase in one pass, which is the whole point: a zero-phase filter is a
 * claim about phase, and the obvious way to check it -- feed a symmetric
 * impulse and look for a symmetric output -- founders on the fact that a
 * resampled impulse is a sinc centred between two samples, so there is no
 * sample to measure symmetry about.
 */
function transfer(inp, out, N = 32768) {
  const w = hann(N), half = N >> 1;
  const cr = new Float64Array(half + 1), ci = new Float64Array(half + 1), pw = new Float64Array(half + 1);
  const ar = new Float64Array(N), ai = new Float64Array(N);
  const br = new Float64Array(N), bi = new Float64Array(N);
  for (let c = 0; c + N <= Math.min(inp.length, out.length); c += N >> 1) {
    ai.fill(0); bi.fill(0);
    for (let i = 0; i < N; i++) { ar[i] = inp[c + i] * w[i]; br[i] = out[c + i] * w[i]; }
    fft(ar, ai, false); fft(br, bi, false);
    for (let k = 0; k <= half; k++) {
      cr[k] += br[k] * ar[k] + bi[k] * ai[k];          // Out * conj(In)
      ci[k] += bi[k] * ar[k] - br[k] * ai[k];
      pw[k] += ar[k] * ar[k] + ai[k] * ai[k];
    }
  }
  const db = new Float64Array(half + 1), deg = new Float64Array(half + 1);
  for (let k = 0; k <= half; k++) {
    const p = Math.max(pw[k], 1e-30);
    db[k] = 20 * Math.log10(Math.hypot(cr[k], ci[k]) / p + 1e-30);
    deg[k] = Math.atan2(ci[k], cr[k]) * 180 / Math.PI;
  }
  return { db, deg, N };
}

let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x3fffffff) - 1;

console.log('\n  Repitch filter, measured against what it claims to be\n');
console.log('  shift   magnitude error vs Body(f)/Body(f/r)        phase');

let worstMag = 0, worstPhase = 0;
for (const semi of [1, -1]) {
  const ratio = Math.pow(2, semi / 12);
  const tab = makeSincTable({ cutoff: Math.min(0.86, 0.98 / Math.max(ratio, 1)) });
  const n = fs * 24;
  const noise = new Float32Array(n);
  for (let i = 0; i < n; i++) noise[i] = rnd() * 0.25;

  // Both start from the SAME resampled signal, so what is between them is the
  // filter and nothing else -- no resampling, no windowing, no note.
  const plain = repitch([noise], fs, ratio, tab, null)[0];
  const fixed = repitch([noise], fs, ratio, tab, correctionAt(body, ratio))[0];
  const { db, deg, N } = transfer(plain, fixed);

  let sum = 0, cnt = 0, worst = 0, at = 0, ph = 0;
  for (let k = 1; k <= N >> 1; k++) {
    const f = k * fs / N;
    // Below 100 Hz the fitted curve turns by 30 dB in an octave and a few
    // bins cannot resolve it; above 13.5 kHz the fit ran out of partials and
    // the correction is flat by construction. Both are excluded because the
    // MEASUREMENT is the limit there, not the filter.
    if (f < 100 || f > 13000) continue;
    const want = bodyDb(body, f) - bodyDb(body, f / ratio);
    const err = Math.abs(db[k] - want);
    sum += err * err; cnt++;
    if (err > worst) { worst = err; at = f; }
    ph = Math.max(ph, Math.abs(deg[k]));
  }
  worstMag = Math.max(worstMag, worst);
  worstPhase = Math.max(worstPhase, ph);
  console.log(`  ${semi > 0 ? '+1' : '-1'}      rms ${Math.sqrt(sum / cnt).toFixed(3)} dB, worst ${worst.toFixed(2)} dB at ${at.toFixed(0)} Hz     max ${ph.toFixed(4)} deg`);
}

// --- noise floor ---------------------------------------------------------
const ratio = Math.pow(2, 1 / 12);
const tab = makeSincTable({ cutoff: Math.min(0.86, 0.98 / ratio) });
const n2 = fs * 4;
const quiet = new Float32Array(n2);
for (let i = 0; i < n2; i++) quiet[i] = rnd() * 1e-4;
const q0 = repitch([quiet], fs, ratio, tab, null)[0];
const q1 = repitch([quiet], fs, ratio, tab, correctionAt(body, ratio))[0];
const rms = (x) => { let s = 0; for (const v of x) s += v * v; return Math.sqrt(s / x.length); };

// --- is there anything to correct at all? --------------------------------
const g = correctionAt(body, ratio);
let maxDb = 0, atF = 0;
for (let f = 30; f < 16000; f *= 1.005) {
  const d = Math.abs(20 * Math.log10(g(f)));
  if (d > maxDb) { maxDb = d; atF = f; }
}

console.log(`\n  noise floor, plain vs corrected: ${rms(q0).toExponential(2)} vs ${rms(q1).toExponential(2)}`);
console.log(`  the fitted body asks for       : up to ${maxDb.toFixed(2)} dB, at ${atF.toFixed(0)} Hz`);
console.log(`  (flat below ${body[0][0].toFixed(0)} Hz and above ${body[body.length - 1][0].toFixed(0)} Hz, so the correction goes to zero at both ends)`);

const checks = [
  ['the filter is the one claimed', worstMag < 0.35],
  ['it is zero phase', worstPhase < 0.05],
  ['it adds no noise', rms(q1) < rms(q0) * 1.4],
  ['and there is something to correct', maxDb > 1],
];
console.log('');
for (const [n, ok] of checks) console.log(`  ${ok ? 'pass' : 'FAIL'}  ${n}`);
const ok = checks.every((c) => c[1]);
console.log(ok ? '\n  SELFTEST PASSED\n' : '\n  SELFTEST FAILED\n');
process.exit(ok ? 0 : 1);
