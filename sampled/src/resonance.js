// Resonance: the rest of the piano answering the key you played.
//
// Three kinds, each a set of voices playing the library's own recordings of
// the strings that answer, and each with its own level and its own release:
//
//   SYMPATHETIC   strings whose dampers are off -- the pedal is down, a key is
//                 held, or it is one of the top strings that have no damper --
//                 ring at the partials they share with the struck note. Which
//                 strings, and how strongly, is partial coincidence (with each
//                 string's real inharmonicity) tilted by distance (near/far).
//                 When the pedal lifts, the dampers land on them: that is the
//                 `pedalUpRelease`.
//   SOUNDBOARD    with or without the pedal, the strings around the struck key
//                 pick some of it up through the bridge and the board. Nearest
//                 loudest, falling off by `sbFalloff` dB per doubling of
//                 distance (see distanceDb).
//   SELF          the struck string's own unison and duplex answering it: the
//                 same key's recording under the note.
//
// A resonance voice lasts exactly as long as what drives it. It starts on the
// strike, plays its recording as recorded -- the recording's own decay is the
// decay, nothing is compensated -- and when the note driving it stops sounding
// (key up with the pedal up, or the pedal lifting) it fades over its kind's
// release time. A voice driven by several notes waits for the last of them.
//
// A recording is entered past the hammer knock (`startAt`, with a `bloom`
// fade-in), because what answers a strike is a string, not another strike.
// There is no reverb here: the voices go into the same per-key channel strips
// as the struck notes, and the room is the room's job.

import { StreamSource } from './stream.js';
import { RATE } from './ogg.js';
import { holdFade, fadeAt } from './envelopes.js';

/** Inharmonicity across the compass: 1.2e-4 at A0 to 2.5e-2 at C8, log-linear. */
const bOf = (midi) => Math.pow(10, -3.92 + (midi - 21) * (-1.60 + 3.92) / 87);

const partial = (f0, B, n) => f0 * n * Math.sqrt(1 + B * n * n);

/**
 * Coupling weight for every ordered pair of keys, normalised to a peak of 1,
 * and which of the answering string's partials it drives.
 *
 * For each partial of the struck note, find the resonator's nearest partial
 * and score the overlap with a Lorentzian in Hz (its power response), whose
 * width is the string's half-power bandwidth from its measured decay rate,
 * times `selectivity`. At 1
 * it is physical and almost nothing answers unless it is in tune to a cent;
 * wider stands in for the soundboard's own broad modes.
 */
export function couplingMatrix(hz, { partials = 16, selectivity = 8, lo = 21, hi = 108 } = {}) {
  const n = hi - lo + 1;
  const W = new Float32Array(n * n);
  // The lowest partial of the answering string that takes a real share (a
  // quarter of the strongest) of the drive. A string is driven at its partials,
  // not at its note: C2 into a free D2 meets only at C2's 9th and D2's 8th, so
  // D2 rings at its 8th partial and its fundamental never moves. 1 means the
  // string's own fundamental answers.
  const K = new Uint8Array(n * n);
  const wk = new Float64Array(partials + 1);
  const f0 = new Float64Array(n), B = new Float64Array(n), bw = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const m = lo + i;
    f0[i] = hz(m);
    B[i] = bOf(m);
    bw[i] = Math.max(0.05, hz.rate?.(m) ?? 3) / (20 / Math.LN10) / Math.PI * selectivity;
  }
  for (let si = 0; si < n; si++) {
    for (let ri = 0; ri < n; ri++) {
      if (si === ri) continue;
      wk.fill(0);
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
          // The resonator's POWER response, 1/(1+r^2): energy is what passes
          // from one string to the other. The amplitude response, 1/sqrt, has
          // tails so long that a string a semitone off answered at -7 dB.
          if (d > width * 8) continue;
          const r = 2 * d / width;
          wk[k] += a * Math.pow(k, -1.2) / (1 + r * r);
        }
      }
      let w = 0, top = 0;
      for (let k = 1; k <= partials; k++) { w += wk[k]; if (wk[k] > top) top = wk[k]; }
      let kmin = 1;
      while (kmin < partials && wk[kmin] < top * 0.25) kmin++;
      W[si * n + ri] = w;
      K[si * n + ri] = kmin;
    }
  }
  let max = 0;
  for (let i = 0; i < W.length; i++) if (W[i] > max) max = W[i];
  if (max > 0) for (let i = 0; i < W.length; i++) W[i] /= max;
  return { W, K, n, lo };
}

// How far the per-key level curve reaches down. At the floor a string does
// not answer at all.
export const RES_FLOOR = -48;
export const RES_CEIL = 12;

/**
 * A hand-drawn key -> level curve for all the resonance, in dB, on the string
 * that answers. Pinned at both ends of the keyboard, linear between points,
 * flat 0 dB by default. Mostly for the top strings, which have no dampers and
 * so answer everything whether the pedal is down or not.
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

  /** The factor on a voice's amplitude. Floor means off. */
  gain(midi) {
    const db = this.at(midi);
    return db <= RES_FLOOR ? 0 : Math.pow(10, db / 20);
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

export const KINDS = ['sym', 'sb', 'self'];

// A voice quieter than this, as a fraction of the recording's true level, is
// not worth starting (-54 dB).
const MIN_GAIN = 0.002;
// Velocity to amplitude. A hammer's energy goes as v^2 and what reaches the
// bridge is graded a little more sharply than that.
const VEL_EXP = 1.75;
// How far a sounding voice's recording may have decayed (-18 dB) and still be
// turned up to take a fresh drive. Past this, turning it up would be turning
// up the room's noise, so it is crossfaded into a new start instead. How loud
// the string has become is not limited here: under the pedal, repeated strikes
// really do build it up.
const TOPUP_DECAY = 0.125;
// How much louder a newcomer must be than the quietest sounding voice to take
// its slot when max voices is full (+6 dB). Without it the strings either side
// of the cut trade places on every strike, and every trade is a fade.
const STEAL = 2;
// A top-up smaller than this (+0.5 dB) is not worth moving the gain for.
const TOPUP_MIN = 1.06;
// Time constant of a top-up: quick, since a string pushed again answers at once.
const TOPUP_TAU = 0.04;
// How fast a tail on its fall is cut short when its slot is needed.
const CUT = 0.1;

// The distance at which the fall-off starts to bite, in semitones.
const NEAR_REF = 2;

/**
 * Level, in dB, at `d` semitones from the struck key, falling `perDoubling` dB
 * each time the distance doubles -- the law a vibration spreading out from a
 * point obeys (6 dB per doubling is 1/r). Measured from NEAR_REF rather than
 * from zero, so the nearest few strings are close in level and the curve then
 * flattens out: an octave away is well down, but three octaves is not much
 * further down than two. A negative rate favours far strings the same way.
 */
export const distanceDb = (d, perDoubling) => -perDoubling * Math.log2(1 + d / NEAR_REF);
// Random stagger across a pedal lift, so the dampers do not land as one click.
const PEDAL_JITTER = 0.04;

export class Resonance {
  /**
   * @param strip  (midi) => the per-key channel strip input to play into, so a
   *               resonance voice sits where that key's strings sit
   */
  constructor(ctx, lib, curves, strip, envelopes = null) {
    this.ctx = ctx; this.lib = lib; this.curves = curves; this.strip = strip; this.env = envelopes;
    this.lo = lib.m.keys.lo; this.hi = lib.m.keys.hi;
    this.n = this.hi - this.lo + 1;
    this.enabled = true;
    this.lookahead = 0;           // seconds; the engine sets its own
    this.renderer = () => null;   // the engine's one-worklet voice renderer, when it is on

    // Sympathetic (free strings, partial coincidence).
    this.symAmount = 0.3;
    this.symRelease = 3;          // s, a free string ringing on after the note driving it stops
    this.pedalUpRelease = 0.6;    // s, when a damper lands on it
    this.proximity = 0;           // near/far, dB per doubling of distance (see applyProximity)
    // Play only the partials a sympathetic string is actually driven at: a
    // high-pass just under the lowest one (see couplingMatrix's K). Off plays
    // the whole recording, fundamental and all, whichever partial matched.
    this.partialsOnly = true;
    // Soundboard (every string near the key, pedal or not).
    this.sbAmount = 0.08;
    this.sbFalloff = 9;           // dB per doubling of distance (see distanceDb)
    this.sbStep = 1;              // every string (1), every 2nd, every 3rd... out from the key
    this.sbRelease = 1.2;
    // Only the nearest strings take part: past about six keys either way a
    // string adds little (~7% of the soundboard's energy, -0.3 dB) and costs
    // a voice like any other.
    this.sbMax = 12;
    // Self (the struck key's own recording under the note).
    this.selfAmount = 0;
    this.selfRelease = 0.4;

    // Shared.
    this.maxVoices = 24;
    // How long a voice takes to hand over when it has to be cut: crossfaded
    // into a restart of the same string, or faded out to make room for a
    // louder one when `maxVoices` is full.
    this.crossfade = 0.4;         // s
    // A voice a quick pedal change catches is brought back only if it is
    // still louder than this, in dB of the string's own mezzo-forte level.
    this.resumeDb = -45;
    this.tone = 5200;
    this.layer = lib.m.resLayers?.includes(8) ? 8 : lib.layers[Math.floor(lib.layers.length / 2)];
    this.startAt = 0.8;           // s into the recording
    this.bloom = 0.25;            // s of fade-in

    this.voices = new Map();      // `${kind}:${midi}` -> voice, while driven
    this.fading = new Set();      // released voices, until they have stopped
    this.chains = new Map();      // `${kind}:${midi}` -> the filters its voices share (see chain)
    this.undamped = new Set();
    this.level = new Float64Array(this.n);   // per string, for the display
    this.keyCurve = new ResCurve(this.lo, this.hi);
    this.keyG = new Float64Array(this.n).fill(1);
    this.build();
  }

  build(selectivity = 8) {
    const fn = (m) => this.lib.note(m)?.hz ?? 440 * Math.pow(2, (m - 69) / 12);
    fn.rate = (m) => this.lib.note(m)?.layers?.[1]?.edr ?? 3;
    this.mat = couplingMatrix(fn, { selectivity, lo: this.lo, hi: this.hi });
    this.selectivity = selectivity;
    this.applyProximity();
  }

  /**
   * Tilt the partial coupling by distance along the keyboard: `proximity` dB
   * of level per doubling of distance (distanceDb), positive favouring near
   * strings. Each
   * struck key's row is renormalised to the total it had, so this moves the
   * resonance around the keyboard without turning it up or down.
   */
  applyProximity() {
    const src = this.mat.W, n = this.n;
    if (!this.W || this.W.length !== src.length) this.W = new Float32Array(src.length);
    if (!this.proximity) { this.W.set(src); return; }
    // Weights are energies and the slider is a level, so dB/10, not dB/20.
    const f = new Float64Array(n);
    for (let d = 0; d < n; d++) f[d] = Math.pow(10, distanceDb(d, this.proximity) / 10);
    for (let si = 0; si < n; si++) {
      const row = si * n;
      let before = 0, after = 0;
      for (let ri = 0; ri < n; ri++) {
        const w = src[row + ri];
        if (w <= 0) continue;
        before += w;
        after += w * f[Math.abs(si - ri)];
      }
      const norm = after > 0 ? before / after : 1;
      for (let ri = 0; ri < n; ri++) this.W[row + ri] = src[row + ri] * f[Math.abs(si - ri)] * norm;
    }
  }

  setProximity(db) { this.proximity = db; this.applyProximity(); }

  /** Re-read the per-key level curve. Call after drawing on it. */
  refreshKeyCurve() {
    for (let i = 0; i < this.n; i++) this.keyG[i] = this.keyCurve.gain(this.lo + i);
    for (const [id, v] of [...this.voices]) if (this.keyG[v.midi - this.lo] === 0) this.release(id, 0.1);
  }

  /**
   * Which strings are free. A damper landing ends that string's sympathetic
   * voice. A damper lifting never starts one -- only a strike does. It can
   * only bring back what a damper was still in the middle of stopping (see
   * resumeFreed), at the level it had fallen to.
   *
   * @param sounding  [{ midi }] -- the notes ringing freely, after the
   *                  engine has resumed its own
   * @param delayOf   (midi) => seconds until that string's damper lands: a
   *                  pedal lift reaches the bass after the treble
   */
  setUndamped(set, sounding = [], delayOf = null) {
    this.undamped = set;
    for (const [id, v] of [...this.voices]) {
      if (v.kind === 'sym' && !set.has(v.midi)) {
        this.release(id, this.pedalUpRelease, PEDAL_JITTER, false, true, delayOf?.(v.midi) ?? 0);
      }
    }
    if (this.enabled && sounding.length) this.resumeFreed(set, new Set(sounding.map((s) => s.midi)));
  }

  /**
   * Strings already sounding first, so they are topped up before anything new
   * is weighed against them for a slot; then loudest first.
   */
  order(want) {
    const t = this.soon();
    for (const w of want) {
      const id = `${w.kind}:${w.target}`;
      w.on = this.voices.has(id) || this.tailOf(id, t) ? 1 : 0;
    }
    want.sort((a, b) => b.on - a.on || b.g - a.g);
  }

  /** A candidate's gain: its coupling `g`, at velocity `vel`, on the string's own level. */
  strength(target, g, vel) {
    return g * Math.pow(vel / 127, VEL_EXP) * this.keyG[target - this.lo]
      * Math.max(0, this.curves.at('resonance', target));
  }

  /**
   * A hammer landed on `midi` at `when` (context time). Start, or top up, the
   * voices of every string that answers.
   */
  excite(midi, vel, when = this.ctx.currentTime) {
    if (!this.enabled || midi < this.lo || midi > this.hi) return;
    const si = midi - this.lo, n = this.n;
    const want = [];
    const add = (kind, target, g, k = 1) => {
      g = this.strength(target, g, vel);
      if (g > MIN_GAIN) want.push({ kind, target, g, k });
    };
    if (this.symAmount > 0) {
      for (let ri = 0; ri < n; ri++) {
        const r = this.lo + ri;
        if (r === midi || !this.undamped.has(r)) continue;
        const w = this.W[si * n + ri];
        if (w > 1e-4) add('sym', r, this.symAmount * Math.sqrt(w), this.mat.K[si * n + ri]);
      }
    }
    if (this.sbAmount > 0) {
      const from = want.length;
      for (let ri = 0; ri < n; ri++) {
        const r = this.lo + ri;
        if (r === midi || Math.abs(r - midi) % this.sbStep) continue;
        add('sb', r, this.sbAmount * Math.pow(10, distanceDb(Math.abs(r - midi), this.sbFalloff) / 20));
      }
      // The loudest sbMax of them.
      if (want.length - from > this.sbMax) {
        const sb = want.splice(from).sort((a, b) => b.g - a.g);
        want.push(...sb.slice(0, this.sbMax));
      }
    }
    if (this.selfAmount > 0) add('self', midi, this.selfAmount);
    this.order(want);
    for (const w of want) this.drive(w.kind, w.target, w.g, midi, when, w.k);
  }

  /**
   * One string, driven by `from` at gain `g`.
   *
   * A string that is already ringing is not restarted: it is pushed harder.
   * Its gain goes smoothly up to where the energies of what it had and what it
   * was given add, and its recording plays on. Restarting it instead -- which
   * this used to do on every strike louder than what was left -- faded the old
   * voice out while the new one faded in, on every answering string at once,
   * and a repeated note under the pedal pumped. Only when the recording has
   * decayed too far to be turned up is it crossfaded into a fresh start.
   *
   * The same goes for a string still on its fall from the last strike (its
   * note let go, a damper landing): the fall stops where it has got to and
   * the string is pushed from there, as a real one would be -- instead of a
   * second voice blooming in on the same string beside the dying one.
   */
  drive(kind, midi, g, from, when, k = 1) {
    const id = `${kind}:${midi}`;
    const cur = this.voices.get(id) ?? this.revive(id, when);
    if (cur) {
      cur.drivers.add(from);
      // Driven lower down its partials than before: open the filter to them.
      if (k < cur.k) { cur.k = k; this.setPartialFilter(cur, when); }
      const est = this.estimate(cur, when);
      const decayed = est / cur.gain;                  // how far its recording has fallen
      const next = Math.hypot(est, g) / Math.max(decayed, 1e-6);
      if (next < cur.gain * TOPUP_MIN) return;
      if (decayed >= TOPUP_DECAY) {
        cur.gain = next;
        cur.lvl.gain.setTargetAtTime(next * cur.unit, when, TOPUP_TAU);
        return;
      }
      g = Math.hypot(est, g);
      this.release(id, this.crossfade, 0, true);
      const v = this.start(kind, midi, g, when, Math.max(this.crossfade, 0.02), Math.min(k, cur.k));
      if (v) { for (const d of cur.drivers) v.drivers.add(d); this.voices.set(id, v); }
      return;
    }
    if (!this.makeRoom(g, when)) return;
    const v = this.start(kind, midi, g, when, this.bloom, k);
    if (v) { v.drivers.add(from); this.voices.set(id, v); }
  }

  /** The high-pass under partial `v.k` of the string, or wide open. */
  partialCut(v) {
    if (!this.partialsOnly || v.k <= 1) return 10;
    const f0 = this.lib.note(v.midi)?.hz ?? 440 * Math.pow(2, (v.midi - 69) / 12);
    return Math.min(16000, f0 * (v.k - 0.5));
  }

  setPartialFilter(v, when = this.ctx.currentTime) {
    const f = this.partialCut(v);
    if (v.chain) v.chain.cut = f;
    for (const hp of v.hp) hp.frequency.setTargetAtTime(f, when, 0.05);
  }

  /** Switch the partial filter on or off, on the voices already sounding too. */
  setPartialsOnly(on) {
    this.partialsOnly = on;
    for (const v of this.voices.values()) this.setPartialFilter(v);
  }

  /**
   * Free a voice for one of gain `g`, if it is well louder than the quietest.
   * Tails on their fall count as well as driven voices -- they cost the same
   * to play -- and are cut short (CUT) when one of them is the quietest.
   */
  makeRoom(g, when) {
    const tails = this.tails();
    if (this.voices.size + tails.length < this.maxVoices) return true;
    let low = null, lowG = Infinity;
    for (const v of this.voices.values()) {
      const e = this.estimate(v, when);
      if (e < lowG) { lowG = e; low = v; }
    }
    for (const v of tails) {
      const e = this.loudness(v, when);
      if (e < lowG) { lowG = e; low = v; }
    }
    if (lowG * STEAL >= g) return false;
    if (this.fading.has(low)) this.cut(low);
    else this.release(`${low.kind}:${low.midi}`, this.crossfade, 0, true);
    return true;
  }

  /**
   * Released voices on their kind's fall (not those on a quick crossfade or
   * cut, which are gone in a moment): they count toward maxVoices.
   */
  tails() {
    const out = [];
    for (const v of this.fading) if (v.resumable) out.push(v);
    return out;
  }

  /** The tail on string `id` that a strike can pick up again, if any. */
  tailOf(id, t = this.soon()) {
    let got = null;
    for (const v of this.fading) {
      if (!v.resumable || !v.fade || t > v.stopAt - 0.04 || `${v.kind}:${v.midi}` !== id) continue;
      if (!got || v.t0 > got.t0) got = v;
    }
    return got;
  }

  /** How loud a voice is now, down its fall if it is on one. */
  loudness(v, t) {
    return v.fade ? this.estimate(v, t) / (v.level ?? 1) * fadeAt(v.fade, t) : this.estimate(v, t);
  }

  /**
   * The earliest a change can be scheduled and still be in the audio thread's
   * future even at the largest buffer size: a hold placed in its past would
   * cut a fade short instead.
   */
  soon() { return this.ctx.currentTime + Math.max(this.lookahead, this.ctx.baseLatency ?? 0) + 0.01; }

  /** Where the audio clock is now (see Engine.audioNow). */
  audioNow() { return this.ctx.currentTime; }

  /** Stop the fall of the tail on `id` where it has got to, and drive it again. */
  revive(id, when) {
    const t = Math.max(when, this.soon());
    const v = this.tailOf(id, t);
    if (!v) return null;
    const level = holdFade(v.rel.gain, v.fade, t, this.audioNow());
    v.src.resume();
    v.level = level;
    v.fade = null;
    v.resumable = false;
    v.drivers = new Set();
    this.fading.delete(v);
    this.voices.set(id, v);
    return v;
  }

  /** A tail's slot is needed: finish its fall in `fall` seconds from where it is. */
  cut(v, fall = CUT) {
    const t = this.soon();
    v.resumable = false;
    if (!v.fade) return;                      // on a plain ramp: let it finish
    holdFade(v.rel.gain, v.fade, t, this.audioNow());
    v.rel.gain.linearRampToValueAtTime(0, t + fall);
    v.fade = null;
    v.stopAt = Math.min(v.stopAt, t + fall + 0.03);
    try { v.src.stop(v.stopAt); } catch { /* already stopped */ }
  }

  /** Roughly how loud a voice is now: its gain, down its recording's own decay. */
  estimate(v, t) {
    // Asked for every voice by each new string of a strike (makeRoom), all at
    // the strike's time: worked out once per voice, again when anything it
    // depends on has moved.
    const c = v.est;
    if (c && c.t === t && c.gain === v.gain && c.level === v.level && c.layer === this.layer) return c.e;
    const age = Math.max(0, t - v.t0);
    const e = v.gain * (v.level ?? 1) * Math.pow(10, (this.decayDb(v.midi, v.offset + age) - v.db0) / 20);
    v.est = { t, gain: v.gain, level: v.level, layer: this.layer, e };
    return e;
  }

  /** A note's measured decay, dB below its peak, `t` s in, for the layer played. */
  decayDb(midi, t) {
    const n = this.lib.note(midi);
    const d = n?.layerDecay?.[this.layer] ?? n?.decay;
    if (!d?.t?.length) return 0;
    const { t: ts, db } = d;
    if (t <= ts[0]) return db[0];
    for (let i = 0; i < ts.length - 1; i++) {
      if (t <= ts[i + 1]) return db[i] + (db[i + 1] - db[i]) * (t - ts[i]) / (ts[i + 1] - ts[i]);
    }
    return db[db.length - 1];
  }

  start(kind, midi, g, when, fadeIn = this.bloom, k = 1) {
    const got = this.lib.best(midi, this.layer);
    if (!got) return null;
    const ctx = this.ctx;
    const len = got.frames / RATE;
    const offset = Math.max(Math.min(0.03, len * 0.1), Math.min(this.startAt, len / 3));
    // The wanted layer's true level, whichever layer is standing in for it
    // while the library loads -- each file is peak-normalised.
    const unit = this.lib.entry(midi, this.layer)?.gain ?? got.entry.gain;

    const id = `${kind}:${midi}`;
    // `gain` moves with top-ups (see drive).
    const v = { kind, midi, key: got.key, gain: g, unit, t0: when, offset,
      db0: this.decayDb(midi, offset), drivers: new Set(), k };
    const r = this.renderer();
    const c = this.chain(id, v, r);
    v.chain = c; v.hp = c.hp; v.lp = c.lp;
    let src, lvl, rel;
    if (r) { src = r.voice(got.key, got.frames, midi, c); ({ lvl, rel } = src); }
    else { src = new StreamSource(this.lib.streamer, got.key, got.frames); lvl = ctx.createGain(); rel = ctx.createGain(); }
    v.src = src; v.lvl = lvl; v.rel = rel;
    src.playbackRate.value = Math.pow(2, this.curves.at('tune', midi) / 1200);
    lvl.gain.value = g * unit;
    // Sits at 1 until release() runs its fall from that known value.
    rel.gain.value = 1;
    if (!r) src.connect(lvl).connect(rel).connect(c.hp[0]);
    src.start(when, offset, fadeIn, this.fadeInCurve());
    src.onended = () => {
      // The recording ran out: nothing left to fade.
      if (this.voices.get(id) === v) this.voices.delete(id);
      this.fading.delete(v);
      rel.disconnect();
      if (--c.users === 0) {
        if (c.renderer) c.free(); else c.lp.disconnect();
        if (this.chains.get(id) === c) this.chains.delete(id);
      }
    };
    return v;
  }

  /**
   * The filters of the voices on one string: a new voice there while the last
   * is still on its crossfade or its fall goes through the same ones, rather
   * than three more filters of its own -- a biquad costs the audio thread
   * about as much as the voice itself. Filters are linear, so the sum through
   * one set is the sum of each through its own; the level and release gains
   * sit in front of them for that. Shared only at the same partial cut-off:
   * a voice that needs another one gets filters of its own, and is the one a
   * later voice there joins.
   */
  chain(id, v, r = null) {
    const cut = this.partialCut(v);
    let c = this.chains.get(id);
    if (!c || c.cut !== cut || !c.renderer !== !r) {
      if (r) {
        c = r.chain(v.midi, cut, this.tone);
        c.cut = cut; c.users = 0;
        this.chains.set(id, c);
        c.users++;
        return c;
      }
      const ctx = this.ctx;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = this.tone; lp.Q.value = 0.5;
      // Two second-order high-passes, 24 dB/octave: steep enough that a string
      // driven at its 2nd partial loses its fundamental, not just some of it.
      const hp = [ctx.createBiquadFilter(), ctx.createBiquadFilter()];
      for (const h of hp) { h.type = 'highpass'; h.Q.value = Math.SQRT1_2; h.frequency.value = cut; }
      hp[0].connect(hp[1]).connect(lp).connect(this.strip(v.midi));
      c = { hp, lp, cut, users: 0 };
      this.chains.set(id, c);
    }
    c.users++;
    return c;
  }

  /** The fade-in shape (Envelopes: resonance fade-in), 0 -> 1, or null for the worklet's raised cosine. */
  fadeInCurve() { return this.env?.resAttack.shape.curve(0, 1, 64) ?? null; }

  /**
   * The crossfade's other half: `from` down to 0 along the mirror image of
   * the fade-in, so an outgoing and an incoming voice always sum to `from`.
   */
  fadeOutCurve(from) {
    const a = this.fadeInCurve();
    const out = new Float32Array(a ? a.length : 64);
    for (let i = 0; i < out.length; i++) {
      const up = a ? a[i] : 0.5 - 0.5 * Math.cos(Math.PI * i / (out.length - 1));
      out[i] = Math.max(1e-5, from * (1 - up));
    }
    out[out.length - 1] = 1e-5;
    return out;
  }

  /**
   * Fade a voice out over `fall` seconds, starting `after` s from now plus up
   * to `jitter` s at random, then stop it. `xfade` uses the mirror image of a new voice's fade-in, so a restart
   * crossfades at constant level; otherwise the resonance release shape.
   */
  release(id, fall, jitter = 0, xfade = false, resumable = false, after = 0) {
    const v = this.voices.get(id);
    if (!v) return;
    this.voices.delete(id);
    this.fading.add(v);
    const t = this.ctx.currentTime + this.lookahead + after + Math.random() * jitter;
    fall = Math.max(0.02, fall);
    const shape = this.env?.resRelease.shape;
    // From the level it is at: 1, unless it was resumed partway down a fall.
    const from = v.level ?? 1;
    const curve = xfade ? this.fadeOutCurve(from) : shape ? shape.curve(from, 0) : null;
    v.fade = null;
    // Never let a scheduling error skip src.stop(): an unstopped source plays
    // its whole recording with nothing left holding it.
    try {
      if (curve) { v.rel.gain.setValueCurveAtTime(curve, t, fall); v.fade = { t0: t, dur: fall, curve }; }
      else { v.rel.gain.setValueAtTime(from, t); v.rel.gain.linearRampToValueAtTime(0, t + fall); }
    } catch { /* stopped below regardless */ }
    v.stopAt = t + fall + 0.03;
    v.resumable = resumable;
    try { v.src.stop(v.stopAt); } catch { /* already stopped */ }
  }

  /**
   * Put back the voices that were fading because a damper landed -- on the
   * string, or on the note driving it -- when that damper lifts again before
   * they are silent: a quick pedal change. They go on from the level their
   * fall had reached, driven by whichever of their notes are sounding again --
   * but only those still louder than `resumeDb`. The quiet ones finish.
   */
  resumeFreed(free, live) {
    const t = this.soon();
    // Loudest first, and no more than maxVoices driven: the rest finish.
    const back = [];
    for (const v of this.fading) {
      if (!v.resumable || !v.fade || t > v.stopAt - 0.04) continue;
      if (v.kind === 'sym' && !free.has(v.midi)) continue;
      if (![...v.drivers].some((d) => live.has(d))) continue;
      // How loud it would come back: where its fall has got to, on how loud
      // it was when the damper landed.
      const e = this.loudness(v, t);
      if (e >= Math.pow(10, this.resumeDb / 20)) back.push([e, v]);
    }
    back.sort((a, b) => b[0] - a[0]);
    for (const [, v] of back) {
      if (this.voices.size >= this.maxVoices) break;
      const id = `${v.kind}:${v.midi}`;
      if (this.voices.has(id)) continue;
      const alive = [...v.drivers].filter((d) => live.has(d));
      const level = holdFade(v.rel.gain, v.fade, t, this.audioNow());
      v.src.resume();
      v.level = level;
      v.fade = null;
      v.resumable = false;
      v.drivers = new Set(alive);
      this.fading.delete(v);
      this.voices.set(id, v);
    }
  }

  /**
   * Control rate. Each voice keeps going while any note that drove it is still
   * sounding; when the last one stops, it takes its kind's release.
   *
   * @param sounding  [{ midi }] -- the notes still ringing freely
   */
  tick(dt, sounding = []) {
    if (!this.enabled) { if (this.voices.size || this.tails().length) this.allOff(); return; }
    const live = new Set();
    for (const s of sounding) live.add(s.midi);
    const now = this.ctx.currentTime;
    this.level.fill(0);
    for (const [id, v] of [...this.voices]) {
      // Its drivers are kept when it is released, so a pedal change that
      // brings them back can bring this back with them (resumeFreed).
      const alive = [...v.drivers].filter((d) => live.has(d));
      if (!alive.length) { this.release(id, this[v.kind + 'Release'], 0, false, true); continue; }
      if (alive.length < v.drivers.size) v.drivers = new Set(alive);
      const i = v.midi - this.lo;
      this.level[i] = Math.max(this.level[i], this.estimate(v, now));
    }
  }

  /** Everything, tails on their fall included: panic, or resonance switched off. */
  allOff() {
    for (const v of this.fading) if (v.fade && v.stopAt > this.soon() + 0.1) this.cut(v, 0.05);
    for (const id of [...this.voices.keys()]) this.release(id, 0.05);
  }

  /** Move the tone control on voices already sounding, not just new ones. */
  setTone(hz) {
    this.tone = hz;
    const now = this.ctx.currentTime;
    for (const c of this.chains.values()) c.lp.frequency.setTargetAtTime(hz, now, 0.02);
  }

  /** The strings with a voice of any kind. */
  ringing() {
    const out = new Set();
    for (const v of this.voices.values()) out.add(v.midi);
    return out;
  }

  /** Keys whose recordings are in use. */
  heldKeys(out) {
    for (const v of this.voices.values()) out.add(v.key);
    for (const v of this.fading) out.add(v.key);
  }
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
    ctx.fillStyle = '#0d1119'; ctx.fillRect(0, 0, w, h);
    // The keys, and the undamped region that has no choice but to ring.
    for (let k = lo; k <= hi; k++) {
      const x = xOf(k, w);
      if (k > topDamped) { ctx.fillStyle = '#131822'; ctx.fillRect(x, 0, kw + 1, h); }
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
      ctx.strokeStyle = d === 0 ? '#384154' : '#1c2434';
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      ctx.fillStyle = '#4f5c76';
      ctx.fillText(d === RES_FLOOR ? 'off' : `${d > 0 ? '+' : ''}${d}`, 3 * dpr(), Math.min(h - 2, y + 10 * dpr()));
    }
    // Octave lines, labelled at every C.
    ctx.strokeStyle = '#19202f'; ctx.fillStyle = '#424d63';
    for (let k = lo; k <= hi; k++) {
      if (k % 12 !== 0) continue;
      const x = xOf(k, w);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      ctx.fillText(`C${k / 12 - 1}`, x + 2 * dpr(), h - 3 * dpr());
    }
    // The damper break, named -- everything right of it is always free.
    if (topDamped >= lo && topDamped < hi) {
      const x = xOf(topDamped + 1, w);
      ctx.strokeStyle = '#d6c6a8'; ctx.setLineDash([4 * dpr(), 4 * dpr()]);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#d6c6a8'; ctx.textAlign = 'left';
      ctx.fillText('no dampers →', x + 4 * dpr(), 11 * dpr());
    }
    // The curve, then its handles.
    ctx.strokeStyle = '#d8c4a2'; ctx.lineWidth = 2 * dpr(); ctx.beginPath();
    for (let k = lo; k <= hi; k++) {
      const x = xOf(k, w), y = yOf(rc.at(k), h);
      k === lo ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
    for (const p of rc.points) {
      ctx.fillStyle = '#eee4d3';
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
