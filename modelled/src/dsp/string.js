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
    this.nlZ = 0;                     // transient-damping lowpass state
    this.nlOn = false;                // is the stage running at all
    this.nlPeak = 0;                  // its depth for this strike
    this.nlDepth = 0;                 // and the depth at full velocity
    this.nlR = 0;                     // rise state, 0 at the strike
    this.nlPhase = 1;                 // 0 at the strike, 1 when the build ends
    this.nlPhaseInc = 1;              // 1 / (build length in samples)
    this.nlSkew = 1;                  // how far the release is pushed to the end
    // Radiated level, as opposed to string state. A soundboard does not begin
    // radiating the instant the string moves: it has to be set going, and
    // until it is, the note is simply QUIETER -- not just darker. Damping was
    // modelled here as a change to the string's spectrum only, which leaves
    // the strike at full level however much top is taken off it, and that is
    // what makes the attack peak and click. This swells what LEAVES for the
    // soundboard; the string's own physics and its junctions are untouched.
    this.swell = 1;
    this.swellInc = 1;                // 1 / (swell length in samples)
    this.swellFloor = 0;              // level at the moment of contact
    this.swellSkew = 1;
    this.nlRiseA = 1;                 // per-sample rise coefficient
    this.nlB = 0;                     // its lowpass coefficient
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
    this.delayScale = 1;              // tension drift, as a relative delay change
    this.lock = 1;                    // entrainment toward the unison's common pitch
    this.lockTarget = 1;
    this.drift = 0;                   // its lowpassed-noise state
    this.driftSeed = 22222;
    this.cLp = 0;                     // its state (common mode)
    this.dLp = 0;                     // and differential; both see the same bridge
    this.setCoefficients({ delay: 100, allpassA: 0, allpassN: 0, lossG: 0.99, lossB: 0.3, dampG: 0.8, dampB: 0.6 });
  }

  setCoefficients(c) {
    this.c = c;
    if (c.couplingA != null) this.couplingA = c.couplingA;
    if (c.nlB != null) this.nlB = c.nlB;
    this.setDelayScale(this.delayScale);
  }

  /**
   * Re-tune the delay line by a small relative amount. Used for tension drift,
   * so it has to be cheap: the integer part rarely moves and only the four
   * Lagrange taps are rebuilt.
   */
  setDelayScale(scale) {
    this.delayScale = scale;
    const c = this.c;
    const d = Math.max(8, Math.min(c.delay * scale, this.size - 6));
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
    this.nlZ = 0; this.nlOn = false; this.nlR = 0; this.nlPhase = 1;
    this.out = 0; this.energy = 0; this.w = 0;
  }

  /** Inject a hammer force pulse (already shaped and comb-filtered). */
  excite(pulse, strength = 1) {
    this.exc = pulse; this.excPos = 0; this.active = true;
    this.nlPeak = this.nlDepth * strength;
    this.nlR = 0; this.nlPhase = 0; this.nlOn = this.nlDepth > 0;
    this.swell = this.swellFloor < 1 ? 0 : 1;
  }

  setDamper(closed) { this.damperTarget = closed ? 1 : 0; }

  /**
   * How much of this string's motion is reaching the soundboard right now.
   * Eased in from `swellFloor` to 1, with the same skew as the build, so the
   * note arrives rather than appears.
   *
   * The skew is CONTINUOUS, not an integer power. It was integer while it was
   * only used for the build, and that turned out to matter here: whole steps
   * are too coarse for the ear on this one. 2 was audibly too curved and 1 is
   * no skew at all, so the useful setting sits between them and has to be
   * reachable. One pow per sample per string, and only for the tens of
   * milliseconds the swell is running -- the compare below ends it.
   */
  radiation() {
    if (this.swell >= 1) return 1;
    const q = this.swellSkew === 1 ? this.swell : Math.pow(this.swell, this.swellSkew);
    const eased = q * q * q * (q * (q * 6 - 15) + 10);
    this.swell += this.swellInc;
    return this.swellFloor + (1 - this.swellFloor) * eased;
  }

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

    // --- transient damping ---
    //
    // The loss filter gives every partial one fixed exponential, so each
    // partial's decay is a straight line in dB by construction. A real one is
    // not: it falls fast while the string is still moving hard and then goes
    // soft, and the higher the partial the sharper the bend. Measured on the
    // Salamander C3, partials above the 10th lose 25 dB/s over the first half
    // second and then almost nothing; ours lost 5 and then kept going at 10.
    //
    // So there is a second loss stage, weighted toward high frequency because
    // that is where a string gives up its energy quickest. Its strength over
    // the note is an envelope with three knobs, because the first version --
    // full depth from the very first sample, fading out with one time
    // constant -- took the top off the attack itself, which is the one part
    // of the note that was already right:
    //
    //   rise     how long it takes to come on. Zero damps the strike; a long
    //            rise leaves the attack alone and lets the string dull as it
    //            goes, which is what it sounds like it should do.
    //   sustain  the share that stays once it is on, rather than fading
    //   fall     how fast the rest of it fades
    //
    // This is a two-stage decay stated as such -- a curve fit to what the
    // instrument does, not a derived nonlinearity. Driving it from the
    // string's own amplitude instead was tried first and does not work: it
    // senses the very partials it damps, so it never lets go.
    //
    // Handing the removed part to the soundboard instead of dropping it was
    // tried, on the reasoning that a string radiates most of what it loses.
    // It changed the sympathetic halo by 0.1 dB: what the halo lives on at
    // 2.5 s is the neighbours' low partials, and this stage is gone by then.
    // So it is a plain loss, and the halo cost below is real.
    if (this.nlOn) {
      this.nlR += (1 - this.nlR) * this.nlRiseA;
      // The release is a smootherstep, not an exponential. An exponential is
      // a straight line in dB, and it sounds like one: the high end walks in
      // at a constant rate from the first millisecond, which is neither how a
      // string takes up energy nor what the ear expects. This has zero slope
      // at both ends, so the damping holds through the strike -- cutting more
      // of the initial zing than an exponential of the same length -- and
      // then lets go gently instead of arriving at zero still moving. Easing
      // out at the end is also what allows the whole build to be longer
      // without the note sounding as though it fades up.
      // Skewed: the phase is raised to a power before the smootherstep, so
      // the curve is asymmetric. At skew 1 it is the plain S, half the
      // release done halfway through. At skew 6 the damping is still 96 per
      // cent of full at the halfway point and most of the release happens in
      // the last tenth -- the note holds dark and then opens, rather than
      // opening steadily. That last part is what the ear was asking for: a
      // slope that eats almost all of the beginning.
      let q = this.nlPhase;
      for (let k = 1; k < this.nlSkew; k++) q *= this.nlPhase;
      const fall = 1 - q * q * q * (q * (q * 6 - 15) + 10);
      const m = this.nlPeak * this.nlR * fall;
      this.nlZ = (1 - this.nlB) * x + this.nlB * this.nlZ;
      x -= m * (x - this.nlZ);
      this.nlPhase += this.nlPhaseInc;
      if (this.nlPhase >= 1) this.nlOn = false;
    }

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
