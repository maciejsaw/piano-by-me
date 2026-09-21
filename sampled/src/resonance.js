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
//     and it leaks away at that string's own measured AFTERSOUND rate.
//   HOW LONG is not decided at the attack. A struck string goes on pushing the
//     bridge for as long as it rings, so it goes on feeding the accumulator of
//     every string coupled to it, every tick, at its own current amplitude.
//     That is the difference between a halo that lasts as long as the note
//     under it and one that dies a moment after the attack whatever you play.
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
 * The AFTERSOUND decay rate of a note, in dB/s, fitted from its decay curve.
 *
 * `edr` in the manifest is the EARLY decay rate -- a least squares fit over
 * the first 20 dB (tools/sampler/lib/analysis.mjs), which on a piano is the
 * prompt sound: the fast first slope of a famously double-sloped decay. Using
 * it as the leak constant of an accumulator that is supposed to hold a halo up
 * is why the halo used to vanish. It reads 63 dB/s at C6 -- a time constant of
 * 0.14 s, so the sympathetic ring of the top two octaves was over before the
 * note driving it had finished speaking.
 *
 * What is wanted is the SECOND slope: the same least squares, run past the
 * knee, over the decay curve the build already stores per note. Nothing has to
 * be re-measured.
 *
 *   from -10 dB   past the prompt sound and into the aftersound
 *   to -40 dB     about as far as a trimmed library sample honestly goes
 *   t < 85% of the recording
 *                 the last points are the build's own fade to silence -- C6
 *                 drops 22 dB between its final two -- and a fit through
 *                 those measures the trim rather than the string
 */
export function aftersoundRate(decay) {
  if (!decay?.t?.length) return null;
  const { t, db } = decay;
  const tEnd = t[t.length - 1] * 0.85;
  let n = 0, st = 0, sd = 0, stt = 0, std = 0, first = Infinity, last = -Infinity;
  for (let i = 0; i < t.length; i++) {
    if (t[i] > tEnd || db[i] > -10 || db[i] < -40) continue;
    n++; st += t[i]; sd += db[i]; stt += t[i] * t[i]; std += t[i] * db[i];
    if (t[i] < first) first = t[i];
    if (t[i] > last) last = t[i];
  }
  // Four points spanning at least half a second, or this is fitting noise.
  if (n < 4 || last - first < 0.5) return null;
  const denom = n * stt - st * st;
  if (Math.abs(denom) < 1e-12) return null;
  const slope = (n * std - st * sd) / denom;
  if (slope >= -0.05) return null;
  return -slope;
}

/**
 * Median, then mean, across the compass, in the log domain.
 *
 * A rate fitted from one recording of one note is noisy: the manifest has C3
 * at 14.7 dB/s and C4 at 1.9, a factor of eight between two octaves of the
 * same instrument, which is measurement and not piano. Real decay rates vary
 * smoothly with string length, so the scatter can simply be taken out -- the
 * median kills the outliers, the mean takes the steps out of what is left, and
 * both run on log(rate), which is the scale decay rates live on.
 */
function smoothAcross(a, radius = 3) {
  const n = a.length;
  const log = new Float64Array(n), med = new Float64Array(n), out = new Float64Array(n);
  for (let i = 0; i < n; i++) log[i] = Math.log(a[i]);
  const win = [];
  for (let i = 0; i < n; i++) {
    win.length = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(n - 1, i + radius); j++) win.push(log[j]);
    win.sort((x, y) => x - y);
    med[i] = win[win.length >> 1];
  }
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(n - 1, i + radius); j++) { s += med[j]; c++; }
    out[i] = Math.exp(s / c);
  }
  return out;
}

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

// How far the per-key level curve reaches down. At the floor a string does not
// answer at all: its energy never clears the voice threshold, so it costs
// nothing and makes no sound.
export const RES_FLOOR = -48;
export const RES_CEIL = 12;

/**
 * A hand-drawn key -> level curve for the sympathetic resonance, in dB.
 *
 * The one thing a single "amount" knob cannot do is balance the resonance
 * ACROSS the keyboard, and the place that shows is the top of the instrument:
 * the highest strings have no dampers at all, so they are free to answer
 * whatever you play, forever, whether the pedal is down or not. On a real
 * grand they are also small, quiet and far from the bridge's centre; here they
 * are recordings played at the same send as everything else, and they ring on
 * over a passage that should have stopped. This is where you take them down.
 *
 * Same shape as the velocity curves: a list of points the user places, pinned
 * at the two ends and linearly interpolated between. Flat 0 dB by default, so
 * it changes nothing until it is drawn.
 *
 * The value is applied to the ENERGY the accumulator receives, squared, which
 * is what makes it a level in dB on the resulting voice -- the voice's gain
 * goes as the square root of energy. Doing it there rather than at the voice
 * also shortens what it quietens: a string fed less energy falls under the
 * voice threshold sooner, so the too-long ring goes with the too-loud one.
 */
export class ResCurve {
  constructor(lo = 21, hi = 108) {
    this.lo = lo; this.hi = hi;
    this.points = [{ k: lo, db: 0 }, { k: hi, db: 0 }];
  }

  /** Level in dB for a key. */
  at(midi) {
    const p = this.points;
    const k = Math.max(this.lo, Math.min(this.hi, midi));
    if (k <= p[0].k) return p[0].db;
    for (let i = 0; i < p.length - 1; i++) {
      if (k <= p[i + 1].k) {
        const u = (k - p[i].k) / Math.max(1e-6, p[i + 1].k - p[i].k);
        return p[i].db + (p[i + 1].db - p[i].db) * u;
      }
    }
    return p[p.length - 1].db;
  }

  /** The factor on ACCUMULATED ENERGY -- amplitude squared. Floor means off. */
  energy(midi) {
    const db = this.at(midi);
    return db <= RES_FLOOR ? 0 : Math.pow(10, db / 10);
  }

  /** True while the curve is flat at 0 dB, i.e. doing nothing. */
  get idle() { return this.points.every((p) => p.db === 0); }

  reset() { this.points = [{ k: this.lo, db: 0 }, { k: this.hi, db: 0 }]; }

  toJSON() { return { points: this.points.map((p) => ({ k: p.k, db: p.db })) }; }
  fromJSON(o) {
    if (!o || !Array.isArray(o.points) || o.points.length < 2) return;
    this.points = o.points
      .map((p) => ({
        k: Math.max(this.lo, Math.min(this.hi, Math.round(p.k))),
        db: Math.max(RES_FLOOR, Math.min(RES_CEIL, p.db)),
      }))
      .sort((a, b) => a.k - b.k);
    this.points[0].k = this.lo;
    this.points[this.points.length - 1].k = this.hi;
  }
}

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
    // The level the notes currently sounding hold each string at. Rebuilt from
    // scratch every tick by sustainFrom; the accumulator is never allowed to
    // leak below it.
    this.T = new Float64Array(this.n);
    this.tau = new Float64Array(this.n);
    this.voices = new Map();
    // Strings whose resonating recording has played all the way through. They
    // are NOT re-opened while they still have energy leaking away -- that would
    // replay the sample's onset as a fresh strike. A new hammer landing on the
    // string (excite) clears the mark and is allowed to open a fresh voice.
    this.spent = new Set();
    // WHEN a string is allowed to start sounding: only just after a hammer has
    // driven it. midi -> the time of the strike that fed it.
    //
    // Re-ranking alone must never open a voice. tick() sorts the strings by
    // energy every tick and keeps the top `maxVoices`, and a string ENTERING
    // that set gets start(), which plays the resonating recording from its
    // onset -- so a string that merely rose through the ranking as louder ones
    // decayed began speaking from the top, seconds into a held chord, with a
    // 45 ms rise. That is heard as a ghost note: a quiet piano note appearing
    // out of nowhere in the middle of a sustained passage. A sympathetic string
    // is only ever heard to start when something drives it, so that is the only
    // time one is allowed to.
    this.fresh = new Map();
    this.startWindow = 0.2;     // seconds a strike stays a licence to speak
    // How much louder a silent string must be than a sounding one to take its
    // voice away. Without it a pair of strings either side of the cut trade the
    // last slot back and forth, which is a stop and a restart every few ticks.
    this.stickiness = 2;
    // How much the keyboard distance between two strings matters. See
    // applyProximity: dB of level per octave of separation, positive favouring
    // near strings, 0 leaving the partial coincidence alone.
    this.proximity = 0;
    // The same preference, applied a second time and for a different reason:
    // when there are more strings ringing than there are voices to play them
    // with, spend the voices near where the music is. See nearness().
    this.near = new Float64Array(this.n).fill(1);
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
    // A string that has been struck does not stop pushing the bridge when the
    // hammer leaves it -- it goes on driving every coupled string for as long
    // as it rings. `excite` is only the strike; this is the drive that follows
    // it, and it is what makes a held note keep a halo around it instead of
    // one that dies on its own schedule a moment after the attack.
    //
    // It is a FLOOR, not another thing added to the accumulator. Adding it was
    // the obvious way round and it does nothing audible: a strike deposits its
    // energy all at once, and by the time the sustained term has trickled in
    // enough to matter the note driving it is 25 dB down and contributing far
    // less than the strike's own residual. Measured on a held pedalled chord
    // it moved the halo by 0.0 dB. As a floor it does the job it is there for
    // -- a string is never allowed to fall below the level the notes currently
    // sounding are holding it at, so the halo stops decaying on its own
    // schedule and decays with the music instead.
    //
    // At 1 a perfectly coupled string is held at the energy a strike of the
    // same velocity would have deposited, so it is a fraction of a strike.
    this.sustain = 1;
    // A multiplier on every string's measured aftersound time constant, for
    // tuning by ear. 1 is what the recordings say.
    this.ring = 1;
    // How far the accumulator is allowed to open one voice, BEFORE the
    // recording's own level is put back. Without a ceiling a long pedalled
    // passage keeps adding to E and a single sympathetic string ends up
    // louder than the note that drove it.
    this.ceiling = 1.2;         // a safety limit, not a working level
    this.maxVoices = 16;
    this.threshold = 0.0012;
    // The level below which a string is FORGOTTEN, as opposed to merely being
    // too quiet to deserve a voice (`threshold`). These were the same number,
    // and while the only source of energy was a strike that was harmless: a
    // string that had leaked away to nothing had nothing left to say. With the
    // sustained drive it is not harmless at all -- the drive holds a weakly
    // coupled string at a low but real level, and zeroing the accumulator the
    // moment it passed under the voice threshold threw that state away every
    // tick, so the drive could never build anything back up. A held bass note
    // with the treble free measured EXACTLY zero halo from four seconds on,
    // driven or not. The accumulator is a Float64Array; keeping a string in it
    // at 1e-6 costs nothing, and it is what lets a halo come back.
    this.floor = 1e-6;
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
    // The struck string answering ITSELF.
    //
    // A note is never one string: two or three in a unison, slightly detuned,
    // plus whatever the duplex scale behind the bridge is free to ring at. The
    // hammer drives one set of them and the rest answer through the bridge, so
    // part of what a real note does after the knock is sympathetic response to
    // its own fundamental -- a bloom that arrives just behind the attack and
    // sustains under it. The sample already contains its own unisons, so this
    // is not physics being restored; it is a send that thickens and lengthens
    // the note by putting the library's softest layer of the SAME key under it,
    // driven by the same accumulator as every other string. Kept separate from
    // the coupling matrix, which has no diagonal, and off by default.
    this.self = 0;                // fraction of a perfectly-coupled string's drive
    this.lookahead = 0;           // seconds; the engine sets its own (see Engine.time)
    // Per-key send level, drawn (see ResCurve). Kept as a table of energy
    // factors, rebuilt when the curve moves, because excite() reads it once
    // per coupled string per note-on.
    this.keyCurve = new ResCurve(this.lo, this.hi);
    this.keyE = new Float64Array(this.n).fill(1);
    this.build();
  }

  build(selectivity = 8) {
    const hzOf = (m) => this.lib.note(m)?.hz ?? 440 * Math.pow(2, (m - 69) / 12);
    const fn = (m) => hzOf(m);
    // The COUPLING bandwidth is left on the early rate. It is the width of the
    // window a string answers through, `selectivity` has been dialled in by
    // ear against it, and moving both at once would be two changes at a time.
    fn.rate = (m) => this.lib.note(m)?.layers?.[1]?.edr ?? 3;
    this.mat = couplingMatrix(fn, { selectivity, lo: this.lo, hi: this.hi });
    this.applyProximity();
    // How long a string goes on ringing once driven. See aftersoundRate: NOT
    // the manifest's edr, which is the early decay and far too fast to hold a
    // halo up at all above the middle of the keyboard.
    const raw = new Float64Array(this.n);
    for (let i = 0; i < this.n; i++) {
      const note = this.lib.note(this.lo + i);
      // A note whose curve will not support a fit: a piano's aftersound runs
      // roughly a third of its early rate, so that is what edr is scaled by.
      const r = aftersoundRate(note?.decay) ?? (note?.layers?.[1]?.edr ?? 9) / 3;
      raw[i] = Math.min(40, Math.max(0.5, r));
    }
    this.rate = smoothAcross(raw);
    this.retune();
    this.selectivity = selectivity;
  }

  /**
   * Redistribute the coupling by distance along the keyboard.
   *
   * Partial coincidence on its own has no sense of "near". A C5 couples to the
   * C2 three octaves below about as readily as to the C4 just under it,
   * because what it is matching is a partial and a partial does not care how
   * far away its string is. A real instrument does care: the bridge and the
   * soundboard are not a rigid link between any two points on the frame, the
   * near end of the bridge moves most, and the strings that answer a note
   * loudest are mostly its neighbours. This is the control for that.
   *
   * `proximity` is a tilt in dB of level per octave of separation. Positive
   * favours near strings, negative favours distant ones, 0 leaves the physics
   * exactly as measured.
   *
   * Each struck key's row is renormalised to the total drive it had before, so
   * the slider only ever moves the coupling AROUND the keyboard and never
   * changes how much of it there is. Without that, "prefer near" would be a
   * volume control in disguise and the two effects would be impossible to tell
   * apart by ear -- which is the whole point of having the slider.
   */
  applyProximity() {
    const src = this.mat.W, n = this.n;
    if (!this.W || this.W.length !== src.length) this.W = new Float32Array(src.length);
    if (!this.proximity) { this.W.set(src); return; }
    // The weights are energies and the slider is a level, so a dB of slider is
    // two dB of weight: 10^(-2L/20 * d/12) = 10^(-L*d/60).
    const k = -this.proximity / 60;
    for (let si = 0; si < n; si++) {
      const row = si * n;
      let before = 0, after = 0;
      for (let ri = 0; ri < n; ri++) {
        const w = src[row + ri];
        if (w <= 0) continue;
        before += w;
        after += w * Math.pow(10, k * Math.abs(si - ri));
      }
      const norm = after > 0 ? before / after : 1;
      for (let ri = 0; ri < n; ri++) {
        this.W[row + ri] = src[row + ri] * Math.pow(10, k * Math.abs(si - ri)) * norm;
      }
    }
  }

  setProximity(db) { this.proximity = db; this.applyProximity(); }

  /**
   * How near each string is to the music currently sounding, as a rank bias.
   *
   * applyProximity decides how much energy a string is GIVEN. This decides
   * which of the strings that have energy are actually heard, and they are not
   * the same question. There are always far more strings ringing than there
   * are voices -- `maxVoices` of them get played and the rest ring silently --
   * and the ranking is by accumulated energy alone. So a string two octaves
   * away that took a large deposit from something played a while ago goes on
   * holding a voice while a string right under the hand, freshly driven but
   * quieter, never gets one. That is the opposite of what an instrument does:
   * what you hear ringing around a note is mostly what is near it.
   *
   * The bias is the distance from each string to the NEAREST note currently
   * sounding, on the same dB-per-octave scale as the slider, so one control
   * governs both halves of the effect. It orders the competition for voices
   * and nothing else -- a string's energy, and whether it is over the
   * threshold at all, are left alone, so this can never silence a string that
   * would otherwise have been loud enough to matter on its own.
   */
  nearness(sounding) {
    const out = this.near;
    if (!this.proximity || !sounding?.length) { out.fill(1); return out; }
    const k = -this.proximity / 60;
    for (let i = 0; i < this.n; i++) {
      const m = this.lo + i;
      let d = Infinity;
      for (const s of sounding) { const x = Math.abs(s.midi - m); if (x < d) d = x; }
      out[i] = Math.pow(10, k * d);
    }
    return out;
  }

  /** dB/s -> the e-folding time the accumulator leaks with, times `ring`. */
  retune() {
    for (let i = 0; i < this.n; i++) {
      this.tau[i] = Math.min(30, Math.max(0.2, 8.686 / this.rate[i])) * this.ring;
    }
  }

  setRing(x) { this.ring = Math.max(0.1, x); this.retune(); }

  /** Re-read the per-key level curve. Call after drawing on it. */
  refreshKeyCurve() {
    for (let i = 0; i < this.n; i++) this.keyE[i] = this.keyCurve.energy(this.lo + i);
    // A string just taken to the floor should not go on ringing from energy it
    // was given before the curve moved.
    for (let i = 0; i < this.n; i++) {
      if (this.keyE[i] === 0 && this.E[i] > 0) { this.E[i] = 0; this.stop(this.lo + i); }
    }
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
    this.add(si, Math.pow(vel / 127, this.drive), pedal);
  }

  /**
   * Put energy into every string coupled to key index `si`.
   *
   * Two callers, and the difference between them is the whole point. A STRIKE
   * (`sustained` false) is an impulse: a lump of energy, delivered once. The
   * SUSTAINED drive is a rate -- the struck string still pushing the bridge,
   * feeding its neighbours continuously for as long as it rings.
   */
  add(si, e, pedal, sustained = false) {
    const midi = this.lo + si;
    const now = sustained ? 0 : this.ctx.currentTime;
    const W = this.W, n = this.n;
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
      const x = w * e * this.curves.at('resonance', r) * factor * this.keyE[ri];
      // A strike is a deposit into the accumulator; a sustained drive is a
      // level the accumulator is held at. Several notes driving the same string
      // hold it higher, so the targets sum.
      if (sustained) { this.T[ri] += this.sustain * x; continue; }
      this.E[ri] += x;
      // A fresh strike drives the string again, so a voice that had run its
      // recording out is allowed to speak once more -- and it is the one moment
      // at which this string may begin sounding at all. The sustained drive
      // does neither: opening a voice under it replays the recording's onset,
      // which is heard as the halo re-striking.
      this.spent.delete(r);
      this.fresh.set(r, now);
    }
    // The struck string itself. Its damper is up (the key is down), so it takes
    // the open drive; a weight of 1, since a string coincides perfectly with
    // its own partials.
    if (this.self > 0) {
      const x = this.self * e * this.curves.at('resonance', midi) * (1 + 0.35 * pedal) * this.keyE[si];
      if (sustained) this.T[si] += this.sustain * x;
      else { this.E[si] += x; this.spent.delete(midi); this.fresh.set(midi, now); }
    }
  }

  /**
   * Every string that is still sounding goes on driving the ones coupled to it.
   *
   * This is the half of sympathetic resonance a sampler is most likely to
   * leave out, because a strike is an event and a drive is not. On a real
   * piano the sympathetic answer to a long held note lasts as long as the note
   * does -- it is being fed the whole time, not ringing on from a kick it got
   * at the attack. Hold a chord under the pedal and the halo builds and stays;
   * that is the accumulator being topped up, note by note, tick by tick.
   *
   * How hard each note drives is its velocity's share of energy times where
   * its own measured decay curve has reached by now, so the halo tracks the
   * notes under it and fades exactly as they do.
   *
   * @param sounding  [{ midi, vel, t }] -- t is seconds since the note started
   */
  sustainFrom(sounding, pedal) {
    this.T.fill(0);
    if (!(this.sustain > 0) || !sounding?.length) return;
    for (const s of sounding) {
      const si = s.midi - this.lo;
      if (si < 0 || si >= this.n) continue;
      const e = Math.pow(s.vel / 127, this.drive) * Math.pow(10, this.driveDb(s.midi, s.t) / 10);
      if (e < 1e-6) continue;
      this.add(si, e, pedal, true);
    }
  }

  /**
   * How hard a note that started `t` seconds ago is still driving the bridge,
   * in dB below its own peak.
   *
   * The measured decay curve, with the two corrections that matter only here.
   * Its last stretch is the BUILD's fade to silence and not the string -- C6
   * drops 22 dB between its final two points -- so the curve is read only as
   * far as the trim; and a string goes on driving past the end of a recording
   * that was cut short, so past the trim it is continued at the aftersound
   * rate fitted for this string. Reading the raw curve instead has a held note
   * stop driving several seconds early, and do it fastest on exactly the notes
   * whose recordings are shortest.
   */
  driveDb(midi, t) {
    const d = this.lib.note(midi)?.decay;
    if (!d?.t?.length) return 0;
    const cut = d.t[d.t.length - 1] * 0.85;
    if (t <= cut) return this.decayDb(midi, t);
    return this.decayDb(midi, cut) - (this.rate?.[midi - this.lo] ?? 6) * (t - cut);
  }

  /** A note's own measured decay, in dB below its peak, `t` seconds in. */
  decayDb(midi, t) {
    const d = this.lib.note(midi)?.decay;
    if (!d?.t?.length) return 0;
    const { t: ts, db } = d;
    if (t <= ts[0]) return db[0];
    for (let i = 0; i < ts.length - 1; i++) {
      if (t <= ts[i + 1]) {
        const u = (t - ts[i]) / (ts[i + 1] - ts[i]);
        return db[i] + (db[i + 1] - db[i]) * u;
      }
    }
    return db[db.length - 1];
  }

  /**
   * Control rate. Drive, leak, re-rank, and move the voices' gains.
   *
   * @param sounding  the notes still ringing, for the sustained drive -- see
   *                  sustainFrom. Omitted, this behaves as it used to: strikes
   *                  only, and the halo is whatever the accumulator has left.
   */
  tick(dt, sounding = null, pedal = 0) {
    if (!this.enabled) { if (this.voices.size) this.allOff(); return; }
    this.sustainFrom(sounding, pedal);
    const bleedOn = this.dampedAmount > 0;
    const want = [];
    for (let i = 0; i < this.n; i++) {
      if (this.E[i] <= 0 && this.T[i] <= 0) continue;
      const m = this.lo + i;
      const open = this.undamped.has(m);
      // A damped string bleeds only briefly -- the damper is resting on it -- so
      // it leaks at dampedDecay, not at its open (measured) decay rate. It may
      // not leak below the level the sounding notes are holding it at: that
      // floor is the sustained drive, and it is why a held note keeps a halo.
      this.E[i] = Math.max(this.E[i] * Math.exp(-dt / (open ? this.tau[i] : this.dampedDecay)), this.T[i]);
      if (this.E[i] < this.threshold * 0.4) {
        // Too quiet for a voice -- but still a string with energy in it, which
        // the sustained drive may yet bring back. Only well under that is it
        // actually forgotten.
        this.stop(m);
        if (this.E[i] < this.floor) { this.E[i] = 0; this.spent.delete(m); this.fresh.delete(m); }
        continue;
      }
      // Free strings always compete for a voice; damped ones only when the
      // soundboard bleed is switched on. They rank below the free strings by
      // energy, so real resonance keeps priority and bleed fills spare voices.
      if (this.E[i] > this.threshold && (open || bleedOn)) want.push(i);
    }
    // Rank the competition for voices: energy, biased toward the music (see
    // nearness), and with a string that is already sounding defending its slot
    // -- it has to be beaten by `stickiness` before it is displaced, so the
    // strings either side of the cut stop trading the last voice back and
    // forth every few ticks.
    const near = this.nearness(sounding);
    const rank = (i) => this.E[i] * near[i] * (this.voices.has(this.lo + i) ? this.stickiness : 1);
    want.sort((a, b) => rank(b) - rank(a));
    const keep = new Set(want.slice(0, this.maxVoices).map((i) => this.lo + i));
    for (const midi of this.voices.keys()) if (!keep.has(midi)) this.stop(midi);
    const now = this.ctx.currentTime;
    for (const midi of keep) {
      let v = this.voices.get(midi);
      if (!v) {
        // Its recording already ran out. Leave it ringing silently until a
        // fresh strike (excite) drives it again -- do not replay the sample.
        if (this.spent.has(midi)) continue;
        // And it may only BEGIN sounding just after something drove it. A
        // string that rose through the ranking on its own goes on ringing
        // silently: see `fresh`. This is what stops the ghost notes.
        const struck = this.fresh.get(midi);
        if (struck == null || now - struck > this.startWindow) continue;
        this.fresh.delete(midi);
        v = this.start(midi);
      }
      if (!v) continue;
      // times v.unit, the gain that restores this recording's true level.
      // Leaving that out -- which this did -- plays a peak-normalised
      // pianissimo sample as though it were fortissimo, about 20 dB too loud,
      // on every one of these voices at once. The result was a grain cloud
      // 13 dB above the piano it was supposed to be a halo around.
      // The ceiling grows with `amount` past 0.8, the old top of its slider.
      // Held fixed, it would cap a boosted send almost at once, and turning
      // the amount up would stop making the halo louder.
      const ceil = this.ceiling * Math.max(1, this.amount / 0.8);
      const g = Math.min(this.amount * Math.sqrt(this.E[midi - this.lo]), ceil) * v.unit;
      // Slower while the voice is opening. 45 ms up from silence is an attack,
      // and an attack is the one thing a sympathetic string does not have; it
      // only needs to be quick once the voice is up and following the
      // accumulator.
      v.lvl.gain.setTargetAtTime(g, now, now < v.rise ? 0.12 : 0.045);
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
    const dbAt = (t) => this.decayDb(midi, t);
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
    const v = { src, comp, lp, lvl, rel, target: 0, unit: got.entry.gain, until: now + dur,
      rise: now + 0.3 };
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
    // Ahead of the audio thread, for the same reason as Engine.time(): a duck
    // scheduled in the past is joined partway down, which is a step.
    const now = this.ctx.currentTime + this.lookahead;
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

  allOff() { for (const midi of [...this.voices.keys()]) this.stop(midi, true); this.E.fill(0); this.T.fill(0); this.spent.clear(); this.fresh.clear(); }

  /** Move the tone control on voices that are already sounding, not just new ones. */
  setTone(hz) {
    this.tone = hz;
    const now = this.ctx.currentTime;
    for (const v of this.voices.values()) v.lp.frequency.setTargetAtTime(hz, now, 0.02);
  }

  /** Keys whose buffers are in use, so the library does not evict them. */
  heldKeys(out) { for (const midi of this.voices.keys()) out.add(this.lib.key(midi, this.lib.layers[0])); }
}


/**
 * The interactive editor for a ResCurve.
 *
 * Click empty space to add a point, drag to move it, double-click to remove --
 * the same gestures as the velocity curves, because it is the same kind of
 * object. The keyboard is drawn behind it: octaves labelled, the black keys
 * marked, and the region above the last damper shaded, since that region is
 * the reason this control exists. Strings that are currently ringing are drawn
 * as faint bars, so a pass can be aimed at what is actually sounding.
 */
export function createResCurveEditor(canvas, rc, { topDamped = 108, energy = null, onChange } = {}) {
  const ctx = canvas.getContext('2d');
  const dpr = () => window.devicePixelRatio || 1;
  const { lo, hi } = rc;
  const SPAN = RES_CEIL - RES_FLOOR;
  const xOf = (k, w) => (k - lo) / (hi - lo) * w;
  const yOf = (db, h) => (RES_CEIL - db) / SPAN * h;
  const kOf = (px, w) => Math.max(lo, Math.min(hi, Math.round(lo + px / w * (hi - lo))));
  const dbOf = (py, h) => Math.max(RES_FLOOR, Math.min(RES_CEIL, RES_CEIL - py / h * SPAN));
  const BLACK = new Set([1, 3, 6, 8, 10]);
  let drag = -1;

  function draw() {
    const w = canvas.width = canvas.clientWidth * dpr();
    const h = canvas.height;
    const kw = w / (hi - lo + 1);
    ctx.fillStyle = '#17150f'; ctx.fillRect(0, 0, w, h);
    // The keys, and the undamped region that has no choice but to ring.
    for (let k = lo; k <= hi; k++) {
      const x = xOf(k, w);
      if (k > topDamped) { ctx.fillStyle = '#231d12'; ctx.fillRect(x, 0, kw + 1, h); }
      if (BLACK.has(k % 12)) { ctx.fillStyle = 'rgba(0,0,0,0.30)'; ctx.fillRect(x, 0, kw + 1, h); }
    }
    // What is ringing right now, faintly, behind the curve.
    if (energy) {
      for (let k = lo; k <= hi; k++) {
        const e = energy(k);
        if (!(e > 0)) continue;
        const a = Math.min(1, Math.sqrt(e) * 3);
        ctx.fillStyle = `rgba(217,164,65,${0.12 + 0.2 * a})`;
        ctx.fillRect(xOf(k, w), h - h * Math.min(1, a), kw + 1, h);
      }
    }
    // dB grid. 0 is the line that means "as sent", so it is the bright one.
    ctx.font = `${9 * dpr()}px ui-monospace,monospace`; ctx.textAlign = 'left';
    for (let d = RES_CEIL; d >= RES_FLOOR; d -= 12) {
      const y = yOf(d, h);
      ctx.strokeStyle = d === 0 ? '#5a4a32' : '#302a20';
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      ctx.fillStyle = '#6d6458';
      ctx.fillText(d === RES_FLOOR ? 'off' : `${d > 0 ? '+' : ''}${d}`, 3 * dpr(), Math.min(h - 2, y + 10 * dpr()));
    }
    // Octave lines, labelled at every C.
    ctx.strokeStyle = '#2b261d'; ctx.fillStyle = '#5c5449';
    for (let k = lo; k <= hi; k++) {
      if (k % 12 !== 0) continue;
      const x = xOf(k, w);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      ctx.fillText(`C${k / 12 - 1}`, x + 2 * dpr(), h - 3 * dpr());
    }
    // The damper break, named -- everything right of it is always free.
    if (topDamped >= lo && topDamped < hi) {
      const x = xOf(topDamped + 1, w);
      ctx.strokeStyle = '#7fbf7f'; ctx.setLineDash([4 * dpr(), 4 * dpr()]);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#7fbf7f'; ctx.textAlign = 'left';
      ctx.fillText('no dampers →', x + 4 * dpr(), 11 * dpr());
    }
    // The curve, then its handles.
    ctx.strokeStyle = '#d9a441'; ctx.lineWidth = 2 * dpr(); ctx.beginPath();
    for (let k = lo; k <= hi; k++) {
      const x = xOf(k, w), y = yOf(rc.at(k), h);
      k === lo ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
    for (const p of rc.points) {
      ctx.fillStyle = '#ffeec0';
      ctx.beginPath(); ctx.arc(xOf(p.k, w), yOf(p.db, h), 4 * dpr(), 0, 7); ctx.fill();
    }
  }

  const local = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width * canvas.width, y: (e.clientY - r.top) / r.height * canvas.height };
  };
  const hit = (x, y) => {
    const w = canvas.width, h = canvas.height, R = 12 * dpr();
    for (let i = 0; i < rc.points.length; i++) {
      if (Math.hypot(x - xOf(rc.points[i].k, w), y - yOf(rc.points[i].db, h)) < R) return i;
    }
    return -1;
  };

  canvas.addEventListener('pointerdown', (e) => {
    const { x, y } = local(e);
    let i = hit(x, y);
    if (i < 0) {
      const p = { k: kOf(x, canvas.width), db: dbOf(y, canvas.height) };
      rc.points.push(p); rc.points.sort((a, b) => a.k - b.k);
      i = rc.points.indexOf(p);
    }
    drag = i;
    canvas.setPointerCapture(e.pointerId);
    draw(); onChange?.();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (drag < 0) return;
    const { x, y } = local(e);
    const p = rc.points[drag], last = rc.points.length - 1;
    p.db = dbOf(y, canvas.height);
    // The ends are pinned to the ends of the keyboard; the rest move freely in
    // both axes but cannot cross their neighbours, so the map stays a function.
    if (drag > 0 && drag < last) {
      const a = rc.points[drag - 1].k + 1, b = rc.points[drag + 1].k - 1;
      p.k = Math.max(a, Math.min(b, kOf(x, canvas.width)));
    }
    draw(); onChange?.();
  });
  const end = (e) => { if (drag >= 0) { drag = -1; try { canvas.releasePointerCapture(e.pointerId); } catch { /* */ } onChange?.(); } };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('dblclick', (e) => {
    const { x, y } = local(e);
    const i = hit(x, y);
    if (i > 0 && i < rc.points.length - 1) { rc.points.splice(i, 1); draw(); onChange?.(); }
  });

  draw();
  return { draw };
}
