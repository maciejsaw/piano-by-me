// The instrument.
//
// Coupling is hierarchical, because a piano's two coupling mechanisms differ by
// orders of magnitude:
//
//   strings of one note  --> near-common bridge point  (strong: beating, double decay)
//   note                 --> soundboard zone           (weak:   sympathetic resonance)
//   zone                 --> neighbouring zones        (weaker: register-dependent halo)
//
// Every junction value is an AVERAGE of the waves meeting there, so each update
// is a convex blend: passive by construction, and first-order in the coupling
// coefficient. Both properties matter. A send/return "sympathetic bus" would be
// second-order and ~50 dB too quiet, and an additive send is a positive-feedback
// loop that detonates.
//
// The junction is instantaneous, which would be a delay-free loop; feeding back
// the previous sample's junction values resolves it for the cost of one sample.

import { buildScale, DEFAULT_SCALE } from './scale.js';
import { compileString } from './design.js';
import { WaveguideString } from './string.js';
import { makeHammerPulse } from './hammer.js';
import { Soundboard } from './soundboard.js';
import { Body } from './body.js';

// Output limiter. Ceiling is exactly 1.0 so the signal can never clip the
// device, and it is applied once per output sample rather than per string.
const softclip = Math.tanh;

const ZONES = 16;             // soundboard regions across the compass

export class Piano {
  constructor(fs, opts = {}) {
    this.fs = fs;
    this.quality = opts.quality ?? 32;
    // Coupling as a fraction of each string's own loss: 0 = isolated strings,
    // 1 = every bit of the string's loss goes into the bridge instead of into
    // internal damping. Stability is guaranteed for anything below 1.
    this.unisonCoupling = opts.unisonCoupling ?? 0.55;
    this.bridgeCoupling = opts.bridgeCoupling ?? 0.30;
    // How much of a unison's differential mode still reaches the bridge.
    this.diffLeak = opts.diffLeak ?? 0.05;
    // Transient damping: a second, fast loss stage that fades out after the
    // strike, weighted toward high frequency. It is what bends each partial's
    // decay away from the straight line the loss filter would give it. depth
    // is the fraction of the high part removed on the first trip at full
    // velocity, tau how long that takes to fade.
    this.transientDepth = opts.transientDepth ?? null;   // null = per note
    this.transientTauS = opts.transientTauS ?? null;    // fall; null = per note
    this.transientRiseS = opts.transientRiseS ?? null;   // rise; null = per note
    this.transientSkew = opts.transientSkew ?? null;     // release skew; null = per note
    // Soundboard swell: how long the radiated level takes to come up, and
    // how far down it starts. Floor 1 disables it.
    this.swellS = opts.swellS ?? null;
    this.swellFloor = opts.swellFloor ?? null;
    this.swellSkew = opts.swellSkew ?? null;
    // Hammer knobs, for fitting the attack against the samples.
    this.feltEps = opts.feltEps ?? null;        // null = per-note from the scale
    this.feltTauUs = opts.feltTauUs ?? 2;
    this.hammerWidth = opts.hammerWidth ?? 1;   // scales the contact patch
    this.feltKScale = opts.feltKScale ?? 1;
    this.feltP = opts.feltP ?? null;            // null = per-note from the scale
    this.strikeOffsetScale = opts.strikeOffsetScale ?? 1;
    this.transientSustain = opts.transientSustain ?? 0;
    this.transientFc = opts.transientFc ?? null;   // null = scale with the note
    this.couplingFc = opts.couplingFc ?? null;     // bridge admittance corner
    // Spread of bridge coupling across the strings of one unison.
    this.bridgeSpread = opts.bridgeSpread ?? 1.3;
    // Tension drift: relative RMS wander of each string's length, and the
    // bandwidth it wanders over.
    this.tensionDrift = opts.tensionDrift ?? 12e-4;
    this.driftHz = opts.driftHz ?? 1.2;
    // How far a unison is pulled to a common pitch, and how long it takes.
    this.unisonLock = opts.unisonLock ?? 0.90;
    this.lockTimeS = opts.lockTimeS ?? 0.3;
    // Mean of the three weights, divided out so the spread cannot shift level.
    this.bridgeNorm = (Math.pow(1 + this.bridgeSpread, -1) + 1 + (1 + this.bridgeSpread)) / 3;
    this.zoneSpread = opts.zoneSpread ?? 2.2;      // how far along the bridge motion travels
    this.masterGain = opts.gain ?? 0.092;
    // Everything downstream of the bridge: radiation, case, cavity, lid.
    this.body = new Body(fs, opts.body ?? {});
    this.sustain = false;
    this.unaCorda = false;
    this.build(opts.scale ?? DEFAULT_SCALE);
  }

  build(scaleDef) {
    const fs = this.fs;
    this.model = buildScale(scaleDef);
    const notes = this.model.notes;

    this.zones = [];
    for (let z = 0; z < ZONES; z++) {
      this.zones.push(new Soundboard(fs, { spread: 0.75 + (1.0 * z) / (ZONES - 1) }));
    }
    // Normalised spread kernel: bridge motion in one region is felt, weaker, in
    // its neighbours. Rows sum to 1 so the drive stays a convex combination.
    this.kernel = [];
    for (let z = 0; z < ZONES; z++) {
      const row = new Float64Array(ZONES);
      let sum = 0;
      for (let w = 0; w < ZONES; w++) {
        const g = Math.exp(-Math.pow((z - w) / this.zoneSpread, 2));
        row[w] = g; sum += g;
      }
      for (let w = 0; w < ZONES; w++) row[w] /= sum;
      this.kernel.push(row);
    }

    this.strings = [];
    this.notes = [];
    const zoneCount = new Float64Array(ZONES);

    for (let ni = 0; ni < notes.length; ni++) {
      const n = notes[ni];
      const zone = Math.min(ZONES - 1, Math.floor((ni * ZONES) / notes.length));
      const voices = [];
      for (const st of n.strings) {
        const coeffs = compileString(fs, st.phys ?? n.phys, {
          ...st,
          couplingFraction: (this.unisonCoupling + this.bridgeCoupling) * st.coupling,
          transientFc: this.transientFc ?? st.transientFc,
          couplingFc: this.couplingFc ?? st.couplingFc,
          maxAllpass: this.quality,
        });
        const s = new WaveguideString(fs, Math.ceil(coeffs.delay) + 8);
        s.setCoefficients(coeffs);
        s.coeffs = coeffs;
        s.note = n;
        s.tuning = st;
        s.noteIndex = ni;
        s.zone = zone;
        s.wUnison = 1 / n.count;
        const total = coeffs.kappa;
        const split = this.unisonCoupling / (this.unisonCoupling + this.bridgeCoupling || 1);
        s.diffLeak = this.diffLeak;
        // Per note, because which way the stage points depends on the
        // string: a wound bass string should have no top at contact and grow
        // one; a plain treble string should keep the top it was given. The
        // instrument-level options still override, for the fitting tools.
        s.nlDepth = this.transientDepth ?? n.transientDepth;
        // The build runs over this long and then is done; with a smootherstep
        // release most of it happens in the middle, so the figure is roughly
        // three times the old exponential time constant for the same feel.
        s.nlPhaseInc = 1 / Math.max((this.transientTauS ?? n.transientTauS) * fs, 1);
        s.nlSkew = Math.max(1, Math.round(this.transientSkew ?? n.transientSkew ?? 1));
        s.swellInc = 1 / Math.max((this.swellS ?? n.swellS ?? 0.020) * fs, 1);
        s.swellFloor = this.swellFloor ?? n.swellFloor ?? 0.50;
        s.swellSkew = Math.max(1, this.swellSkew ?? n.swellSkew ?? 1.4);
        s.nlRiseA = 1 - Math.exp(-1 / (Math.max(this.transientRiseS ?? n.transientRiseS, 1e-5) * fs));
        s.nlSustain = this.transientSustain;
        // Each string wanders independently -- a shared sequence would move all
        // three together, which is a common mode and produces no beating at all.
        s.driftSeed = (this.strings.length * 2654435761 + 40503) & 0x7fffffff;
        s.kUnison = total * split;
        // The three strings of a unison do not sit on one point of the bridge,
        // so the bridge does not drive them equally. That matters more than it
        // sounds: an identical drive excites only the common mode, which is the
        // heavily damped one, and a sympathetic ring would die as fast as a
        // struck note's prompt. An uneven drive also reaches the differential
        // modes, and those are what ring on long enough to be heard as a halo.
        s.kBridge = total * (1 - split) * this.bridgeWeight(st.shape ?? 0);
        s.damperTarget = n.hasDamper ? 1 : 0;
        s.damperClosed = n.hasDamper ? 1 : 0;
        voices.push(s);
        this.strings.push(s);
        zoneCount[zone] += 1;
      }
      this.notes.push({ ...n, voices, zone, held: false });
    }

    // Unison entrainment (Weinreich). Three strings joined at a bridge do not
    // simply beat forever at whatever interval they were tuned to: the bridge
    // pulls them toward a COMMON frequency, and once the coupling outweighs the
    // detuning they lock to it. What you hear is the detuning present at the
    // strike, fading over a second or two into one coherent tone.
    //
    // A waveguide cannot do this on its own. Each string's pitch is set by the
    // length of its own delay line, and a junction that only exchanges energy
    // damps the common mode without moving anybody's frequency. So the pull is
    // explicit: each string's delay is drawn toward the unison mean, by
    // unisonLock, over lockTimeS. At 0 they beat forever, as before.
    // Pull the PITCH together, which is not the same as pulling the delay lines
    // together: each string's dispersion chain contributes its own share of the
    // loop, so equal delay lines would mean unequal pitches. Work in loop
    // periods, and convert the wanted change back into a delay-line scaling.
    for (const note of this.notes) {
      this.setLockTargets(note);
      for (const v of note.voices) v.lock = 1;
    }

    // Each string's share of its zone's motion.
    //
    // A strict average (1/N) is unconditionally passive but it is not physics:
    // how hard one string pushes the bridge does not depend on how many other
    // strings happen to exist, and dividing by N makes the sympathetic halo
    // ~50 dB too quiet to hear. Strings ring at unrelated frequencies and
    // phases, so their contributions add incoherently; 1/sqrt(N) is the
    // matching normalisation and it is what real instruments behave like.
    // Worst-case coherent alignment is then bounded by the output softclip
    // rather than by construction, which the stability tests cover.
    // A string reaches the soundboard exactly as hard as it couples to the
    // bridge, so radiation uses the same uneven weights the drive does. With
    // equal weights the differential mode cancels EXACTLY in this sum, which is
    // self-consistent (that is why it is the lossless one) but leaves the whole
    // aftersound inaudible -- it rings for half a minute and never reaches the
    // output. The spread is zero-mean, so overall level is unchanged.
    for (const s of this.strings) {
      s.wZone = (1 / Math.sqrt(zoneCount[s.zone])) * this.bridgeWeight(s.tuning.shape ?? 0);
    }

    this.noteJunction = new Float64Array(notes.length);
    this.noteAcc = new Float64Array(notes.length);
    this.zoneAcc = new Float64Array(ZONES);
    this.zoneVel = new Float64Array(ZONES);
    this.zoneDrive = new Float64Array(ZONES);
    this.refreshActive();
  }

  /**
   * How hard string `shape` of a unison is tied to the bridge, relative to the
   * centre one. Geometric rather than linear so that no string is ever fully
   * decoupled, which a linear spread of 1.0 would do.
   */
  bridgeWeight(shape) {
    return Math.pow(1 + this.bridgeSpread, shape) / this.bridgeNorm;
  }

  /** Only strings that can move are ticked: struck, ringing, or damper-up. */
  refreshActive() {
    this.active = this.strings.filter(
      (s) => s.active || s.damperClosed < 0.999 || s.damperTarget < 0.5
    );
    const seen = new Set();
    for (const s of this.active) seen.add(s.noteIndex);
    this.activeNotes = [...seen];
  }

  noteOn(midi, velocity) {
    const note = this.notes[midi - 21];
    if (!note) return;
    note.held = true;
    for (const s of note.voices) {
      s.setDamper(false);
      // Una corda shifts the action so the hammer misses the outer string, which
      // then rings only sympathetically -- the real soft-pedal timbre, not a
      // volume cut.
      if (this.unaCorda && s.tuning.index === 0 && note.voices.length === 3) continue;
      // Every hammer quantity is per string, because one hammer face meeting
      // three strings that are not quite level with it is not three identical
      // impacts: it reaches them a fraction of a millisecond apart and leans
      // on them with slightly different force.
      const st = s.tuning;
      const speed = 2 * (st.spec?.lengthM ?? note.spec.lengthM) * s.coeffs.f0;
      const pulse = makeHammerPulse(this.fs, s.coeffs.f0, velocity * (st.hammerForceScale ?? 1), {
        Z: note.Z,
        strings: note.count,
        mass: note.hammerMass * (st.hammerMassScale ?? 1),
        K: note.feltK * this.feltKScale,
        p: this.feltP ?? note.feltP,
        feltEps: this.feltEps ?? note.feltEps,
        feltTauUs: this.feltTauUs,
        widthSamples: this.hammerWidth * (note.hammerWidthM ?? 0) * this.fs / Math.max(speed, 1),
        strikeDelay: s.coeffs.strikeDelay,
        gain: note.gain * (st.drive ?? 1),
      });
      // A fresh strike re-arms the detuning; the pull starts over from it.
      s.lock = 1;
      const skew = Math.round(this.fs * s.tuning.contactOffsetUs * this.strikeOffsetScale * 1e-6);
      if (skew > 0) {
        const padded = new Float64Array(pulse.length + skew);
        padded.set(pulse, skew);
        s.excite(padded, velocity);
      } else s.excite(pulse, velocity);
    }
    this.refreshActive();
  }

  noteOff(midi) {
    const note = this.notes[midi - 21];
    if (!note) return;
    note.held = false;
    if (!this.sustain && note.hasDamper) for (const s of note.voices) s.setDamper(true);
  }

  setSustain(on) {
    this.sustain = on;
    for (const note of this.notes) {
      if (!note.hasDamper) continue;
      for (const s of note.voices) s.setDamper(on ? false : !note.held);
    }
    this.refreshActive();
  }

  setUnaCorda(on) { this.unaCorda = on; }

  /** Rebuild the body after a case dimension changes. */
  rebuildBody(opts = {}) {
    const prev = this.body;
    this.body = new Body(this.fs, {
      curve: prev.curve, enabled: prev.enabled,
      cavityMix: prev.cavityMix, lidGain: prev.lidGain, ...opts,
    });
  }

  /** Recompile one string after a parameter edit, preserving its ringing state. */
  recompileString(s, tuning = s.tuning) {
    Object.assign(s.tuning, tuning);
    const frac = (this.unisonCoupling + this.bridgeCoupling) * (s.tuning.coupling ?? 1);
    // Per-string geometry, as build() uses: a recompile must not silently drop
    // back to the note's nominal physics and lose this string's own length,
    // gauge and inharmonicity.
    const c = compileString(this.fs, s.tuning.phys ?? s.note.phys, {
      ...s.tuning, couplingFraction: frac, maxAllpass: this.quality,
    });
    s.coeffs = c;
    const split = this.unisonCoupling / (this.unisonCoupling + this.bridgeCoupling || 1);
    s.kUnison = c.kappa * split;
    s.kBridge = c.kappa * (1 - split) * this.bridgeWeight(s.tuning.shape ?? 0);
    s.setCoefficients(c);
    // Entrainment aims at the unison's mean pitch, so retuning any string moves
    // the target for all of them. Leaving it stale makes the lock pull toward
    // the pitches the note used to have -- which, on a unison just set to zero
    // detune, means pulling it APART.
    this.setLockTargets(this.notes[s.noteIndex]);
  }

  /** Point every string of a note at the unison's mean loop period. */
  setLockTargets(note) {
    let mean = 0;
    for (const v of note.voices) mean += this.fs / v.coeffs.f0;
    mean /= note.voices.length;
    for (const v of note.voices) {
      v.lockTarget = 1 + (this.unisonLock * (mean - this.fs / v.coeffs.f0)) / v.coeffs.delay;
    }
  }

  /**
   * Advance each ringing string's tension drift, once per block.
   *
   * A real string is not a rigid mathematical object. Its tension wanders by a
   * few parts per million -- the bridge it is anchored to is moving, the case
   * breathes, the air moves -- so its partials wander with it. Measured on a
   * real C3, every partial's envelope modulates at roughly the same 0.2-0.3 Hz
   * no matter which partial it is, and broadly rather than as a spike. Detuning
   * alone cannot do that: it makes partial n beat at n times the rate of
   * partial 1, which climbs into the range the ear hears as phasing. A common
   * slow wander over the whole string modulates every partial at one rate, and
   * because it is noise rather than a tone it stays broad.
   *
   * Lowpassed white noise, updated per block: 0.25 Hz needs nothing faster.
   */
  drift(blockRate) {
    const a = Math.exp((-2 * Math.PI * this.driftHz) / blockRate);
    // A one-pole on unit-variance white noise has variance (1-a)/(1+a).
    const scale = this.tensionDrift / Math.sqrt((1 - a) / (1 + a));
    // Entrainment: how far each string has been pulled toward the unison's
    // common pitch by now. Rises from 0 at the strike with lockTimeS.
    const lockA = Math.exp(-1 / (Math.max(this.lockTimeS, 1e-3) * blockRate));
    for (let k = 0; k < this.active.length; k++) {
      const s = this.active[k];
      s.driftSeed = (s.driftSeed * 1103515245 + 12345) & 0x7fffffff;
      const white = s.driftSeed / 0x3fffffff - 1;
      s.drift = a * s.drift + (1 - a) * white * scale;
      s.lock = s.lockTarget + (s.lock - s.lockTarget) * lockA;
      s.setDelayScale(s.lock * (1 + s.drift));
    }
  }

  render(out, n) {
    if (this.tensionDrift > 0 || this.unisonLock > 0) this.drift(this.fs / Math.max(n, 1));
    const active = this.active, activeNotes = this.activeNotes;
    const nj = this.noteJunction, acc = this.noteAcc;
    const zAcc = this.zoneAcc, zVel = this.zoneVel, zDrive = this.zoneDrive;
    const kernel = this.kernel, zones = this.zones, gain = this.masterGain;

    for (let i = 0; i < n; i++) {
      for (let k = 0; k < activeNotes.length; k++) acc[activeNotes[k]] = 0;
      zAcc.fill(0);

      for (let k = 0; k < active.length; k++) {
        const s = active[k];
        const o = s.tick(nj[s.noteIndex], zDrive[s.zone]);
        acc[s.noteIndex] += o * s.wUnison;
        // Only what leaves for the board is swelled. The unison junction sees
        // the string's real motion, because the strings do not stop hearing
        // each other while the board is getting going.
        zAcc[s.zone] += o * s.wZone * s.radiation();
      }
      for (let k = 0; k < activeNotes.length; k++) {
        const idx = activeNotes[k];
        nj[idx] = acc[idx];
      }

      let mix = 0;
      for (let z = 0; z < ZONES; z++) { zVel[z] = zones[z].process(zAcc[z]); mix += zVel[z]; }
      for (let z = 0; z < ZONES; z++) {
        const row = kernel[z];
        let d = 0;
        for (let w = 0; w < ZONES; w++) d += row[w] * zVel[w];
        zDrive[z] = d;
      }
      out[i] = softclip(this.body.process(mix) * gain);
    }
    this.refreshActive();
  }

  panic() {
    for (const s of this.strings) { s.reset(); s.active = false; s.setDamper(s.note.hasDamper); s.damperClosed = s.note.hasDamper ? 1 : 0; }
    this.zones.forEach((z) => z.reset());
    this.body.reset();
    this.noteJunction.fill(0); this.zoneVel.fill(0); this.zoneDrive.fill(0);
    this.notes.forEach((n) => (n.held = false));
    this.refreshActive();
  }
}
