// How bright is the note, and does it stay that way?
//
// The decay-rate tables in stages.mjs compare how fast each partial falls.
// They cannot see a note that is uniformly too bright, or one whose top
// collapses while its rates still look reasonable -- and that second case is
// exactly what over-damping sounds like. So this reports the plain ratio of
// high-band to low-band energy at a series of times.
//
// Measured on the Salamander C3 it is nearly flat: -32.7 dB at 50 ms, -27.7
// at 2 s, -33.0 at 6 s. A real piano does not dull as it decays anywhere near
// as much as it seems to; the top falls at about the rate the bottom does.
import { fft } from './comb.mjs';

export const TIMES = [0.05, 0.2, 0.5, 1, 2, 4, 6];

/**
 * The bands follow the note. Fixed bands work in the middle and are
 * meaningless at the ends: above F#5 the fundamental is already above 600 Hz,
 * so a fixed 100-600 low band holds none of the note and the ratio is
 * measuring the high band against a noise floor. That produced 7 to 22 dB of
 * pure nonsense across the top two octaves on the first keyboard-wide fit.
 */
export function bandsFor(f0) {
  return { lo: [f0 * 0.7, f0 * 3], hi: [Math.min(f0 * 6, 12000), Math.min(f0 * 20, 16000)] };
}

export function brightness(x, fs, { times = TIMES, f0 = null, hi = [2000, 6000], lo = [100, 600] } = {}) {
  if (f0) ({ lo, hi } = bandsFor(f0));
  const N = 8192;
  return times.map((t) => {
    const re = new Float64Array(N), im = new Float64Array(N), st = Math.round(t * fs);
    for (let i = 0; i < N; i++) {
      const v = x[st + i] ?? 0;
      re[i] = v * 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
    }
    fft(re, im);
    const band = ([a, b]) => {
      let s = 0;
      for (let k = Math.floor((a * N) / fs); k <= Math.ceil((b * N) / fs); k++) s += re[k] * re[k] + im[k] * im[k];
      return s;
    };
    return 10 * Math.log10(band(hi) / Math.max(band(lo), 1e-30));
  });
}

export function printBrightness(label, b, times = TIMES) {
  console.log(label.padEnd(22) + b.map((v) => v.toFixed(1).padStart(7)).join(''));
}
