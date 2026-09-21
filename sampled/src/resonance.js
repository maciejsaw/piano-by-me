// Sympathetic resonance.
//
// When a hammer hits a string, every other string whose damper is off gets
// driven through the bridge, and rings at whatever partials it shares with the
// one that was struck. It is why a piano with the pedal down sounds like a
// different instrument from one with the pedal up, and why holding a chord
// silently and then playing into it produces a halo that no reverb reproduces.
//
// The physically modelled half of this repo gets this for free: its strings
// are real waveguides on a shared bridge, so the coupling is in the structure.
// A sampler has no strings, so it has to be built, and the honest way to build
// it from a sample library is to play the library's own softest recordings --
// the quietest layer of the resonating note, started past the hammer knock so
// what you hear is string and not a strike.
//
// Three things make it behave like the real thing rather than like a reverb:
//
//   WHICH strings answer is decided by partial coincidence, with each string's
//     real inharmonicity and its real bandwidth. A fifth answers strongly, a
//     tritone barely, and the answer for any pair is a number computed once.
//   HOW MUCH is an energy accumulator per string, not a trigger. Every strike
//     adds to it, scaled by the square of velocity -- hit harder, get more --
//     and it leaks away at that string's own measured decay rate.
//   PILE-UP falls out of the accumulator for free. With the pedal down nothing
//     is being damped, so a second chord adds to what the first left behind
//     and the halo grows. Lift the pedal and every accumulator is cut at the
//     speed of its damper.
//
// The one trick that makes it sound right rather than merely correct: the
// resonating sample's OWN decay is divided back out of its gain, from the
// decay curve measured at build time. Without that the voice would die at
// twice the proper rate -- once because the string is decaying, and once again
// because the recording of it is. With it, the accumulator alone decides the
// level, and the recording only supplies the timbre.

const SEMI = Math.pow(2, 1 / 12);

/** Inharmonicity across the compass: 1.2e-4 at A0 to 2.5e-2 at C8, log-linear. */
const bOf = (midi) => Math.pow(10, -3.92 + (midi - 21) * (-1.60 + 3.92) / 87);

const partial = (f0, B, n) => f0 * n * Math.sqrt(1 + B * n * n);

/**
 * Coupling weight for every ordered pair of keys.
 *
 * For each partial of the struck note, find the resonator's nearest partial
 * and score the overlap with a Lorentzian in Hz -- which is the shape a driven
 * resonator actually has, and whose width is the string's own half-power
 * bandwidth, alpha/pi, straight out of the decay rate measured at build time.
 * A Gaussian in cents is the usual shortcut and gets the bass wrong, because
 * bandwidth is a property of frequency and cents are not.
 *
 * `selectivity` scales that bandwidth. At 1 it is physical and almost nothing
 * resonates unless it is in tune to a cent; the default opens it up, which is
 * what every instrument that does this has to do -- a real bridge couples
 * strings through a soundboard with its own broad modes, and this stands in
 * for that.
 */
export function couplingMatrix(hz, { partials = 16, selectivity = 8, lo = 21, hi = 108 } = {}) {
  const n = hi - lo + 1;
  const W = new Float32Array(n * n);
  const f0 = new Float64Array(n), B = new Float64Array(n), bw = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const m = lo + i;
    f0[i] = hz(m);
    B[i] = bOf(m);
    // Half-power bandwidth from the decay rate, widened by `selectivity`.
    bw[i] = Math.max(0.05, hz.rate?.(m) ?? 3) / (20 / Math.LN10) / Math.PI * selectivity;
  }
  for (let si = 0; si < n; si++) {
    for (let ri = 0; ri < n; ri++) {
      if (si === ri) continue;
      let w = 0;
      for (let m = 1; m <= partials; m++) {
        const f = partial(f0[si], B[si], m);
        if (f > 12000) break;
        const a = 1 / m;                                 // the struck string's spectrum
        const near = Math.round(f / f0[ri]);
        for (let k = near - 1; k <= near + 1; k++) {
          if (k < 1 || k > partials) continue;
          const g = partial(f0[ri], B[ri], k);
          const d = Math.abs(f - g);
          // Higher partials of the resonator are more heavily damped, so they
          // answer over a wider band and contribute less.
          const width = bw[ri] * Math.pow(k, 0.8);
          if (d > width * 12) continue;
          const r = 2 * d / width;
          w += a * Math.pow(k, -1.2) / Math.sqrt(1 + r * r);
        }
      }
      W[si * n + ri] = w;
    }
  }
  let max = 0;
  for (let i = 0; i < W.length; i++) if (W[i] > max) max = W[i];
  if (max > 0) for (let i = 0; i < W.length; i++) W[i] /= max;
  return { W, n, lo };
}

// How far the decay compensation is allowed to go. Past this it is amplifying
// the room's noise floor rather than the string -- and every decibel of it
// also brings the moment the voice has to be restarted closer, which is the
// other half of what made this sound granular.
const LIMIT_DB = 6;

export class Resonance {
  /**
   * @param strip  (midi) => the per-key channel strip to play into, so a
   *               sympathetic voice inherits that key's pan and width
   */
  constructor(ctx, lib, curves, strip, envelopes = null, sbSend = null) {
    this.ctx = ctx; this.lib = lib; this.curves = curves; this.strip = strip; this.env = envelopes;
    this.sbSend = sbSend;       // the soundboard reverb: rings on after dampers land
    this.lo = lib.m.keys.lo; this.hi = lib.m.keys.hi;
    this.n = this.hi - this.lo + 1;
    this.E = new Float64Array(this.n);
    this.tau = new Float64Array(this.n);
    this.voices = new Map();
    // Strings whose resonating recording has played all the way through. They
    // are NOT re-opened while they still have energy leaking away -- that would
    // replay the sample's onset as a fresh strike. A new hammer landing on the
    // string (excite) clears the mark and is allowed to open a fresh voice.
    this.spent = new Set();
    this.undamped = new Set();
    // Calibrated, not chosen. At 0.15 the halo over a pedalled passage sits
    // about 16 dB under the notes driving it, which is a bloom you can hear
    // without it becoming the music; the physically modelled variant in this
    // repo measures its own pedal halo at -27 dB below a single strike peak.
    // It was 0.5 with the recording's level left out entirely, which put the
    // halo 15 dB ABOVE the piano -- two dozen peak-normalised pianissimo
    // samples restarting under everything, which is what a grain cloud is.
    this.amount = 0.15;         // master send
    this.drive = 2.2;           // velocity exponent: how much harder hitting builds
    // How far the accumulator is allowed to open one voice, BEFORE the
    // recording's own level is put back. Without a ceiling a long pedalled
    // passage keeps adding to E and a single sympathetic string ends up
    // louder than the note that drove it.
    this.ceiling = 1.2;         // a safety limit, not a working level
    this.maxVoices = 16;
    this.threshold = 0.0012;
    this.tone = 5200;           // the bridge is not a wire: the halo is not bright
    this.enabled = true;
    this.compensate = true;     // divide the recording's own decay back out
    // The end of the recording, in seconds, spent fading out. Without it a
    // voice ends when its buffer runs out -- a click, and on a short sample a
    // halo that stops dead. This last stretch fades exponentially to nothing,
    // landing on the buffer's end, so what is left is a decay tail that
    // dissolves into the room instead of a cut. On a sample shorter than this
    // it is capped to most of the sample, so a short recording just decays.
    this.tailRelease = 0.6;
    // When the pedal lifts, a whole frame of dampers lands. It happens in two
    // stages rather than one fade: the level DROPS quickly to `pedalOffDrop` of
    // where it was -- the dampers touching the strings -- and then falls the
    // rest of the way slowly over `pedalOffFall`, the string ringing on under a
    // resting damper while the soundboard (the long reverb) carries the body.
    // Each damper is also given a small random delay, so the frame lands as a
    // scatter rather than as one click.
    this.pedalOffJitter = 0.06;   // seconds of random stagger across the frame
    this.pedalOffDrop = 0.4;      // level the quick duck drops to (fraction)
    this.pedalOffFall = 2.0;      // seconds for the slow release after the drop
    // Soundboard bleed with the pedal UP. A damper does not fully still its
    // string, and every string couples through the soundboard whether its damper
    // is down or not -- so a real grand has a faint pitched halo and body ring
    // even with no pedal. `dampedAmount` is the fraction of the normal coupling
    // a DAMPED string still receives; those strings ring only briefly, leaking
    // at `dampedDecay` rather than their open decay, because the damper is on
    // them. At 0 the engine behaves exactly as before (only free strings answer).
    this.dampedAmount = 0;
    this.dampedDecay = 0.4;       // e-folding time of a damped string's bleed, s
    this.build();
  }

  build(selectivity = 8) {
    const hzOf = (m) => this.lib.note(m)?.hz ?? 440 * Math.pow(2, (m - 69) / 12);
    const fn = (m) => hzOf(m);
    fn.rate = (m) => this.lib.note(m)?.layers?.[1]?.edr ?? 3;
    this.mat = couplingMatrix(fn, { selectivity, lo: this.lo, hi: this.hi });
    for (let i = 0; i < this.n; i++) {
      const edr = this.lib.note(this.lo + i)?.layers?.[1]?.edr ?? 3;
      // dB/s -> the e-folding time the accumulator leaks with
      this.tau[i] = Math.max(0.15, 8.686 / edr);
    }
    this.selectivity = selectivity;
  }

  setUndamped(set) {
    const prev = this.undamped;
    this.undamped = set;
    for (let i = 0; i < this.n; i++) {
      const m = this.lo + i;
      // Only a damper LANDING cuts a string: it was free, now it is not. A
      // string that was already damped is left alone -- otherwise the pedal-up
      // soundboard bleed would be zeroed on every key change instead of leaking
      // away at dampedDecay.
      if (prev.has(m) && !set.has(m) && this.E[i] > 0) { this.E[i] = 0; this.stop(m, true); }
    }
  }

  /** A hammer landed on `midi`. Feed every string that is free to answer. */
  excite(midi, vel, pedal = 0) {
    if (!this.enabled) return;
    const si = midi - this.lo;
    if (si < 0 || si >= this.n) return;
    // Velocity squared and a bit: the energy a hammer delivers goes as v^2,
    // and what reaches the bridge is a little more sharply graded than that.
    const e = Math.pow(vel / 127, this.drive);
    const W = this.mat.W, n = this.n;
    const bleed = this.dampedAmount;
    // Every coupled string, not only the free ones: a free string takes the full
    // drive, a damped one takes `bleed` of it (the soundboard halo with the pedal
    // up). When bleed is 0 the damped branch adds nothing, so this is exactly the
    // old "only undamped strings answer".
    for (let ri = 0; ri < n; ri++) {
      const r = this.lo + ri;
      if (r === midi) continue;
      const w = W[si * n + ri];
      if (w < 1e-4) continue;
      const open = this.undamped.has(r);
      if (!open && bleed <= 0) continue;
      // The pedal does not make a string resonate harder -- it makes more
      // strings free to. What it does add is the body of the whole undamped
      // frame moving together, which is a real and audible extra few dB.
      const factor = open ? (1 + 0.35 * pedal) : bleed;
      this.E[ri] += w * e * this.curves.at('resonance', r) * factor;
      // A fresh strike drives the string again, so a voice that had run its
      // recording out is allowed to speak once more.
      this.spent.delete(r);
    }
  }

  /** Control rate. Leak, re-rank, and move the voices' gains. */
  tick(dt) {
    if (!this.enabled) { if (this.voices.size) this.allOff(); return; }
    const bleedOn = this.dampedAmount > 0;
    const want = [];
    for (let i = 0; i < this.n; i++) {
      if (this.E[i] <= 0) continue;
      const m = this.lo + i;
      const open = this.undamped.has(m);
      // A damped string bleeds only briefly -- the damper is resting on it -- so
      // it leaks at dampedDecay, not at its open (measured) decay rate.
      this.E[i] *= Math.exp(-dt / (open ? this.tau[i] : this.dampedDecay));
      if (this.E[i] < this.threshold * 0.4) { this.E[i] = 0; this.spent.delete(m); this.stop(m); continue; }
      // Free strings always compete for a voice; damped ones only when the
      // soundboard bleed is switched on. They rank below the free strings by
      // energy, so real resonance keeps priority and bleed fills spare voices.
      if (this.E[i] > this.threshold && (open || bleedOn)) want.push(i);
    }
    want.sort((a, b) => this.E[b] - this.E[a]);
    const keep = new Set(want.slice(0, this.maxVoices).map((i) => this.lo + i));
    for (const midi of this.voices.keys()) if (!keep.has(midi)) this.stop(midi);
    for (const midi of keep) {
      let v = this.voices.get(midi);
      if (!v) {
        // Its recording already ran out. Leave it ringing silently until a
        // fresh strike (excite) drives it again -- do not replay the sample.
        if (this.spent.has(midi)) continue;
        v = this.start(midi);
      }
      if (!v) continue;
      // times v.unit, the gain that restores this recording's true level.
      // Leaving that out -- which this did -- plays a peak-normalised
      // pianissimo sample as though it were fortissimo, about 20 dB too loud,
      // on every one of these voices at once. The result was a grain cloud
      // 13 dB above the piano it was supposed to be a halo around.
      const g = Math.min(this.amount * Math.sqrt(this.E[midi - this.lo]), this.ceiling) * v.unit;
      v.lvl.gain.setTargetAtTime(g, this.ctx.currentTime, 0.045);
      v.target = g;                         // remembered, so a damper fall starts from it
    }
  }

  /**
   * The gain curve that takes the recording's own decay back out.
   *
   * Clamped at +12 dB, because past that the compensation is amplifying the
   * room's noise floor rather than the string. Made non-increasing first: a
   * real decay curve wobbles where the unisons beat, and following the wobble
   * upwards would put the beat back in at the wrong depth.
   */
  compCurve(midi, offset, dur) {
    const d = this.lib.note(midi)?.decay;
    const N = 128;
    const out = new Float32Array(N);
    if (!d || !this.compensate) { out.fill(1); return out; }
    const dbAt = (t) => {
      const { t: ts, db } = d;
      if (t <= ts[0]) return db[0];
      for (let i = 0; i < ts.length - 1; i++) {
        if (t <= ts[i + 1]) {
          const u = (t - ts[i]) / (ts[i + 1] - ts[i]);
          return db[i] + (db[i + 1] - db[i]) * u;
        }
      }
      return db[db.length - 1];
    };
    const base = dbAt(offset);
    let floor = 0;
    for (let i = 0; i < N; i++) {
      const t = offset + dur * i / (N - 1);
      const drop = base - dbAt(t);
      floor = Math.max(floor, drop);                 // non-increasing decay
      out[i] = Math.pow(10, Math.min(LIMIT_DB, Math.max(0, floor)) / 20);
    }
    return out;
  }

  start(midi) {
    const got = this.lib.best(midi, this.lib.layers[0]);
    if (!got) return null;
    const ctx = this.ctx, now = ctx.currentTime;
    // Start past the knock. What is wanted is the string ringing, not the
    // sound of a hammer that never happened.
    const offset = Math.min(0.03, got.buf.duration * 0.1);
    // The TRUE remaining length of the recording, so the release tail lands
    // exactly on the buffer's end rather than after it (which would be a click).
    const dur = Math.max(0.05, got.buf.duration - offset);

    const src = ctx.createBufferSource();
    src.buffer = got.buf;
    src.playbackRate.value = Math.pow(2, this.curves.at('tune', midi) / 1200);

    const comp = ctx.createGain();
    comp.gain.setValueCurveAtTime(this.compCurve(midi, offset, dur), now, dur);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = this.tone; lp.Q.value = 0.5;

    const lvl = ctx.createGain();
    lvl.gain.value = 0;

    // The release tail. `lvl` is driven by the accumulator (tick); `rel` is
    // untouched by it and only fades the last `tailRelease` seconds of the
    // recording out to silence, so the buffer never simply stops. On a sample
    // shorter than tailRelease the fade covers most of it and the voice is
    // just a short decay.
    const rel = ctx.createGain();
    rel.gain.value = 1;
    const relT = Math.min(this.tailRelease, dur * 0.8);
    if (relT > 0.02) {
      const fadeAt = now + dur - relT;
      rel.gain.setValueAtTime(1, fadeAt);
      // A time constant of relT/4 is ~98% faded by the buffer's end.
      rel.gain.setTargetAtTime(1e-4, fadeAt, relT / 4);
    }

    src.connect(comp).connect(lp).connect(lvl).connect(rel);
    rel.connect(this.strip(midi));
    // Feed the soundboard in parallel, so the body goes on ringing after the
    // string itself has been damped.
    if (this.sbSend) rel.connect(this.sbSend);
    src.start(now, offset);
    const v = { src, comp, lp, lvl, rel, target: 0, unit: got.entry.gain, until: now + dur };
    src.onended = () => {
      // The recording runs out. Do NOT start another: re-triggering the sample
      // from the top plays its (undecayed) onset again, which is heard as the
      // halo audibly re-striking rather than dying away. Sympathetic resonance
      // only ever fades -- so the voice is simply let go here, and its natural
      // decay (the compensation is capped at +6 dB, so it cannot flatten the
      // recording's tail all the way) is the fade. If the accumulator is still
      // ringing when the recording ends, it rings on silently and the next
      // strike into this string will open a fresh voice for it.
      if (this.voices.get(midi) === v) { this.voices.delete(midi); this.spent.add(midi); }
    };
    this.voices.set(midi, v);
    return v;
  }

  stop(midi, damped = false) {
    const v = this.voices.get(midi);
    if (!v) return;
    this.voices.delete(midi);
    const now = this.ctx.currentTime;
    const shape = this.env?.noteRelease.shape;
    v.src.onended = null;
    // Freeze the gain at the value it ACTUALLY has right now, not at v.target.
    // tick() drives lvl with setTargetAtTime -- an exponential still on its way
    // to target and, by design, never quite there -- so starting the fade from
    // target steps the gain, which is a click, panned to wherever this key sits
    // on the soundboard. cancelAndHold holds the running curve exactly where it
    // is; `from` is then read back from the param rather than assumed.
    // Schedule the fade, but NEVER let a scheduling error skip the src.stop()
    // below: an unstopped source is removed from this.voices with onended
    // nulled, so nothing ever cleans it up -- it plays its multi-second buffer
    // to the end with that buffer pinned in native memory. A frame of those
    // orphaned at a pedal-off is what ran the tab out of memory.
    let stopAt = now + 0.35;
    try {
      if (v.lvl.gain.cancelAndHoldAtTime) v.lvl.gain.cancelAndHoldAtTime(now);
      else { v.lvl.gain.cancelScheduledValues(now); v.lvl.gain.setValueAtTime(Math.max(1e-5, v.target), now); }
      const from = Math.max(1e-5, v.lvl.gain.value);

      if (damped) {
        // Two stages, scattered slightly in time so the frame does not land as one
        // click. First a quick duck to a fraction of the level -- the damper
        // touching -- then a slow fall the rest of the way, the string ringing on
        // under the damper while the soundboard reverb carries the body. The held
        // value carries flat across the jitter, so the curve at t0 starts from it.
        const jitter = Math.random() * this.pedalOffJitter;
        const t0 = now + jitter;
        const duck = Math.max(0.02, 0.09 * this.curves.at('damping', midi) * (1 + (88 - Math.min(88, midi)) / 60));
        const drop = Math.max(1e-5, from * Math.min(1, Math.max(0, this.pedalOffDrop)));
        const fall = Math.max(0.05, this.pedalOffFall);
        // A gap between the two curves. setValueCurveAtTime rounds its END up to
        // the next 128-sample render quantum (~2.7 ms at 48 kHz), so a second
        // curve abutting it exactly at t0+duck starts INSIDE the first and throws
        // NotSupportedError. One quantum-plus of gap avoids it; the value holds
        // flat at `drop` across it, so it stays continuous and click-free.
        const GAP = 0.006;
        if (shape) {
          v.lvl.gain.setValueCurveAtTime(shape.curve(from, drop), t0, duck);
          v.lvl.gain.setValueCurveAtTime(shape.curve(drop, 0), t0 + duck + GAP, fall);
        } else {
          v.lvl.gain.linearRampToValueAtTime(drop, t0 + duck);
          v.lvl.gain.linearRampToValueAtTime(0, t0 + duck + GAP + fall);
        }
        stopAt = t0 + duck + GAP + fall + 0.03;
      } else {
        // An undamped-region leak below threshold: just a short fade.
        const fall = 0.25;
        if (shape) v.lvl.gain.setValueCurveAtTime(shape.curve(from, 0), now, fall);
        else v.lvl.gain.linearRampToValueAtTime(0, now + fall);
        stopAt = now + fall + 0.03;
      }
    } catch { /* fall through: the source is still stopped below */ }
    try { v.src.stop(stopAt); } catch { /* already stopped */ }
  }

  allOff() { for (const midi of [...this.voices.keys()]) this.stop(midi, true); this.E.fill(0); this.spent.clear(); }

  /** Move the tone control on voices that are already sounding, not just new ones. */
  setTone(hz) {
    this.tone = hz;
    const now = this.ctx.currentTime;
    for (const v of this.voices.values()) v.lp.frequency.setTargetAtTime(hz, now, 0.02);
  }

  /** Keys whose buffers are in use, so the library does not evict them. */
  heldKeys(out) { for (const midi of this.voices.keys()) out.add(this.lib.key(midi, this.lib.layers[0])); }
}
