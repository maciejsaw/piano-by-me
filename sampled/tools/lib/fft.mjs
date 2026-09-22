// Radix-2 complex FFT, in place, with per-size tables cached.
//
// The pipeline calls this tens of millions of times (a true-envelope estimate
// is a dozen transforms per frame), so the bit-reversal permutation and the
// twiddles are built once per transform size and reused.

const CACHE = new Map();

function tables(n) {
  let t = CACHE.get(n);
  if (t) return t;
  const rev = new Uint32Array(n);
  let bits = 0; while ((1 << bits) < n) bits++;
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(-2 * Math.PI * i / n); sin[i] = Math.sin(-2 * Math.PI * i / n); }
  t = { rev, cos, sin, bits };
  CACHE.set(n, t);
  return t;
}

/** In-place complex FFT. `inverse` conjugates the twiddles and scales by 1/n. */
export function fft(re, im, inverse = false) {
  const n = re.length;
  if ((n & (n - 1)) !== 0) throw new Error(`fft size ${n} is not a power of two`);
  const { rev, cos, sin } = tables(n);

  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  const sgn = inverse ? -1 : 1;
  for (let len = 2; len <= n; len <<= 1) {
    const step = n / len, half = len >> 1;
    for (let i = 0; i < n; i += len) {
      for (let k = 0, tw = 0; k < half; k++, tw += step) {
        const wr = cos[tw], wi = sgn * sin[tw];
        const a = i + k, b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
  if (inverse) { const s = 1 / n; for (let i = 0; i < n; i++) { re[i] *= s; im[i] *= s; } }
}

/** Hann window of length n, periodic (the right one for overlap-add). */
export function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
  return w;
}
