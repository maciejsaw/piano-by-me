// The instrument: voices, channel strips, pedals, and the room they sit in.
//
// The graph is built once and then only has its numbers moved, because
// creating nodes on a note-on is how a sampler gets its first glitch.
//
//   voice ──► voiceGain ──┐
//                          ├─► [ per-key channel strip ] ──┬─► dry ──────► master ──► out
//   sympathetic voice ────┘        width matrix, then      └─► send ─┬─► expander ──► early reflections ──► gate ──► wet ──┤
//                                  position, then trim               └─► expander ──► hall ─────────────── ► gate ──► wet ──┘
//
// Two reverbs on the one send, in the order sound meets them: the early
// reflections (fdn-room.js -- the modelled piano's image-source room, kept
// short), then the hall's long late tail (hall.js, or an IR file). Each has its
// own expander (expander-worklet.js) shaping only what that reverb hears, its
// own level and its own switch. The dry path never sees either. Both are
// convolutions, so a reverb that is off costs nothing once its input is cut.
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
import { renderFdnIR, FDN_DEFAULTS } from './fdn-room.js';
import { renderHallIR, HALL_DEFAULTS, energyOf } from './hall.js';
import { Envelopes } from './envelopes.js';
import { Eq } from './eq.js';
import { StreamSource } from './stream.js';

const MAX_VOICES = 64;

// Where the dampers come clear of the strings. Below this the pedal is
// shortening notes rather than sustaining them, which is what half-pedalling
// is; at or above it the string is free and nothing should be touching it.
const UNDAMP = 0.35;

/** Register the engine's own audio-thread processors. Await before `new Engine`. */
export function loadWorklets(ctx) {
  return ctx.audioWorklet.addModule(new URL('./expander-worklet.js', import.meta.url));
}

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
    // Scheduling lookahead for live events. ctx.currentTime is the start of the
    // quantum the audio thread LAST rendered, not the next one, so anything
    // scheduled "at currentTime" lands up to a render callback late -- and a
    // gain curve that starts in the past is joined partway through, which is a
    // step. On the 4 ms release-sample attack, the 1.5 ms alignment fade and a
    // treble damper that is most of the way down in 20 ms, that step is the
    // click on key-up. It got worse under load (the warm-up decodes, GC),
    // because that is when the callbacks run late. A few ms of lookahead puts
    // every curve in the future, where it is played from its start.
    this.lookahead = 0.006;

    this.dry = ctx.createGain(); this.dry.connect(this.master);
    this.send = ctx.createGain();
    this.early = this.makeReverb(0.95, true);
    this.fdnOpts = { ...FDN_DEFAULTS };
    // Level reference: this room as it was when its level was tuned, with a
    // 1.25 s tail. Taking it from the (now short) default would make every
    // saved level louder than it was set.
    this.fdnRef = renderFdnIR(ctx, { ...FDN_DEFAULTS, rt60: 1.25 }).energy;
    this.rebuildFdnRoom();
    // The hall's `conv` and `wet` are also engine.conv / engine.wet -- the
    // render and test tools reach for engine.wet.
    const h = this.makeReverb(1.09, true);
    this.hall = h; this.conv = h.conv; this.wet = h.wet;
    this.hallOpts = { ...HALL_DEFAULTS };
    // Level reference: a hall with the old room's reference RT60 of 1.35 s, so
    // a saved hall level means about what it did against the old room.
    this.hallRef = renderHallIR(ctx, { ...HALL_DEFAULTS, rt60: 1.35 }).energy;
    this.hallFile = null;               // a loaded IR, which replaces the synthetic hall
    this.rebuildHall();

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
    this.pedal = 0;                 // 0..1, continuous: half-pedal is real
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
    // A trimmed sample starts in the middle of its own sound, so the cut needs
    // a fade -- and that fade has to be IN THE AUDIO, not on a GainNode. A gain
    // curve runs on the context clock; a source that starts late (the key-up
    // reached the audio thread after its time, under GC or a busy main thread)
    // still starts at its offset, but the curve has already moved on, so the
    // sound comes in at full level. Untrimmed, the file starts in silence and
    // that lateness is inaudible; trimmed 100 ms into the thud, it is a click.
    // A raised cosine this long is written into a copy of the trimmed buffer,
    // so it plays wherever the audio actually starts.
    this.relTrimFade = 0.006;
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
    this.res.lookahead = this.lookahead;
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

  /**
   * send -> expander -> convolver -> gate -> wet -> master. The gate is the
   * on/off switch. The expander needs expander-worklet.js registered on the
   * context first: see loadWorklets().
   */
  makeReverb(level, on) {
    const c = this.ctx;
    const exp = new AudioWorkletNode(c, 'send-expander', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
    });
    const conv = c.createConvolver();
    conv.normalize = false;
    const gate = c.createGain(); gate.gain.value = on ? 1 : 0;
    const wet = c.createGain(); wet.gain.value = level;
    exp.connect(conv).connect(gate).connect(wet).connect(this.master);
    if (on) this.send.connect(exp);
    return { exp, conv, gate, wet, on, timer: 0 };
  }

  /**
   * Switch a room in or out. The gate ramps rather than jumps, because
   * closing a gain under a ringing tail instantaneously is a click; once it
   * is shut the send is cut too, so a room that is off stops convolving.
   */
  setReverbOn(r, on) {
    if (on === r.on) return;
    r.on = on;
    clearTimeout(r.timer);
    const t = this.ctx.currentTime;
    r.gate.gain.cancelScheduledValues(t);
    r.gate.gain.setValueAtTime(r.gate.gain.value, t);
    r.gate.gain.linearRampToValueAtTime(on ? 1 : 0, t + 0.03);
    if (on) {
      try { this.send.connect(r.exp); } catch { /* already connected */ }
    } else {
      r.timer = setTimeout(() => {
        if (!r.on) try { this.send.disconnect(r.exp); } catch { /* not connected */ }
      }, 60);
    }
  }

  /** A room's send expander: ratio (1 is none), threshold dB, attack and release ms. */
  setSendExpander(r, patch) {
    const p = r.exp.parameters;
    for (const k of ['ratio', 'threshold', 'attack', 'release']) {
      if (patch[k] != null) p.get(k).value = patch[k];
    }
  }

  setHallOn(on) { this.setReverbOn(this.hall, on); }
  setEarlyOn(on) { this.setReverbOn(this.early, on); }

  rebuildFdnRoom() {
    const { buf } = renderFdnIR(this.ctx, this.fdnOpts, this.fdnRef);
    this.early.conv.buffer = buf;
  }

  setFdnRoom(patch) { Object.assign(this.fdnOpts, patch); this.rebuildFdnRoom(); }

  rebuildHall() {
    const { buf } = renderHallIR(this.ctx, this.hallOpts, this.hallRef);
    this.synthHall = buf;
    if (!this.hallFile) this.hall.conv.buffer = buf;
  }

  setHall(patch) { Object.assign(this.hallOpts, patch); this.rebuildHall(); }

  /**
   * Use a captured impulse response for the hall, or null to go back to the
   * synthetic one. Levelled to the same energy as the synthetic hall as it is
   * currently set, so switching between them does not jump in level.
   */
  setHallIR(buffer) {
    if (buffer) {
      const g = Math.sqrt(energyOf(this.synthHall) / Math.max(energyOf(buffer), 1e-12));
      const b = this.ctx.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
      for (let c = 0; c < buffer.numberOfChannels; c++) {
        const src = buffer.getChannelData(c), dst = b.getChannelData(c);
        for (let i = 0; i < src.length; i++) dst[i] = src[i] * g;
      }
      this.hallFile = b;
    } else this.hallFile = null;
    this.hall.conv.buffer = this.hallFile ?? this.synthHall;
  }

  /**
   * The soundboard's own long, dark impulse -- the body, not the room. It
   * keeps the geometry the old room had when it was tuned (size 0.83,
   * absorption 0.51, listener at 0.87), and that room's default as its level
   * reference, so moving the reverbs does not move the body.
   */
  rebuildSoundboard() {
    this.sbRef ??= renderIR(this.ctx, ROOM_DEFAULTS).energy;
    const { buf } = renderIR(this.ctx, {
      ...ROOM_DEFAULTS,
      width: 7.2 * 0.83, depth: 9.5 * 0.83, height: 3.8 * Math.sqrt(0.83),
      absorption: 0.51, distance: 0.87,
      rt60: Math.max(0.5, this.sbTailSec), tailDampHz: 2200,
    }, this.sbRef);
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
    const offset = Math.max(0, Math.min(want, p.dur * 0.5));
    return { offset, delay: Math.max(0, Math.min(0.25, -want)) };
  }

  /** When a live event with no `when` should happen: just ahead of the audio thread. */
  time(when) { return when ?? this.ctx.currentTime + this.lookahead; }

  // ------------------------------------------------------------------ notes --
  //
  // Every method that makes a sound takes an optional `when`. Live playing
  // leaves it out and gets "as soon as possible" -- time(), a few ms ahead;
  // a sequencer passes the time the note is supposed to happen and gets it
  // exactly, because a timer in a browser is good to about four milliseconds
  // and the audio clock is good to a sample. Half the events in a rendered
  // performance were arriving late before this existed.
  noteOn(midi, vel, when) {
    if (midi < this.lo || midi > this.hi) return;
    const ctx = this.ctx, now = this.time(when);

    const p = plan(this.curves, this.lib, midi, vel, 0, this.velCurve, this.velLayer);
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
      || this.silent.has(midi);
    if (!willRing) this.kill(midi, 0.008, now);
    // A streamed sample: its head is already decoded, the rest is decoded by
    // the stream worker as it plays. Used exactly like a buffer source.
    const src = new StreamSource(this.lib.streamer, p.key, p.frames);
    src.playbackRate.value = Math.pow(2, this.curves.at('tune', midi) / 1200);

    // Three gains in a row, each with one job. `lvl` is the velocity's level
    // and never moves again; `att` runs the attack and nothing else; `rel` sits
    // at exactly 1 until the damper falls, then runs 1 -> 0. The release never
    // has to cancel a running curve or work out where one has got to: it
    // always starts from the static 1 it is sitting at. So a note-off that
    // reaches the audio thread late -- scheduled for a time already past --
    // is clamped to the present and simply starts the same smooth fall a few
    // milliseconds later, instead of jumping to a guessed value. No step, no
    // click, however loaded the main thread is.
    const lvl = ctx.createGain();
    lvl.gain.value = p.gain;
    const att = ctx.createGain();
    const rel = ctx.createGain();
    rel.gain.value = 1;
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
    // it and is far too short to be heard as an attack of its own. It is done
    // by the voice itself, on the samples it actually plays first, so a start
    // that reaches the audio thread late still fades in (see relTrimFade).
    const fade = at.offset > 0 ? 0.0015 : 0;
    if (aDur > 0.0005) {
      att.gain.setValueAtTime(1e-5, t0);
      att.gain.setValueCurveAtTime(a.shape.curve(0, 1), t0, aDur);
    } else {
      att.gain.value = 1;
    }
    src.connect(lvl).connect(att).connect(rel).connect(this.strips.get(midi).direct);
    src.start(t0, at.offset, fade);

    // `rel` on the voice is the release gain; `releasing` says whether it has
    // been set going.
    const v = { src, g: lvl, att, rel, releasing: false, midi, layer: p.layer, vel, started: now,
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
    const now = this.time(when);
    const damped = midi <= this.topDamped && !this.silent.has(midi);
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
    // damper AND nothing is holding it off -- the sustain pedal or a silent
    // hold. With the pedal down the string rings on untouched.
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
   * Damper fall: the shape is the Bezier, the duration is the caller's.
   *
   * Only the voice's release gain moves, and it is always at rest at 1 when
   * this runs, so the fall is always the same 1 -> 0 curve. The attack gain is
   * left alone -- if the note is still rising the two just multiply. The
   * damper sound is started at the same `when` by the caller, so the note
   * fading out and the thud fading in stay in step.
   */
  kill(midi, fall, when) {
    const list = this.voices.get(midi);
    if (!list) return;
    const now = this.time(when);
    const curve = this.env.noteRelease.shape.curve(1, 0);
    const dur = Math.max(0.006, fall);
    for (const v of list) {
      if (v.releasing) continue;
      v.releasing = true;
      // A start time already in the past is clamped to the present by the
      // audio thread, and the curve's first value is the 1 the gain is
      // already at -- so a late call starts late, it does not jump.
      try { v.rel.gain.setValueCurveAtTime(curve, now, dur); }
      catch { v.rel.gain.setTargetAtTime(0, now, dur / 4); }
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
   * `buf` from `offset` seconds on, with a raised-cosine fade-in written into
   * its first `relTrimFade` seconds. A fresh buffer per play: these samples
   * are a fraction of a second to two seconds long, and the copy is a memcpy.
   */
  cutWithFade(buf, offset) {
    const from = Math.round(offset * buf.sampleRate);
    const n = buf.length - from;
    const out = this.ctx.createBuffer(buf.numberOfChannels, n, buf.sampleRate);
    const f = Math.min(Math.round(this.relTrimFade * buf.sampleRate), n >> 2);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = out.getChannelData(c);
      d.set(buf.getChannelData(c).subarray(from));
      for (let i = 0; i < f; i++) d[i] *= 0.5 - 0.5 * Math.cos(Math.PI * i / f);
    }
    return out;
  }

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
    const ctx = this.ctx, now = this.time(when);
    // Trim the start of the sample. A few milliseconds off the front does not
    // change what the thud is, but it lands the waveform on a different sample
    // every time -- which is a fake round robin: the same key released twice in
    // a row no longer plays byte-for-byte the same recording, so it does not
    // machine-gun. Clamped well short of the sample so there is always sound.
    offset = Math.max(0, Math.min(offset, buf.duration * 0.5));
    const total = (buf.duration - offset) / rate;
    const s = ctx.createBufferSource();
    // Trimmed: play a copy that starts at the cut and fades in there, rather
    // than the original from an offset (see relTrimFade).
    s.buffer = offset > 0 ? this.cutWithFade(buf, offset) : buf;
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
    const now = this.time(when);
    this.pedal = Math.max(0, Math.min(1, v));
    // Coming off the pedal drops every damper that no key is holding. A whole
    // frame of dampers landing at once is an audible event on a real piano, so
    // the loudest few get their damper sound -- but only a few, because twenty
    // at once is a wall of noise and not a piano.
    if (was >= UNDAMP && this.pedal < UNDAMP) {
      const landed = [];
      for (let m = this.lo; m <= this.topDamped; m++) {
        if (this.down.has(m) || this.silent.has(m)) continue;
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
    this.down.clear(); this.silent.clear();
    this.res.allOff();
    this.updateUndamped();
  }

  tick(dt) { this.res.tick(dt, this.sounding(), this.pedal); }

  /**
   * The notes that are still ringing freely, and how far into their own decay
   * each one is. This is what the resonance engine drives its coupled strings
   * from, every tick, for as long as the notes last -- a string does not stop
   * pushing the bridge the moment the hammer leaves it.
   *
   * `this.voices` is exactly the right set to read: kill() removes a voice the
   * instant its damper lands, so a damped note stops driving by itself, and a
   * note held under the pedal stays here and goes on driving. Voices already
   * in release are skipped; they are on their way out and are not the string.
   */
  sounding() {
    const now = this.ctx.currentTime, out = [];
    for (const [midi, list] of this.voices) {
      for (const v of list) {
        if (v.releasing) continue;
        out.push({ midi, vel: v.vel, t: now - v.started });
      }
    }
    return out;
  }

  stats() {
    let n = 0;
    for (const l of this.voices.values()) n += l.length;
    return { voices: n, resonating: this.res.voices.size, undamped: this.undamped.size };
  }
}
