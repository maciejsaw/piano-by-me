// Where is it worth measuring this note at all?
//
// A fixed pair of bands is wrong at both ends of the keyboard, and a pair
// scaled off f0 is only half a fix. A0's twentieth partial is a real, loud
// thing; C7's is above Nyquist, and its sixth is already down in the hiss of
// the recording. Comparing our model against the sample up there compares two
// noise floors -- and ours is 60 dB quieter than a real microphone's, which
// is why the treble fits came back with 16 to 36 dB of error and the knobs
// thrashing between their extremes.
//
// So the bands are measured off the sample, per key:
//
//   floor   per-bin minimum magnitude over the whole file. A partial is
//           present in some windows and absent in others; the noise is in all
//           of them, so the running minimum converges on the noise and not on
//           the note.
//   fTop    the highest frequency where the note, at its loudest, still
//           stands clear of that floor. Above it there is nothing to compare.
//   low     0.7 to 2.5 x f0 -- the fundamental and the octave, always loud
//   high    4 x f0 up to fTop, and only if that leaves a band worth the name
//
// Band powers have the floor's power subtracted, so a real sample measured
// close to its own hiss is not credited for the hiss.
import { fft } from './comb.mjs';

const N = 8192;

function spectrum(x, start, out) {
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const v = x[start + i] ?? 0;
    re[i] = v * 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
  }
  fft(re, im);
  const half = N / 2;
  const mag = out ?? new Float64Array(half);
  for (let k = 0; k < half; k++) mag[k] = re[k] * re[k] + im[k] * im[k];
  return mag;
}

/** Per-bin noise floor, as the running minimum over the file. */
export function noiseFloor(x, fs, { hopS = 0.25 } = {}) {
  const hop = Math.round(hopS * fs);
  const floor = new Float64Array(N / 2).fill(Infinity);
  let used = 0;
  for (let st = 0; st + N < x.length; st += hop) {
    const m = spectrum(x, st);
    for (let k = 0; k < floor.length; k++) if (m[k] < floor[k]) floor[k] = m[k];
    used++;
  }
  if (!used) floor.fill(0);
  else for (let k = 0; k < floor.length; k++) if (!Number.isFinite(floor[k])) floor[k] = 0;
  return floor;
}

/** Third-octave smoothed power spectrum, as dB per band centre. */
export function thirdOctave(mag, fs, { fMin = 40, fMax = 20000 } = {}) {
  const binHz = fs / N, out = [];
  for (let fc = fMin; fc < fMax; fc *= Math.pow(2, 1 / 3)) {
    const lo = fc / Math.pow(2, 1 / 6), hi = fc * Math.pow(2, 1 / 6);
    let s = 0, n = 0;
    for (let k = Math.max(1, Math.floor(lo / binHz)); k <= Math.min(mag.length - 1, Math.ceil(hi / binHz)); k++) { s += mag[k]; n++; }
    if (n) out.push({ fc, db: 10 * Math.log10(s / n + 1e-30) });
  }
  return out;
}

/**
 * Measurement bands for one sampled note.
 *
 * fTop is where the note itself runs out, not where the file does: the
 * highest third-octave band still within `dynDb` of the note's loudest band
 * at the strike. Reading it off a noise floor does not work -- these samples
 * end in digital silence, so the floor is zero and every bin up to Nyquist
 * looks occupied.
 *
 * Returns { lo, hi, fTop, usable, floor } with band edges in Hz.
 */
export function fitBands(x, fs, f0, { dynDb = 55, peakS = 0.15 } = {}) {
  const floor = noiseFloor(x, fs);
  const bands = thirdOctave(spectrum(x, Math.round(peakS * fs)), fs);
  const peak = Math.max(...bands.map((b) => b.db));
  let fTop = f0;
  for (const b of bands) if (b.db > peak - dynDb && b.fc > fTop) fTop = b.fc;
  const lo = [f0 * 0.7, f0 * 2.5];
  const hiLo = f0 * 4;
  const hiHi = Math.min(fTop, f0 * 24, fs / 2.2);
  return { lo, hi: [hiLo, hiHi], fTop, usable: hiHi > hiLo * 1.5, floor };
}

/** Band power with the noise floor taken out, in dB. */
export function bandRatioDb(x, fs, at, { lo, hi, floor = null }) {
  const m = spectrum(x, Math.round(at * fs));
  const binHz = fs / N;
  const sum = ([a, b]) => {
    let s = 0;
    for (let k = Math.max(1, Math.floor(a / binHz)); k <= Math.min(m.length - 1, Math.ceil(b / binHz)); k++) {
      s += floor ? Math.max(m[k] - floor[k], 0) : m[k];
    }
    return s;
  };
  return 10 * Math.log10((sum(hi) + 1e-30) / (sum(lo) + 1e-30));
}
