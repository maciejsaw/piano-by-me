// Main-thread half of `piano-voices` (stream-worklet.js): every voice played
// by one AudioWorkletNode, with its gains, a resonance string's filters and
// the key's strip done there in JS instead of in native nodes of its own.
//
// It hands the engine and the resonance objects shaped like the ones they
// already use -- a source with start / stop / resume / onended /
// playbackRate, gain "nodes" whose `gain` has the AudioParam calls, filter
// "nodes" whose `frequency` has them -- so the same code drives either path
// (engine.renderer chooses). Every call is posted to the audio thread; all
// the calls made in one task go as one message, sent when the task is done.
//
// A param keeps a copy of its timeline here (automation.js), so it refuses
// what Chrome would refuse, at the call, and can say what its value is.
import { Timeline } from './automation.js';
import { newVoiceId } from './stream.js';

class Param {
  constructor(r, kind, id, index, value) {
    this.r = r; this.kind = kind; this.id = id; this.index = index;
    this.tl = new Timeline(value);
  }
  call(method, args) {
    const now = this.r.now();
    this.tl.prune(now * this.r.sr, this.r.sr);
    this.tl[method](...args, now);          // throws where Chrome would
    this.r.post(['p', this.kind, this.id, this.index, method, args, now]);
    return this;
  }
  get value() { return this.tl.valueAt(this.r.now()); }
  set value(v) { this.call('setValueAtTime', [v, this.r.now()]); }
  setValueAtTime(v, t) { return this.call('setValueAtTime', [v, t]); }
  linearRampToValueAtTime(v, t) { return this.call('linearRampToValueAtTime', [v, t]); }
  setTargetAtTime(v, t, tau) { return this.call('setTargetAtTime', [v, t, tau]); }
  setValueCurveAtTime(curve, t, dur) { return this.call('setValueCurveAtTime', [Float32Array.from(curve), t, dur]); }
  cancelScheduledValues(t) { return this.call('cancelScheduledValues', [t]); }
}

/** Stands where a native node stood: calls on it go to the renderer, connections are already made. */
class Node {
  constructor(name, param) { this[name] = param; }
  connect(x) { return x; }
  disconnect() {}
}

/** A voice, used like StreamSource. `lvl`, `att`, `rel`: its three gains. */
export class RVoice {
  constructor(r, key, total, strip, chain) {
    this.r = r;
    this.id = newVoiceId();
    this.onended = null;
    r.post(['v', this.id, key, total, strip, chain ? chain.id : 0]);
    r.live.set(this.id, this);
    this.lvl = new Node('gain', new Param(r, 'v', this.id, 0, 1));
    this.att = new Node('gain', new Param(r, 'v', this.id, 1, 1));
    this.rel = new Node('gain', new Param(r, 'v', this.id, 2, 1));
    let rate = 1;
    const id = this.id;
    this.playbackRate = {
      get value() { return rate; },
      set value(v) { rate = v; r.post(['rate', id, v]); },
    };
    this.key = key;
  }
  connect(x) { return x; }
  disconnect() {}
  start(when = 0, offset = 0, fade = 0, curve = null) { this.r.post(['s', this.id, when, offset, fade, curve]); }
  stop(when = 0) { this.r.post(['x', this.id, when]); }
  resume() { this.r.post(['r', this.id]); }
}

export class VoiceRenderer {
  /**
   * @param streamer  the Streamer, whose worklet module has the processor
   * @param now       () => the audio clock, which a native param clamps
   *                  times in the past to
   */
  constructor(streamer, now = () => streamer.ctx.currentTime) {
    const ctx = streamer.ctx;
    this.streamer = streamer;
    this.now = now;
    this.sr = ctx.sampleRate;
    this.node = new AudioWorkletNode(ctx, 'piano-voices', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    this.ops = [];
    this.live = new Map();        // id -> RVoice, until it ends
    this.nextChain = 1;
    this.directs = new Map();     // midi -> Node with the strip's `direct` gain
    this.node.port.onmessage = (e) => {
      const d = e.data;
      for (let i = 0; i < d.length; i += 2) {
        const v = this.live.get(d[i]);
        if (!v) continue;
        this.live.delete(d[i]);
        if (d[i + 1]) {
          streamer.underruns++;
          console.warn(`sampled: stream underrun on ${v.key} (${d[i + 1]} samples)`);
        }
        v.onended?.();
      }
    };
  }

  post(op) {
    this.ops.push(op);
    if (this.ops.length === 1) queueMicrotask(() => this.flush());
  }

  flush() {
    if (!this.ops.length) return;
    const ops = this.ops;
    this.ops = [];
    this.node.port.postMessage(ops);
  }

  /** A struck voice into the strip of `midi` (through its direct mute), or a resonance voice into `chain`. */
  voice(key, total, midi, chain = null) { return new RVoice(this, key, total, midi, chain); }

  /**
   * A resonance string's filters, shaped like resonance.js's chain: `hp` two
   * high-passes and `lp` a low-pass, each with a `frequency`; `free()` when
   * the last voice on it has ended.
   */
  chain(midi, hpHz, lpHz) {
    const id = this.nextChain++;
    this.post(['c', id, midi, hpHz, lpHz]);
    const c = {
      id, renderer: true,
      hp: [new Node('frequency', new Param(this, 'c', id, 0, hpHz)), new Node('frequency', new Param(this, 'c', id, 1, hpHz))],
      lp: new Node('frequency', new Param(this, 'c', id, 2, lpHz)),
      free: () => this.post(['cx', id]),
    };
    return c;
  }

  /** The `direct` gain of a key's strip: the resonance solo mutes it. */
  direct(midi) {
    let d = this.directs.get(midi);
    if (!d) this.directs.set(midi, d = new Node('gain', new Param(this, 'k', midi, 0, 1)));
    return d;
  }

  /** A key's width / position matrix: the gains of the native strip's g[0..3]. */
  matrix(midi, g0, g1, g2, g3) { this.post(['m', midi, g0, g1, g2, g3]); }

  connect(...dests) { for (const d of dests) this.node.connect(d); }
}
