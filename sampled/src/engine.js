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
import { plan, VelCurve, VelLayerCurve } from './velocity.js';
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
    this.soloRes = false;      // resonance solo: see setSoloRes()
    // Attack alignment. Salamander's recordings do not all hit at the same
    // distance into the file -- the build trims each head at a level
    // threshold, which lines up where silence ends rather than where the note
    // arrives, and on this library the attack front ranges from 5 ms to 59 ms
    // in. Played as they are, the keys do not feel the same under the hand.
    // `align.mjs` measures each sample's front and the manifest carries it;
    // playback starts each one so that every front lands `alignMs` after the
    // key goes down. A sample that is late is started further in, one that is
    // early is held back by the difference, so nothing is cut that does not
    // have to be and the worst delay is a few milliseconds.
    this.alignStarts = lib.m.alignMs != null;
    this.alignMs = lib.m.alignMs ?? 0;

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
    // ...and through the solo mute, so "solo resonance" silences it with the
    // struck notes rather than leaving key and pedal thuds on their own.
    this.noiseSolo = ctx.createGain();
    this.noise.connect(this.noiseSolo);
    this.noiseSolo.connect(this.dry); this.noiseSolo.connect(this.send);

    // There is no pedal-action sample and no reverb for one. Salamander's
    // pedal recordings are a mechanism being worked, not an instrument
    // responding: the same two files however you use the pedal, with a room
    // and a frame ringing in them that are not this room or this frame. What
    // they were standing in for -- the whole undamped frame lighting up when
    // the pedal goes down -- is something this engine already does properly,
    // string by string, through the resonance accumulator and the soundboard
    // reverb. Playing a recording of it on top was two answers to one question.

    // The soundboard. Sympathetic resonance is fed continuously into a long
    // reverb, so that when the pedal lifts and the dampers cut the strings, the
    // energy already in the body keeps ringing for a few seconds -- the whole
    // instrument resonating, not just the strings that were free. It is what
    // turns a pedal-off from a cut into a decay.
    this.sbSend = ctx.createGain();
    this.sbSend.gain.value = 1;
    this.sbConv = ctx.createConvolver();
    this.sbConv.normalize = false;
    this.sbGain = ctx.createGain();
    this.sbGain.gain.value = 0.5;          // soundboard tail level
    this.sbSend.connect(this.sbConv).connect(this.sbGain).connect(this.master);
    this.sbTailSec = 4.5;                   // how long the body rings, in seconds
    this.rebuildSoundboard();

    // Salamander's own levels for the auxiliary samples (see build.mjs). The
    // key-release recordings sit at full scale in the file and the SFZ takes
    // 37 dB back off; playing them at face value makes every key lift sound
    // like a dropped hammer, which is exactly what it did before this.
    this.mix = lib.m.mixDb ?? { release: -37, damperL: -4, damperS: -4, damperV: 0 };
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
    this.spread = 0;            // no artificial spread by default -- just the swap
    this.width = 1;
    this.perspective = 1;           // +1 player's view (bass left), -1 audience
    this.releaseNoise = 0.9;
    // What fraction of the key-release recording to play when the string is NOT
    // being damped (pedal held). The recording is mostly the damper stopping
    // the string; with the pedal down that must not be heard, so only a hint of
    // the mechanical key return is left. Set to 0 for silence.
    this.pedalReleaseNoise = 0.2;
    // Round robin for the mechanical samples. `relStartTrim` shaves a fixed few
    // ms off the front of every release/damper sample; `relRoundRobin` adds a
    // random few ms on top, per play, so the same key let go twice does not
    // play the identical file and machine-gun. Both in milliseconds.
    this.relStartTrim = 0;
    this.relRoundRobin = 3;
    // How long, in ms, to hold the damper OFF the string after the key is
    // released before letting it fall. The recorded release sample's audible
    // thud arrives a hair after the key actually leaves, so damping the note at
    // the exact instant of release leaves a tiny gap -- note gone, then thud.
    // A millisecond of overlap closes it. The release sample itself still fires
    // on the key-up, so only the note's own stop is nudged.
    this.releaseDelay = 1;
    this.damperNoise = 1;
    this.held = new Set();

    // The hand-drawn velocity curves, shared with the editors in the UI: one
    // maps velocity -> layer (always active), the other is an optional override
    // of the per-velocity volume.
    this.velCurve = new VelCurve();
    this.velLayer = VelLayerCurve.fromHivel(lib.m.hivel, lib.layers);

    this.res = new Resonance(ctx, lib, curves, (m) => this.strips.get(m).in, this.env, this.sbSend);
    this.refreshStrips();
    this.updateUndamped();
  }

  // ------------------------------------------------------------- the strip --
  //
  // The FIRST thing every key's audio meets is a channel swap. The Salamander
  // recordings are reversed -- a key on the right of the keyboard sits on the
  // LEFT of the stereo image -- so left and right are exchanged here, once, at
  // the input, before anything else touches the placement. After the swap the
  // treble really is on the right, and the spread below can push it further.
  makeStrip(midi) {
    const c = this.ctx;
    const inG = c.createGain();
    // Everything the player strikes -- the note, its release sample, its
    // damper -- enters through `direct`, which the resonance solo closes.
    // Sympathetic voices connect to `in` past it, so they survive the mute.
    const direct = c.createGain();
    direct.connect(inG);
    const split = c.createChannelSplitter(2);
    const merge = c.createChannelMerger(2);
    const g = [c.createGain(), c.createGain(), c.createGain(), c.createGain()];   // LL, RL, LR, RR
    inG.connect(split);
    // The matrix is fed the SWAPPED channels: g[0]/g[2] take the recording's
    // right (splitter output 1), g[1]/g[3] its left (output 0).
    split.connect(g[0], 1); g[0].connect(merge, 0, 0);
    split.connect(g[1], 0); g[1].connect(merge, 0, 0);
    split.connect(g[2], 1); g[2].connect(merge, 0, 1);
    split.connect(g[3], 0); g[3].connect(merge, 0, 1);
    const out = c.createGain();
    merge.connect(out);
    out.connect(this.dry);
    out.connect(this.send);
    return { midi, in: inG, direct, g, out };
  }

  /**
   * Width and position, as one 2x2 matrix, over the already-swapped stereo.
   *
   * At spread 0 nothing is placed: each key keeps its own (corrected) stereo
   * image. Spread is a per-key pan proportional to where the key sits on the
   * keyboard -- positive pushes the treble further right and the bass further
   * left, widening the instrument; negative mirrors it, sending the treble
   * left. Width is a rotation of each key's own image rather than a pan, so a
   * spread key does not collapse to one side.
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

  /** The pedal's own long reverb: the room's geometry, a much longer decay. */
  /** The soundboard's own long, dark impulse -- the body, not the room. */
  rebuildSoundboard() {
    const { buf } = renderIR(this.ctx,
      { ...this.roomOpts, rt60: Math.max(0.5, this.sbTailSec), tailDampHz: 2200 },
      this.irRef ?? undefined);
    this.sbConv.buffer = buf;
  }

  setSoundboardTail(sec) { this.sbTailSec = sec; this.rebuildSoundboard(); }

  setLimiter(on) {
    if (on === this.limiterOn) return;
    this.limiterOn = on;
    // Disconnect the ONE edge being replaced. A bare disconnect() takes every
    // outgoing connection with it, including anything a meter or a recorder
    // has tapped off the master -- which is a silent failure, and was one.
    if (on) { this.eq.out.disconnect(this.ctx.destination); this.eq.out.connect(this.limiter); }
    else { this.eq.out.disconnect(this.limiter); this.eq.out.connect(this.ctx.destination); }
  }

  /**
   * Solo the sympathetic resonance: mute every direct path -- the struck
   * notes, their release and damper samples, the mechanical noise and the
   * samples -- and leave the resonance voices and the soundboard
   * sounding. It is a monitoring switch for setting this section up by ear,
   * not a setting: nothing persists it, so the instrument always starts unsoloed.
   *
   * Every mute is a short ramp rather than a jump, because closing a gain
   * under a ringing chord instantaneously is a click.
   */
  setSoloRes(on) {
    if (on === this.soloRes) return;
    this.soloRes = on;
    const t = this.ctx.currentTime, v = on ? 0 : 1;
    const ramp = (g) => {
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(g.gain.value, t);
      g.gain.linearRampToValueAtTime(v, t + 0.02);
    };
    for (const strip of this.strips.values()) ramp(strip.direct);
    ramp(this.noiseSolo);
  }

  /** The last node before the destination -- what a recorder should tap. */
  outputNode() { return this.limiterOn ? this.limiter : this.eq.out; }
  setRoom(patch) { Object.assign(this.roomOpts, patch); this.rebuildRoom(); this.rebuildSoundboard(); }

  /**
   * Where in the buffer to start this note, and how long to wait first.
   *
   * Returns seconds: `offset` into the recording, `delay` before starting it.
   * Only one of the two is ever non-zero -- a sample whose front is late is
   * skipped into, one whose front is early is held back -- and the per-key
   * `Sample start` offset is added to the same number, so a key that still
   * feels out of step can be nudged by hand.
   */
  startAt(midi, p) {
    const align = this.alignStarts && p.t0 != null ? (p.t0 - this.alignMs) / 1000 : 0;
    const want = align + this.curves.at('startTrim', midi) / 1000;
    // Never skip so far in that the note is a fragment: half the recording is
    // far past anything alignment needs and is a guard against a bad manifest.
    const offset = Math.max(0, Math.min(want, p.buf.duration * 0.5));
    return { offset, delay: Math.max(0, Math.min(0.25, -want)) };
  }

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
    const p = plan(this.curves, this.lib, midi, vel, soft ? -2 : 0, this.velCurve, this.velLayer);
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

    // Re-striking a key. If a damper is going to catch this string -- pedal up,
    // an ordinary key -- the hammer hits the same string and the note that was
    // there stops, so the old voice is faded out fast. But with the pedal down
    // (or an undamped key) the string is free, and hitting the same note again
    // must PILE UP the way it does on a real piano rather than cut off what was
    // ringing: the old voice is left to sound and the new one overlaps it.
    // prune() caps total polyphony, so a fast repeated note cannot run away.
    const willRing = this.pedal >= UNDAMP || midi > this.topDamped
      || this.sostenuto.has(midi) || this.silent.has(midi);
    if (!willRing) this.kill(midi, 0.008, now);
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
    // Alignment first: everything below is timed from when the note actually
    // starts, which is a few milliseconds after `now` for a recording whose
    // attack front is early.
    const at = this.startAt(midi, p);
    const t0 = now + at.delay;
    const a = this.env.noteAttack;
    const aDur = Math.max(0, a.ms) / 1000;
    // Starting a recording partway in starts it at a level, not at silence,
    // which is a click. The alignment cuts at the -20 dB point of the attack,
    // so the step is real but small: a fade of a millisecond and a half covers
    // it and is far too short to be heard as an attack of its own. A note
    // attack the player has actually dialled in is longer than this and wins.
    const fade = at.offset > 0.001 ? 0.0015 : 0;
    if (aDur > 0.0005) {
      env.gain.setValueAtTime(1e-5, t0);
      env.gain.setValueCurveAtTime(a.shape.curve(0, 1), t0, aDur);
    } else if (fade > 0) {
      env.gain.setValueAtTime(0, t0);
      env.gain.linearRampToValueAtTime(1, t0 + fade);
    } else {
      env.gain.value = 1;
    }
    src.connect(lvl).connect(env).connect(this.strips.get(midi).direct);
    src.start(t0, at.offset);

    const v = { src, g: lvl, env, midi, layer: p.layer, vel, started: now,
      att: aDur > 0.0005 ? { start: t0, dur: aDur, shape: a.shape } : null, rel: null,
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
    // Does a damper actually land on this string now? Only if the key has a
    // damper AND nothing is holding it off -- the sustain pedal, sostenuto, or
    // a silent hold. With the pedal down the string rings on untouched.
    const stringDamped = damped && this.pedal < UNDAMP;
    if (stringDamped) {
      // The note keeps ringing for `releaseDelay` ms after the key leaves, so
      // its damper falls in step with the release sample instead of a hair
      // ahead of it.
      const relNow = now + Math.max(0, this.releaseDelay) / 1000;
      // Continuous, so half-pedalling works: a damper resting lightly on a
      // string shortens it without stopping it.
      const base = this.damperTime(midi);
      const t = base * Math.pow(9 / base, this.pedal / UNDAMP);
      this.kill(midi, t, relNow);
      this.damperSound(midi, struckAt, heldFor, 1, relNow);
    }
    // The key-release recording is the key returning AND its damper stopping
    // the string. When no damper lands -- pedal held -- playing it at full
    // level puts that damping sound onto a note that is still ringing, which is
    // heard as the note being cut off. Drop it to just the mechanical key
    // return in that case; the string keeps singing under the pedal.
    this.keyNoise(midi, relVel, heldFor, now, stringDamped ? 1 : this.pedalReleaseNoise);
    this.updateUndamped();
    this.refreshHeld();
  }

  /** A jittered start offset (seconds) for a mechanical sample: the round robin. */
  relOffset() { return (this.relStartTrim + Math.random() * this.relRoundRobin) / 1000; }

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
  oneShot(buf, gain, rate = 1, when, offset = 0, dest = this.noise) {
    if (!buf || gain <= 1e-4) return;
    const ctx = this.ctx, now = when ?? ctx.currentTime;
    // Trim the start of the sample. A few milliseconds off the front does not
    // change what the thud is, but it lands the waveform on a different sample
    // every time -- which is a fake round robin: the same key released twice in
    // a row no longer plays byte-for-byte the same recording, so it does not
    // machine-gun. Clamped well short of the sample so there is always sound.
    offset = Math.max(0, Math.min(offset, buf.duration * 0.5));
    const total = (buf.duration - offset) / rate;
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
      // Two value curves may not overlap, and setValueCurveAtTime rounds its END
      // up to the next 128-sample render quantum (~2.7 ms at 48 kHz) -- so the
      // release must start a clear quantum-plus after the attack could have
      // ended, not the 1 ms this used to leave, or on a short sample the two
      // overlap and setValueCurveAtTime throws (dropping the release sound).
      const at = now + Math.max(aDur + 0.006, total - rDur);
      const dur = now + total - at;
      if (dur > 0.001) g.gain.setValueCurveAtTime(this.env.relRelease.shape.curve(gain, 0), at, dur);
    }
    s.connect(g).connect(dest);
    s.start(now, offset);
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
  keyNoise(midi, relVel, heldFor, when, scale = 1) {
    if (this.releaseNoise <= 0 || scale <= 1e-4) return;
    const d = this.lib.note(midi)?.release;
    const buf = this.lib.aux(d, `r${midi}`, 2);
    if (!buf) return;
    const perKey = Math.pow(10, this.curves.at('releaseLevel', midi) / 20);
    const hold = this.env.holdLevel(heldFor, this.env.hold.keyNoiseFollow);
    // Through the key's own strip, so the release sample gets the same stereo
    // swap, placement and spread as the note it belongs to.
    this.oneShot(buf, d.gain * this.db('release') * this.releaseNoise * scale * perKey * hold * (0.25 + 0.75 * relVel / 127), 1, when, this.relOffset(), this.strips.get(midi).direct);
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
      if (buf) this.oneShot(buf, desc.gain * this.db(key) * this.damperNoise * perKey * hold * scale * (0.3 + 0.7 * vel / 127), 1, when, this.relOffset(), this.strips.get(midi).direct);
    };
    pick(vel >= 45 ? 'L' : 'S', vel >= 45 ? 'damperL' : 'damperS');
    pick('V', 'damperV');
  }

  // ------------------------------------------------------------------ pedals -
  setPedal(v, when) {
    const was = this.pedal;
    const now = when ?? this.ctx.currentTime;
    this.pedal = Math.max(0, Math.min(1, v));
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
