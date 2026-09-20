// The instrument: voices, channel strips, pedals, and the room they sit in.
//
// The graph is built once and then only has its numbers moved, because
// creating nodes on a note-on is how a sampler gets its first glitch.
//
//   voice ──► voiceGain ──┐
//                          ├─► [ per-key channel strip ] ──┬─► dry ──────► master ──► out
//   sympathetic voice ────┘        width matrix, then      └─► send ──► room ──► wet ──┘
//                                  position, then trim
//
// One strip per key rather than one per voice. A key's place in the stereo
// image, its width and its trim are properties of the KEY -- of where its
// strings sit on the soundboard -- and not of the particular note that is
// sounding, so they belong to something that outlives the voice. It also means
// a sympathetic voice for a key automatically lands in the same place as a
// struck one, which is not an optimisation but a requirement: they are the
// same strings.
import { plan } from './velocity.js';
import { Resonance } from './resonance.js';
import { renderIR, DEFAULTS as ROOM_DEFAULTS } from './room.js';
import { Envelopes } from './envelopes.js';
import { Eq } from './eq.js';

const MAX_VOICES = 64;

// Where the dampers come clear of the strings. Below this the pedal is
// shortening notes rather than sustaining them, which is what half-pedalling
// is; at or above it the string is free and nothing should be touching it.
const UNDAMP = 0.35;

export class Engine {
  constructor(ctx, lib, curves, envelopes = new Envelopes()) {
    this.ctx = ctx; this.lib = lib; this.curves = curves; this.env = envelopes;
    this.lo = lib.m.keys.lo; this.hi = lib.m.keys.hi;
    this.topDamped = lib.m.highestDamped;

    this.master = ctx.createGain();
    this.master.gain.value = 0.45;

    // A safety limiter, not a sound. Eighty-eight strings ringing under a held
    // pedal is a real gesture on a real piano and it genuinely is louder than
    // one note; without something here it is louder than 0 dBFS, and what a
    // browser does past that is clip. Threshold is high and the ratio steep,
    // so it does nothing at all until the sum would have run out of headroom.
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -2;
    this.limiter.knee.value = 2;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.12;
    // master -> EQ -> limiter -> out. The EQ is before the limiter so that a
    // boost cannot sneak past it, and after everything else so it is the last
    // word on tone rather than a way of fixing one note.
    this.eq = new Eq(ctx);
    this.master.connect(this.eq.in);
    this.eq.out.connect(this.limiter).connect(ctx.destination);
    this.limiterOn = true;

    this.dry = ctx.createGain(); this.dry.connect(this.master);
    this.wet = ctx.createGain(); this.wet.gain.value = 0.34; this.wet.connect(this.master);
    this.send = ctx.createGain();
    this.conv = ctx.createConvolver();
    this.conv.normalize = false;
    this.send.connect(this.conv).connect(this.wet);
    this.roomOpts = { ...ROOM_DEFAULTS };
    this.irRef = null;
    this.rebuildRoom();

    // Mechanical noise -- pedal action, key release -- does not belong to a
    // key's place on the soundboard, so it bypasses the strips.
    this.noise = ctx.createGain();
    this.noise.gain.value = 1;
    this.noise.connect(this.dry); this.noise.connect(this.send);

    // Salamander's own levels for the auxiliary samples (see build.mjs). The
    // key-release recordings sit at full scale in the file and the SFZ takes
    // 37 dB back off; playing them at face value makes every key lift sound
    // like a dropped hammer, which is exactly what it did before this.
    this.mix = lib.m.mixDb ?? { release: -37, damperL: -4, damperS: -4, damperV: 0, pedalDown: -20, pedalUp: -19 };
    this.db = (k) => Math.pow(10, (this.mix[k] ?? 0) / 20);

    this.oneShots = new Set();
    this.strips = new Map();
    for (let m = this.lo; m <= this.hi; m++) this.strips.set(m, this.makeStrip(m));

    this.voices = new Map();        // midi -> [voice]
    this.down = new Set();
    this.silent = new Set();
    this.sostenuto = new Set();
    this.pedal = 0;                 // 0..1, continuous: half-pedal is real
    this.unaCorda = 0;
    this.spread = 0.55;
    this.width = 1;
    this.perspective = 1;           // +1 player's view (bass left), -1 audience
    this.releaseNoise = 0.9;
    this.damperNoise = 1;
    this.pedalNoise = 0.8;
    this.held = new Set();

    this.res = new Resonance(ctx, lib, curves, (m) => this.strips.get(m).in, this.env);
    this.refreshStrips();
    this.updateUndamped();
  }

  // ------------------------------------------------------------- the strip --
  makeStrip(midi) {
    const c = this.ctx;
    const inG = c.createGain();
    const split = c.createChannelSplitter(2);
    const merge = c.createChannelMerger(2);
    const g = [c.createGain(), c.createGain(), c.createGain(), c.createGain()];   // LL, RL, LR, RR
    inG.connect(split);
    split.connect(g[0], 0); g[0].connect(merge, 0, 0);
    split.connect(g[1], 1); g[1].connect(merge, 0, 0);
    split.connect(g[2], 0); g[2].connect(merge, 0, 1);
    split.connect(g[3], 1); g[3].connect(merge, 0, 1);
    const out = c.createGain();
    merge.connect(out);
    out.connect(this.dry);
    out.connect(this.send);
    return { midi, in: inG, g, out };
  }

  /**
   * Width and position, as one 2x2 matrix.
   *
   * A grand's strings run from the bass at the player's left to the treble at
   * the right, and a pair of microphones over the soundboard hears that. The
   * recordings are all from one microphone position, so the spread has to be
   * put back -- but as a rotation of each key's own stereo image rather than
   * by panning it, or the treble would arrive mono and hard right.
   */
  refreshStrips() {
    for (let m = this.lo; m <= this.hi; m++) {
      const s = this.strips.get(m);
      const w = Math.max(0, this.width * this.curves.at('width', m));
      const place = ((m - this.lo) / (this.hi - this.lo) * 2 - 1) * this.spread * this.perspective;
      const p = Math.max(-1, Math.min(1, place + this.curves.at('pan', m)));
      const th = (p + 1) * Math.PI / 4;
      const gl = Math.cos(th), gr = Math.sin(th);
      s.g[0].gain.value = gl * (1 + w) / 2;
      s.g[1].gain.value = gl * (1 - w) / 2;
      s.g[2].gain.value = gr * (1 - w) / 2;
      s.g[3].gain.value = gr * (1 + w) / 2;
    }
  }

  rebuildRoom() {
    const { buf, energy } = renderIR(this.ctx, this.roomOpts, this.irRef);
    this.irRef ??= energy;              // the default room is the level reference
    this.conv.buffer = buf;
  }

  setLimiter(on) {
    if (on === this.limiterOn) return;
    this.limiterOn = on;
    // Disconnect the ONE edge being replaced. A bare disconnect() takes every
    // outgoing connection with it, including anything a meter or a recorder
    // has tapped off the master -- which is a silent failure, and was one.
    if (on) { this.eq.out.disconnect(this.ctx.destination); this.eq.out.connect(this.limiter); }
    else { this.eq.out.disconnect(this.limiter); this.eq.out.connect(this.ctx.destination); }
  }

  /** The last node before the destination -- what a recorder should tap. */
  outputNode() { return this.limiterOn ? this.limiter : this.eq.out; }
  setRoom(patch) { Object.assign(this.roomOpts, patch); this.rebuildRoom(); }

  // ------------------------------------------------------------------ notes --
  //
  // Every method that makes a sound takes an optional `when`. Live playing
  // leaves it out and gets ctx.currentTime, which is "as soon as possible";
  // a sequencer passes the time the note is supposed to happen and gets it
  // exactly, because a timer in a browser is good to about four milliseconds
  // and the audio clock is good to a sample. Half the events in a rendered
  // performance were arriving late before this existed.
  noteOn(midi, vel, when) {
    if (midi < this.lo || midi > this.hi) return;
    const ctx = this.ctx, now = when ?? ctx.currentTime;

    // Una corda: the hammer misses a string, so it is quieter AND softer. In a
    // sampler the "softer" has to come from reaching for a gentler recording,
    // which is the one thing a filter cannot fake.
    const soft = this.unaCorda > 0.5;
    const p = plan(this.curves, this.lib, midi, vel, soft ? -2 : 0);
    if (!p) {
      // Nothing of this key is resident yet. The KEY is still down -- the
      // damper is off it, it belongs in the sympathetic set, and letting it
      // go must still produce the mechanical sounds a key produces. Returning
      // here without recording that lost all of it, so a note struck during
      // loading was silent going down AND coming up.
      this.down.add(midi);
      this.updateUndamped();
      return null;
    }

    this.kill(midi, 0.008, now);
    const src = ctx.createBufferSource();
    src.buffer = p.buf;
    src.playbackRate.value = Math.pow(2, this.curves.at('tune', midi) / 1200);

    // Two gains, not one. `lvl` is the velocity's level and never moves again;
    // `env` is the attack and the damper fall. Keeping them apart means the
    // release curve always runs from a value this code knows exactly, rather
    // than from whatever a GainNode reports mid-automation -- which browsers
    // do not agree about.
    const lvl = ctx.createGain();
    lvl.gain.value = p.gain * (soft ? Math.pow(10, -2.5 / 20) : 1);
    const env = ctx.createGain();
    const a = this.env.noteAttack;
    const aDur = Math.max(0, a.ms) / 1000;
    if (aDur > 0.0005) {
      env.gain.setValueAtTime(1e-5, now);
      env.gain.setValueCurveAtTime(a.shape.curve(0, 1), now, aDur);
    } else {
      env.gain.value = 1;
    }
    src.connect(lvl).connect(env).connect(this.strips.get(midi).in);
    src.start(now);

    const v = { src, g: lvl, env, midi, layer: p.layer, vel, started: now,
      att: aDur > 0.0005 ? { start: now, dur: aDur, shape: a.shape } : null, rel: null,
      key: this.lib.key(midi, p.layer) };
    src.onended = () => this.forget(v);
    let list = this.voices.get(midi);
    if (!list) this.voices.set(midi, list = []);
    list.push(v);
    this.down.add(midi);
    this.updateUndamped();
    this.res.excite(midi, vel, this.pedal);
    this.prune();
    this.refreshHeld();
    return v;
  }

  noteOff(midi, relVel = 64, when) {
    if (!this.down.delete(midi)) return;
    const now = when ?? this.ctx.currentTime;
    const damped = midi <= this.topDamped && !this.sostenuto.has(midi) && !this.silent.has(midi);
    // Read the voice BEFORE killing it: kill() empties the map, and asking
    // afterwards silently handed every damper sound a velocity of 64.
    const first = this.voices.get(midi)?.[0];
    const heldFor = now - (first?.started ?? now);
    const struckAt = first?.vel ?? 64;

    // With the pedal past the point where the dampers leave the strings, a key
    // release does NOTHING to the note -- and in particular must not schedule
    // a fade, because a faded voice is one this engine has already forgotten
    // and the pedal coming up would then find nothing left to damp. That was a
    // bug: released notes under a held pedal ignored the pedal lift entirely.
    if (damped && this.pedal < UNDAMP) {
      // Continuous, so half-pedalling works: a damper resting lightly on a
      // string shortens it without stopping it.
      const base = this.damperTime(midi);
      const t = base * Math.pow(9 / base, this.pedal / UNDAMP);
      this.kill(midi, t, now);
      this.damperSound(midi, struckAt, heldFor, 1, now);
    }
    this.keyNoise(midi, relVel, heldFor, now);
    this.updateUndamped();
    this.refreshHeld();
  }

  /** How long this key's damper takes to stop its string. Bass dampers are slower. */
  damperTime(midi) {
    return 0.075 * this.curves.at('damping', midi) * (1 + Math.max(0, 76 - midi) / 55);
  }

  /** Let a key's dampers up without striking it -- the classic silent chord. */
  silentHold(midi, on) {
    on ? this.silent.add(midi) : this.silent.delete(midi);
    this.updateUndamped();
  }

  /**
   * Where a voice's envelope is right now, worked out rather than read.
   *
   * GainNode.value during a scheduled curve is not something to rely on, and
   * a release that starts from the wrong value is a step -- audible on every
   * key lift. All three states are closed-form, so there is no need to ask.
   */
  envValueAt(v, t) {
    if (v.rel) {
      const u = (t - v.rel.start) / v.rel.dur;
      if (u >= 1) return 0;
      return v.rel.from * (1 - v.rel.shape.at(Math.max(0, u)));
    }
    if (v.att) {
      const u = (t - v.att.start) / v.att.dur;
      if (u < 1) return v.att.shape.at(Math.max(0, u));
    }
    return 1;
  }

  /** Damper fall: the shape is the Bezier, the duration is the caller's. */
  kill(midi, fall, when) {
    const list = this.voices.get(midi);
    if (!list) return;
    const now = when ?? this.ctx.currentTime;
    const shape = this.env.noteRelease.shape;
    for (const v of list) {
      const from = Math.max(1e-5, this.envValueAt(v, now));
      const dur = Math.max(0.006, fall);
      v.env.gain.cancelScheduledValues(now);
      v.env.gain.setValueAtTime(from, now);
      v.env.gain.setValueCurveAtTime(shape.curve(from, 0), now, dur);
      v.rel = { start: now, dur, from, shape };
      v.att = null;
      try { v.src.stop(now + dur + 0.03); } catch { /* already stopped */ }
    }
    this.voices.delete(midi);
  }

  forget(v) {
    const list = this.voices.get(v.midi);
    if (!list) return;
    const i = list.indexOf(v);
    if (i >= 0) list.splice(i, 1);
    if (!list.length) this.voices.delete(v.midi);
  }

  prune() {
    let n = 0;
    for (const l of this.voices.values()) n += l.length;
    if (n <= MAX_VOICES) return;
    const all = [];
    for (const l of this.voices.values()) all.push(...l);
    all.sort((a, b) => a.started - b.started);
    for (let i = 0; i < n - MAX_VOICES; i++) {
      const v = all[i];
      if (this.down.has(v.midi)) continue;
      this.kill(v.midi, 0.06);
    }
  }

  // --------------------------------------------------------- mechanical bits -
  /**
   * A release sample, with its own attack and release shapes.
   *
   * The attack is not cosmetic: these play ON TOP of a note that is still
   * sounding, so switching one on at full level puts a click into the middle
   * of a decaying chord. Four milliseconds of shaped rise costs nothing and
   * removes it.
   */
  oneShot(buf, gain, rate = 1, when) {
    if (!buf || gain <= 1e-4) return;
    const ctx = this.ctx, now = when ?? ctx.currentTime;
    const total = buf.duration / rate;
    const s = ctx.createBufferSource();
    s.buffer = buf;
    s.playbackRate.value = rate;
    const g = ctx.createGain();

    const aDur = Math.min(Math.max(0, this.env.relAttack.ms) / 1000, total * 0.4);
    const rDur = Math.min(Math.max(0, this.env.relRelease.ms) / 1000, total - aDur);
    if (aDur > 0.0005) {
      g.gain.setValueAtTime(1e-5, now);
      g.gain.setValueCurveAtTime(this.env.relAttack.shape.curve(0, gain), now, aDur);
    } else {
      g.gain.setValueAtTime(gain, now);
    }
    if (rDur > 0.0005) {
      // Two value curves may not overlap, and abutting them exactly is a
      // question the specification does not answer the same way everywhere --
      // so the release starts a millisecond after the attack can have ended.
      const at = now + Math.max(aDur + 0.001, total - rDur);
      const dur = now + total - at;
      if (dur > 0.001) g.gain.setValueCurveAtTime(this.env.relRelease.shape.curve(gain, 0), at, dur);
    }
    s.connect(g).connect(this.noise);
    s.start(now);
    s.stop(now + total + 0.02);
    // Tracked so panic() can stop them. A two-second damper thud outliving a
    // panic is not a crisis, but it does make every measurement taken just
    // after one wrong.
    this.oneShots.add(s);
    s.onended = () => this.oneShots.delete(s);
  }

  /**
   * The key coming back up: a real, quiet, per-key recorded thud.
   *
   * By default this does NOT fade with how long the key was held, because the
   * key comes up the same way whether it was down for a moment or a minute --
   * this is felt, not rung. `keyNoiseFollow` is there for anyone who wants it
   * to anyway.
   */
  keyNoise(midi, relVel, heldFor, when) {
    if (this.releaseNoise <= 0) return;
    const d = this.lib.note(midi)?.release;
    const buf = this.lib.aux(d, `r${midi}`, 2);
    if (!buf) return;
    const perKey = Math.pow(10, this.curves.at('releaseLevel', midi) / 20);
    const hold = this.env.holdLevel(heldFor, this.env.hold.keyNoiseFollow);
    this.oneShot(buf, d.gain * this.db('release') * this.releaseNoise * perKey * hold * (0.25 + 0.75 * relVel / 127), 1, when);
  }

  /**
   * The damper landing on a ringing string.
   *
   * Salamander recorded this three ways and the SFZ picks between them by
   * velocity and by how long the key was held -- a string that has been
   * ringing for four seconds has much less left in it to stop, which is what
   * rt_decay describes. Both are honoured here, with the hold-time law an
   * editable curve rather than the SFZ's flat dB per second.
   */
  damperSound(midi, vel, heldFor, scale = 1, when) {
    if (this.damperNoise <= 0) return;
    const d = this.lib.note(midi)?.damper;
    if (!d) return;
    const perKey = Math.pow(10, this.curves.at('damperLevel', midi) / 20);
    const hold = this.env.holdLevel(heldFor, 1);
    const pick = (variant, key) => {
      const desc = d[variant];
      if (!desc) return;
      const buf = this.lib.aux(desc, `h${midi}${variant}`, 2);
      if (buf) this.oneShot(buf, desc.gain * this.db(key) * this.damperNoise * perKey * hold * scale * (0.3 + 0.7 * vel / 127), 1, when);
    };
    pick(vel >= 45 ? 'L' : 'S', vel >= 45 ? 'damperL' : 'damperS');
    pick('V', 'damperV');
  }

  // ------------------------------------------------------------------ pedals -
  setPedal(v, when) {
    const was = this.pedal;
    const now = when ?? this.ctx.currentTime;
    this.pedal = Math.max(0, Math.min(1, v));
    if (this.pedalNoise > 0 && (was < UNDAMP) !== (this.pedal < UNDAMP)) {
      const set = this.pedal >= UNDAMP ? this.lib.m.pedal.down : this.lib.m.pedal.up;
      const d = set[Math.random() < 0.5 ? 0 : 1] ?? set[0];
      const buf = this.lib.aux(d, `p${d?.file}`, 3);
      if (buf) this.oneShot(buf, d.gain * this.db(this.pedal >= UNDAMP ? 'pedalDown' : 'pedalUp') * this.pedalNoise, 1, now);
    }
    // Coming off the pedal drops every damper that no key is holding. A whole
    // frame of dampers landing at once is an audible event on a real piano, so
    // the loudest few get their damper sound -- but only a few, because twenty
    // at once is a wall of noise and not a piano.
    if (was >= UNDAMP && this.pedal < UNDAMP) {
      const landed = [];
      for (let m = this.lo; m <= this.topDamped; m++) {
        if (this.down.has(m) || this.sostenuto.has(m) || this.silent.has(m)) continue;
        const v = this.voices.get(m)?.[0];
        if (!v) continue;
        landed.push({ m, v });
        this.kill(m, this.damperTime(m) * 1.2, now);
      }
      landed.sort((a, b) => b.v.started - a.v.started);
      for (const { m, v } of landed.slice(0, 6)) {
        this.damperSound(m, v.vel, now - v.started, 0.5, now);
      }
    }
    this.updateUndamped();
  }

  setSostenuto(on) {
    this.sostenuto = on ? new Set([...this.down].filter((m) => m <= this.topDamped)) : new Set();
    this.updateUndamped();
  }

  setUnaCorda(v) { this.unaCorda = v; }

  /**
   * Which strings are free to ring.
   *
   * The top twenty keys of a grand have no dampers at all, so they are always
   * in this set -- which is most of where a piano's shimmer comes from, and
   * costs nothing to get right.
   */
  updateUndamped() {
    const u = new Set();
    for (let m = this.topDamped + 1; m <= this.hi; m++) u.add(m);
    for (const m of this.down) u.add(m);
    for (const m of this.silent) u.add(m);
    for (const m of this.sostenuto) u.add(m);
    if (this.pedal >= UNDAMP) for (let m = this.lo; m <= this.topDamped; m++) u.add(m);
    this.undamped = u;
    this.res.setUndamped(u);
  }

  refreshHeld() {
    const h = new Set();
    for (const l of this.voices.values()) for (const v of l) h.add(v.key);
    this.res.heldKeys(h);
    this.lib.setHeld(h);
  }

  panic() {
    for (const s of this.oneShots) { try { s.stop(); } catch { /* already done */ } }
    this.oneShots.clear();
    for (const m of [...this.voices.keys()]) this.kill(m, 0.04);
    this.down.clear(); this.silent.clear(); this.sostenuto.clear();
    this.res.allOff();
    this.updateUndamped();
  }

  tick(dt) { this.res.tick(dt); }

  stats() {
    let n = 0;
    for (const l of this.voices.values()) n += l.length;
    return { voices: n, resonating: this.res.voices.size, undamped: this.undamped.size };
  }
}
