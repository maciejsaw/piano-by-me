// The body: everything between soundboard motion and the air at your ears.
//
// The string model stops at the bridge. It knows how the soundboard loads the
// strings, but a piano without a case, lid and cavity does not sound like a
// piano -- and measuring the model against real recordings shows it plainly:
// a smooth ~22 dB tilt, bass-heavy and treble-shy, identical for every note.
// That is a missing radiation path, not a missing string parameter.
//
// Crucially this block sits DOWNSTREAM of every coupling path, so making it
// linear and time-invariant costs nothing. (Putting the soundboard INSIDE the
// string loop as an LTI block is what commuted synthesis does, and that is why
// commuted synthesis cannot produce sympathetic resonance. Here the feedback
// has already happened.) Air loading back onto a spruce plate is a small
// perturbation, so the approximation is a good one.
//
// Three parts, cheapest first:
//   radiation   plate radiation efficiency + baffle: a fitted octave-band EQ
//   cavity      the enclosed air, as analytic rectangular box modes
//   lid         one early reflection, which is most of the lid's audible effect

class Biquad {
  constructor() { this.b0 = 1; this.b1 = this.b2 = this.a1 = this.a2 = 0; this.z1 = this.z2 = 0; }
  peaking(fs, f, q, gainDb) {
    const A = Math.pow(10, gainDb / 40);
    const w = 2 * Math.PI * Math.min(f, 0.45 * fs) / fs;
    const alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha / A;
    this.b0 = (1 + alpha * A) / a0;
    this.b1 = (-2 * Math.cos(w)) / a0;
    this.b2 = (1 - alpha * A) / a0;
    this.a1 = (-2 * Math.cos(w)) / a0;
    this.a2 = (1 - alpha / A) / a0;
    return this;
  }
  resonator(fs, f, q, gain) {
    const w = 2 * Math.PI * Math.min(f, 0.45 * fs) / fs;
    const alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha;
    this.b0 = (alpha * gain) / a0; this.b1 = 0; this.b2 = -(alpha * gain) / a0;
    this.a1 = (-2 * Math.cos(w)) / a0; this.a2 = (1 - alpha) / a0;
    return this;
  }
  /** Magnitude response at angular frequency w. */
  mag(w) {
    const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
    const nr = this.b0 + this.b1 * c1 + this.b2 * c2, ni = -(this.b1 * s1 + this.b2 * s2);
    const dr = 1 + this.a1 * c1 + this.a2 * c2, di = -(this.a1 * s1 + this.a2 * s2);
    return Math.hypot(nr, ni) / Math.hypot(dr, di);
  }
  process(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
  reset() { this.z1 = this.z2 = 0; }
}

/**
 * Octave-band EQ fitted to an arbitrary measured curve.
 *
 * Peaking sections overlap, so setting each band's gain to the target value at
 * its centre overshoots badly. The gains are fitted iteratively against the
 * cascade's actual response instead, which converges in a few passes.
 */
class BandEq {
  constructor(fs, curve, { centres = null, q = 1.3, passes = 60 } = {}) {
    this.fs = fs;
    this.centres = centres ?? [31.25, 62.5, 125, 250, 500, 1000, 2000, 4000, 8000, 12000]
      .filter((f) => f < 0.45 * fs);
    this.gains = this.centres.map((f) => curveAt(curve, f));
    this.filters = this.centres.map(() => new Biquad());
    const apply = () => this.centres.forEach((f, i) =>
      this.filters[i].peaking(fs, f, q, this.gains[i]));
    apply();

    const respDb = (f) => {
      const w = 2 * Math.PI * f / fs;
      let db = 0;
      for (const b of this.filters) db += 20 * Math.log10(Math.max(b.mag(w), 1e-9));
      return db;
    };
    for (let p = 0; p < passes; p++) {
      let worst = 0;
      for (let i = 0; i < this.centres.length; i++) {
        const target = curveAt(curve, this.centres[i]);
        const err = target - respDb(this.centres[i]);
        this.gains[i] += 0.7 * err;
        worst = Math.max(worst, Math.abs(err));
        apply();
      }
      if (worst < 0.05) break;
    }
  }
  process(x) {
    let y = x;
    for (let i = 0; i < this.filters.length; i++) y = this.filters[i].process(y);
    return y;
  }
  reset() { this.filters.forEach((f) => f.reset()); }
}

/** Interpolate a [[hz, dB], ...] curve in log frequency. */
export function curveAt(curve, f) {
  if (!curve || !curve.length) return 0;
  if (f <= curve[0][0]) return curve[0][1];
  if (f >= curve[curve.length - 1][0]) return curve[curve.length - 1][1];
  for (let i = 0; i < curve.length - 1; i++) {
    const [f0, v0] = curve[i], [f1, v1] = curve[i + 1];
    if (f >= f0 && f <= f1) {
      const t = Math.log(f / f0) / Math.log(f1 / f0);
      return v0 + (v1 - v0) * t;
    }
  }
  return curve[curve.length - 1][1];
}

const C_AIR = 343;

/**
 * Modes of the air enclosed by the case, from the closed-form rectangular
 * solution f = (c/2)*sqrt((nx/Lx)^2 + (ny/Ly)^2 + (nz/Lz)^2).
 *
 * A real case is not a rectangular box, but the modal DENSITY and spacing are
 * what colour the sound, and those are set by the volume and proportions rather
 * than by the exact bent-rim shape. This costs nothing to compute and it makes
 * the case dimensions real, editable parameters -- which a convolved impulse
 * response can never be.
 */
export function boxModes(Lx, Ly, Lz, fMax = 1200, limit = 160) {
  const modes = [];
  const nxMax = Math.ceil((2 * fMax * Lx) / C_AIR);
  const nyMax = Math.ceil((2 * fMax * Ly) / C_AIR);
  const nzMax = Math.ceil((2 * fMax * Lz) / C_AIR);
  for (let nx = 0; nx <= nxMax; nx++)
    for (let ny = 0; ny <= nyMax; ny++)
      for (let nz = 0; nz <= nzMax; nz++) {
        if (!nx && !ny && !nz) continue;
        const f = (C_AIR / 2) * Math.hypot(nx / Lx, ny / Ly, nz / Lz);
        if (f > fMax || f < 20) continue;
        // Axial modes (one index) are strongest, then tangential, then oblique.
        const order = (nx > 0) + (ny > 0) + (nz > 0);
        modes.push({ f, weight: order === 1 ? 1 : order === 2 ? 0.55 : 0.3 });
      }
  modes.sort((a, b) => a.f - b.f);
  return modes.slice(0, limit);
}

/**
 * Soundboard ring-up.
 *
 * A real soundboard is a plate with a dense forest of modes, and its response
 * to a sharp bridge force is not sharp: the energy spreads over tens of
 * milliseconds as those modes take it up. Measured on the Salamander C4, the
 * note reaches half its level 8 ms after contact and peaks at 28 ms. Ours,
 * with the board modelled as an EQ, reached half in 2 ms and peaked at 3 --
 * it came out of digital silence and rose 117 dB in under a millisecond and a
 * half, which is the click that survived softening the felt.
 *
 * This is a chain of allpass diffusers, which is the one structure that
 * spreads a transient in time WITHOUT touching the magnitude spectrum. That
 * matters here: the spectral balance has been fitted against the samples over
 * many rounds, and a reverb with a magnitude of its own would undo that work
 * silently. An allpass chain cannot -- it only moves energy in time.
 *
 * Delays ASCEND, from about a millisecond up to `spreadMs`, and are mutually
 * prime so the chain does not build a periodic echo. Order matters more than
 * it looks: a long allpass first is one discrete echo, not diffusion, and it
 * leaves the first few milliseconds as sparse as it found them. Putting the
 * short ones first fills that gap, which is the part that sounds like a click.
 */
class Diffuser {
  constructor(fs, { spreadMs = 24, stages = 5, g = 0.62 } = {}) {
    // Ascending, and enough of them that a bigger board can have more stages
    // without the lengths starting to repeat and ring.
    const ratios = [0.04, 0.07, 0.13, 0.22, 0.37, 0.6, 0.78, 0.95];
    this.g = g;
    this.buf = [];
    this.pos = [];
    for (let i = 0; i < stages; i++) {
      let n = Math.max(2, Math.round((spreadMs * ratios[i % ratios.length] * fs) / 1000));
      if (n % 2 === 0) n += 1;                 // odd lengths, mutually prime enough
      this.buf.push(new Float64Array(n));
      this.pos.push(0);
    }
  }

  process(x) {
    let y = x;
    for (let i = 0; i < this.buf.length; i++) {
      const b = this.buf[i], p = this.pos[i];
      const d = b[p];
      const v = y + this.g * d;
      b[p] = v;
      this.pos[i] = (p + 1) % b.length;
      y = d - this.g * v;
    }
    return y;
  }

  reset() { this.buf.forEach((b) => b.fill(0)); this.pos.fill(0); }
}

export class Body {
  constructor(fs, opts = {}) {
    this.fs = fs;
    this.enabled = opts.enabled !== false;

    // --- radiation / baffle EQ, normally the fitted curve ---
    this.curve = opts.curve ?? DEFAULT_RADIATION;
    this.eq = new BandEq(fs, this.curve);

    // --- cavity ---
    const cw = opts.caseWidth ?? 1.45;      // m, across the keyboard
    const cl = opts.caseLength ?? 2.00;     // m, front to tail
    const cd = opts.caseDepth ?? 0.26;      // m, soundboard to lid / under-board
    this.cavityMix = opts.cavityMix ?? 0.18;
    const q = opts.cavityQ ?? 26;           // lower = more open / more absorbent
    this.modes = boxModes(cw, cl, cd, opts.cavityFMax ?? 1100, opts.cavityModes ?? 140);
    const norm = 1 / Math.sqrt(Math.max(1, this.modes.length));
    this.cavity = this.modes.map((m) => new Biquad().resonator(fs, m.f, q, m.weight * norm));

    // --- lid: one early reflection ---
    this.lidGain = opts.lidGain ?? 0.28;
    const lidMs = opts.lidDelayMs ?? 3.4;
    this.lidBuf = new Float64Array(Math.max(2, Math.round((lidMs * fs) / 1000)));
    this.lidPos = 0;

    // --- soundboard ring-up ---
    // 1, not a partial mix. What reaches the room from a piano is the board;
    // a string moves too little air to be heard directly, and a third of the
    // output bypassing the plate was the direct string the ear kept calling a
    // clavinet. It is also the only setting that colours nothing: at 1 this is
    // exactly an allpass, magnitude untouched, energy moved only in time. A
    // partial mix combs the dry path against the diffused one, so 0.67 was the
    // most coloured value in the range as well as the least plausible.
    this.boardMix = opts.boardMix ?? 1;
    // Kept so a rebuild can carry them over rather than silently reverting.
    this.spreadMs = opts.boardSpreadMs ?? 37;
    this.diffuserG = opts.boardG ?? 0.665;
    this.diffuser = new Diffuser(fs, {
      spreadMs: opts.boardSpreadMs ?? 37,
      stages: opts.boardStages ?? 5,
      g: opts.boardG ?? 0.665,
    });
  }

  process(x) {
    if (!this.enabled) return x;
    let cav = 0;
    for (let i = 0; i < this.cavity.length; i++) cav += this.cavity[i].process(x);
    let y = this.eq.process(x + this.cavityMix * cav);
    const d = this.lidBuf[this.lidPos];
    this.lidBuf[this.lidPos] = y;
    this.lidPos = (this.lidPos + 1) % this.lidBuf.length;
    y += this.lidGain * d;
    return this.boardMix > 0 ? y + this.boardMix * (this.diffuser.process(y) - y) : y;
  }

  reset() {
    this.eq.reset();
    this.cavity.forEach((b) => b.reset());
    this.lidBuf.fill(0);
    this.lidPos = 0;
    this.diffuser.reset();
  }
}

/**
 * Default radiation curve, in dB to add to bridge output.
 *
 * Shape follows plate radiation physics: poor radiation well below the critical
 * frequency rising roughly 6 dB/octave, flattening out above it, with the case
 * acting as a baffle to keep the very bottom from cancelling. Replace it with a
 * curve fitted to a real instrument (tools/fit/body.mjs) for a specific piano.
 */
export const DEFAULT_RADIATION = [
  [31, -10], [62, -8], [125, -6], [250, -4.5], [500, -1.5],
  [1000, 2.5], [2000, 6.5], [4000, 8.0], [8000, 6.0], [14000, 2.0],
];
