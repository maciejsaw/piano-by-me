// Soundboard / bridge admittance: a small parallel bank of resonant modes.
// This is the node every string connects to, so it is also the path by which
// strings hear each other.

class Biquad {
  constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.z1 = 0; this.z2 = 0; }
  resonator(fs, f, q, gain) {
    const w = 2 * Math.PI * Math.min(f, 0.45 * fs) / fs;
    const alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha;
    this.b0 = (alpha * gain) / a0; this.b1 = 0; this.b2 = -(alpha * gain) / a0;
    this.a1 = (-2 * Math.cos(w)) / a0; this.a2 = (1 - alpha) / a0;
    return this;
  }
  process(x) {                                    // transposed direct form II
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
  reset() { this.z1 = this.z2 = 0; }
}

// A real soundboard's admittance is a dense forest of modes reaching well past
// 10 kHz, sitting on a broadband radiating plate. Modelling only a dozen low
// modes turns the bridge into a lowpass and the instrument sounds like felt.
// So: a mostly-flat direct path carrying the radiation, with resonances adding
// colour on top, and modes spread across the whole audible range.
const MODES = [
  [52, 7, 0.55], [78, 9, 0.48], [116, 10, 0.42], [163, 11, 0.38],
  [219, 12, 0.34], [298, 13, 0.30], [412, 14, 0.27], [548, 15, 0.24],
  [735, 16, 0.21], [1010, 17, 0.18], [1480, 18, 0.15], [2240, 19, 0.13],
  [3100, 20, 0.11], [4300, 21, 0.09], [5900, 22, 0.07], [7800, 23, 0.05],
];

export class Soundboard {
  constructor(fs, { tilt = 1, spread = 1, direct = 3.2 } = {}) {
    this.fs = fs;
    this.direct = direct;
    // Normalise so the worst-case summed gain cannot exceed 1: the junction's
    // passivity proof needs |soundboard| <= 1.
    const total = MODES.reduce((a, [, , g]) => a + g, 0) + direct;
    this.norm = 1 / total;
    this.modes = MODES.map(([f, q, g]) => new Biquad().resonator(fs, f * spread, q, g * tilt * this.norm));
    this.direct = direct * this.norm;
    // DC blocker:  y[n] = x[n] - x[n-1] + R y[n-1]
    this.dcR = 1 - 2 * Math.PI * 18 / fs;
    this.dcX = 0; this.dcY = 0;
    // gentle radiation rolloff
    this.lpA = 1 - Math.exp(-2 * Math.PI * 14000 / fs);
    this.lpZ = 0;
  }
  process(x) {
    let y = x * this.direct;
    const m = this.modes;
    for (let i = 0; i < m.length; i++) y += m[i].process(x);
    const d = y - this.dcX + this.dcR * this.dcY;
    this.dcX = y; this.dcY = d;
    this.lpZ += this.lpA * (d - this.lpZ);
    return this.lpZ;
  }
  reset() {
    this.modes.forEach((m) => m.reset());
    this.dcX = this.dcY = this.lpZ = 0;
  }
}
