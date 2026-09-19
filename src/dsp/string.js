// One waveguide string: delay line + loss filter + dispersion allpass chain.
// Single-delay-loop form -- the round trip is one period, so one delay line.

const nextPow2 = (n) => { let p = 1; while (p < n) p <<= 1; return p; };

export class WaveguideString {
  constructor(fs, maxDelay = 4096) {
    this.fs = fs;
    this.size = nextPow2(maxDelay + 8);
    this.mask = this.size - 1;
    this.buf = new Float64Array(this.size);
    this.w = 0;

    this.lossZ = 0;
    this.apX = new Float64Array(0);   // x[n-1] per section
    this.apY = new Float64Array(0);   // y[n-1] per section

    this.exc = new Float64Array(0);
    this.excPos = 0;

    this.out = 0;
    this.energy = 0;
    this.damperClosed = 1;            // 1 = damper resting on the string
    this.damperTarget = 1;
    this.damperRate = 1 / (0.06 * fs);
    this.active = false;
    this.kUnison = 0;                 // wave fraction shared with its unison partners
    this.kBridge = 0;                 // wave fraction shared with the soundboard
    this.diffLeak = 0.05;              // how much the differential mode still moves the bridge
    this.couplingA = 0;               // one-pole coefficient for the bridge's falling admittance
    this.cLp = 0;                     // its state (common mode)
    this.dLp = 0;                     // and differential; both see the same bridge
    this.setCoefficients({ delay: 100, allpassA: 0, allpassN: 0, lossG: 0.99, lossB: 0.3, dampG: 0.8, dampB: 0.6 });
  }

  setCoefficients(c) {
    this.c = c;
    if (c.couplingA != null) this.couplingA = c.couplingA;
    const d = Math.max(8, Math.min(c.delay, this.size - 6));
    this.dInt = Math.floor(d) - 1;
    this.dFrac = d - Math.floor(d);
    if (this.apX.length !== c.allpassN) {
      this.apX = new Float64Array(c.allpassN);
      this.apY = new Float64Array(c.allpassN);
    }
    // Lagrange-3 taps for fractional delay (alpha in [1,2) -> best-behaved region)
    const a = 1 + this.dFrac;
    this.h0 = -(a - 1) * (a - 2) * (a - 3) / 6;
    this.h1 = a * (a - 2) * (a - 3) / 2;
    this.h2 = -a * (a - 1) * (a - 3) / 2;
    this.h3 = a * (a - 1) * (a - 2) / 6;
  }

  reset() {
    this.buf.fill(0); this.lossZ = 0; this.apX.fill(0); this.apY.fill(0);
    this.out = 0; this.energy = 0; this.w = 0;
  }

  /** Inject a hammer force pulse (already shaped and comb-filtered). */
  excite(pulse) { this.exc = pulse; this.excPos = 0; this.active = true; }

  setDamper(closed) { this.damperTarget = closed ? 1 : 0; }

  /**
   * One sample. `bridge` is last sample's bridge velocity.
   *
   * Coupling is a passive scattering junction, not an additive send. The string
   * gives up a fraction of its wave and receives the same fraction of the
   * junction velocity back, so the update is a convex blend and can only lose
   * energy -- which is also the physical truth, since coupling is how a string
   * radiates. (Feeding energy in additively makes the whole instrument a
   * positive-feedback loop and it blows up.)
   *
   * There are two junctions, because a piano has two very different couplings:
   *   - unison: the 2-3 strings of one note meet at what is nearly a common
   *     point, so they interact strongly -- beating and double decay.
   *   - bridge: each note reaches the rest of the instrument only through the
   *     flexible soundboard, so the interaction is weak -- sympathetic resonance.
   * Both junction values are AVERAGES of the participating waves, never sums,
   * which is what keeps the transfer first-order in the coupling (a send/return
   * pair would be second-order and far too weak to hear) while staying passive.
   */
  tick(unison, bridge) {
    const c = this.c;

    // damper ramp: blend open/closed loss coefficients
    const dc = this.damperClosed;
    if (dc !== this.damperTarget) {
      const s = this.damperTarget > dc ? this.damperRate : -this.damperRate;
      this.damperClosed = Math.max(0, Math.min(1, dc + s));
    }
    const g = c.lossG + (c.dampG - c.lossG) * this.damperClosed;
    const b = c.lossB + (c.dampB - c.lossB) * this.damperClosed;

    // --- read delay line, Lagrange-3 interpolated ---
    const buf = this.buf, mask = this.mask, w = this.w, i = this.dInt;
    let x = this.h0 * buf[(w - i) & mask]
          + this.h1 * buf[(w - i - 1) & mask]
          + this.h2 * buf[(w - i - 2) & mask]
          + this.h3 * buf[(w - i - 3) & mask];

    // --- one-pole loss:  H(z) = g(1-b)/(1 - b z^-1) ---
    this.lossZ = g * (1 - b) * x + b * this.lossZ;
    x = this.lossZ;

    // --- dispersion allpass chain:  y = a(x - y[n-1]) + x[n-1] ---
    const a = c.allpassA, n = c.allpassN, apX = this.apX, apY = this.apY;
    for (let k = 0; k < n; k++) {
      const y = a * (x - apY[k]) + apX[k];
      apX[k] = x; apY[k] = y; x = y;
    }

    this.out = x;

    // --- excitation + bridge coupling back into the loop ---
    //
    // What a bridge does is SELECTIVE, and the selectivity is the whole reason a
    // piano has an aftersound. Split this string's wave into the part it shares
    // with its unison partners and the part it does not:
    //
    //   common       all strings push the bridge the same way, so the bridge
    //                moves, radiates, and this component is damped hard
    //   differential the strings pull against each other, net force at the
    //                bridge is zero, it barely moves, and this component rings
    //                on almost undamped -- the long aftersound
    //
    // Blending toward the unison average does the exact opposite: it preserves
    // the average and attenuates the difference. Subtracting the average instead
    // damps only the common part and leaves the differential untouched, which is
    // both the correct sign and still passive (common gain 1-ku-kb <= 1,
    // differential gain exactly 1, and the loss filter above already took its
    // share this trip).
    //
    // The cancellation is not perfect, though: the strings of one unison sit a
    // few millimetres apart on the bridge, not on top of each other, so the
    // differential mode does move it slightly. diffLeak is that fraction. At 0
    // the aftersound is lossless, which rings far too long and leaves nothing
    // for a struck string to drive its neighbours with.
    const ku = this.kUnison, kb = this.kBridge, leak = this.diffLeak;
    const k = ku + kb;
    // Lowpassed, because the bridge yields to low frequencies and not to high
    // ones. Without this the coupling damps every partial at the rate only the
    // fundamental should see, and the note stops sounding seconds early.
    const aC = this.couplingA;
    this.cLp = (1 - aC) * unison + aC * this.cLp;
    this.dLp = (1 - aC) * (x - unison) + aC * this.dLp;
    let inp = x - k * this.cLp + kb * bridge - leak * k * this.dLp;
    const e = this.exc;
    if (this.excPos < e.length) inp += e[this.excPos++];

    this.buf[w] = inp;
    this.w = (w + 1) & mask;

    // cheap running energy estimate for voice culling
    this.energy += (x * x - this.energy) * 0.001;
    if (this.active && this.energy < 1e-12 && this.excPos >= e.length) this.active = false;
    return this.out;
  }
}
