// The audio-thread half of the streaming sampler.
//
// Two processors share this scope:
//
//   piano-hub     one per context, never connected. It is a mailbox: the
//                 stream worker's MessagePort is handed to it, and through it
//                 arrive the decoded HEADS of every sample (the first quarter
//                 second, kept here for good) and the decoded blocks of every
//                 stream, which it routes to the voice they belong to.
//   piano-voice   one per sounding note, created where an AudioBufferSource
//                 used to be and used the same way -- start, stop, onended,
//                 playbackRate. It plays the head straight out of memory the
//                 instant it starts, and asks the worker for the rest, which
//                 arrives long before the head runs out.
//   piano-voices  how the engine plays them: ONE node for every voice, with
//                 what used to be native nodes after each voice -- its gains,
//                 a resonance string's filters, the key's strip -- done here
//                 in JS (voices.js is its main-thread half). Chrome charges
//                 every node a fixed cost per render quantum, and under the
//                 pedal that was most of the load.
//
// Heads are kept as 16-bit: at the level of a sample's first quarter second
// that is 96 dB below the note, and it halves the only thing held here for
// good.

import { Timeline } from './automation.js';

const heads = new Map();      // key -> { data: Int16Array (stereo, interleaved), frames }
const voices = new Map();     // id -> Voice, playing
let worker = null;            // MessagePort to the stream worker
let hubPort = null;           // the hub's own port, to tell the main thread about heads

function fromWorker(e) {
  const d = e.data;
  if (d.type === 'block') voices.get(d.id)?.push(d);
  else if (d.type === 'end') voices.get(d.id)?.eof(d.total);
  else if (d.type === 'fail') voices.get(d.id)?.eof(d.at ?? 0);
  else if (d.type === 'head') {
    heads.set(d.key, { data: d.data, frames: d.frames });
    // The main thread counts a key as playable only once its head is HERE,
    // not merely decoded in the worker -- the two travel different ports.
    hubPort?.postMessage({ type: 'head', key: d.key, bytes: d.data.byteLength });
  }
}

/**
 * Played blocks go back to the worker, which fills them again. Left to the
 * garbage collector, a hundred voices' worth of stream -- a thousand buffers
 * a second -- would all be collected HERE, on the audio thread, and a
 * collection is exactly the kind of pause that is heard as a crackle.
 */
function giveBack(blocks) {
  if (!worker || !blocks.length) return;
  const bufs = [];
  for (const b of blocks) {
    if (b.L.byteLength) bufs.push(b.L.buffer);
    if (b.R.byteLength && b.R.buffer !== b.L.buffer) bufs.push(b.R.buffer);
  }
  if (bufs.length) worker.postMessage({ type: 'free', bufs }, bufs);
}

class PianoHub extends AudioWorkletProcessor {
  constructor() {
    super();
    hubPort = this.port;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'worker') { worker = d.port; worker.onmessage = fromWorker; }
      else if (d.type === 'dropHeads') { heads.clear(); }
    };
  }
  process() { return true; }
}

const I16 = 1 / 32768;

/**
 * The first frame of the quantum a processor is rendering. Chrome's
 * `currentFrame` now and then is not moved on between two render quanta (a
 * quantum recorded by it landed in the slot of the one before, a few times
 * a minute under load), and a voice timed by it starts, stops or reads its
 * gains a quantum out. A quantum is always 128 frames after the last one
 * this processor rendered, unless currentFrame says later (it was not called
 * for a while).
 */
function frameOf(p) {
  const f = p.frame === undefined ? currentFrame : Math.max(currentFrame, p.frame + 128);
  p.frame = f;
  return f;
}
// How often a voice tells the worker where it has got to: ~100 ms.
const REPORT = 4800;

/**
 * One sample voice: the playback of one recording, from its head and then its
 * stream, into the arrays it is given. `piano-voice` is a processor holding
 * one of these.
 */
class Voice {
  /** `onEnd(underrun)`: called once, when the voice has finished. */
  constructor(id, key, total, onEnd) {
    this.onEnd = onEnd;
    this.reset(id, key, total);
  }

  reset(id, key, total) {
    this.id = id; this.key = key;
    this.total = total;                 // samples in the file (best knowledge until the worker says)
    this.state = 0;                     // 0 waiting for start, 1 playing, 2 done
    this.startFrame = 0; this.stopFrame = Infinity;
    this.pos = 0;                       // read position in the file, samples
    this.head = null; this.hf = 0;
    this.q = []; this.qi = 0;           // stream blocks, in order
    this.lastReport = 0;
    this.underrun = 0;
    this.l = 0; this.r = 0;             // read() results, to avoid allocating
    this.fadeN = 0; this.fadeI = 0;     // fade-in, in output samples, and how far through
    this.fadeCurve = null;
    this.waiting = false;               // started past the head, first block not here yet
  }

  stop(when) { this.stopFrame = Math.min(this.stopFrame, Math.round(when * sampleRate)); }
  // A damper lifted again before its fall ended: the scheduled stop is off.
  // Too late if the voice has already finished; the caller only asks while
  // the stop is still well in the future.
  resume() { this.stopFrame = Infinity; }

  begin(when, offset, fade = 0, curve = null) {
    if (this.state !== 0) return;
    this.state = 1;
    // The fade-in's shape, 0 -> 1, as a table read across the fade; without
    // one, a raised cosine.
    this.fadeCurve = curve;
    // Counted in samples actually played, not from `when`: a start that
    // arrives late still gets all of it, so a cut into a sound is never a step.
    this.fadeN = Math.round(Math.max(0, fade) * sampleRate);
    this.startFrame = Math.round(when * sampleRate);
    this.pos = Math.max(0, offset * 48000);
    const h = heads.get(this.key);
    if (h) { this.head = h.data; this.hf = h.frames; }
    voices.set(this.id, this);
    // The stream picks up where the head leaves off -- or where the note
    // starts, for the rare start that is past the head already.
    const from = Math.max(this.hf, Math.floor(this.pos));
    // A start past the head has nothing to play until the stream's first block
    // arrives. Hold the voice until then -- a few ms late -- rather than play
    // zeros and call them an underrun. Only the sympathetic resonance does
    // this: it enters a recording past its prompt sound.
    this.waiting = this.pos >= this.hf;
    if (from < this.total) worker?.postMessage({ type: 'start', id: this.id, key: this.key, from });
  }

  push(b) { this.q.push(b); }
  eof(total) { if (total < this.total) this.total = total; }

  /** Sample `k` of the file into this.l / this.r. */
  read(k) {
    if (k < this.hf) {
      const h = this.head, j = k << 1;
      this.l = h[j] * I16; this.r = h[j + 1] * I16;
      return;
    }
    const q = this.q;
    while (this.qi < q.length) {
      const b = q[this.qi];
      if (k < b.start) break;
      if (k < b.start + b.frames) { const i = k - b.start; this.l = b.L[i]; this.r = b.R[i]; return; }
      this.qi++;
    }
    this.l = 0; this.r = 0;
    this.underrun++;
  }

  finish() {
    this.state = 2;
    voices.delete(this.id);
    worker?.postMessage({ type: 'stop', id: this.id });
    giveBack(this.q); this.q = []; this.qi = 0;
    this.onEnd(this.underrun);
  }

  /**
   * Samples this.pos... into L/R[i, stop), at rate 1 from a whole-sample
   * position: runs of the head or of a block copied as they are. The same
   * numbers read() gives, sample for sample, underruns included.
   */
  copy(L, R, i, stop) {
    let k = this.pos;
    while (i < stop) {
      if (k < this.hf) {
        const h = this.head, m = Math.min(stop - i, this.hf - k);
        for (let j = k << 1, e = i + m; i < e; i++, j += 2) { L[i] = h[j] * I16; R[i] = h[j + 1] * I16; }
        k += m;
        continue;
      }
      const q = this.q;
      while (this.qi < q.length && k >= q[this.qi].start + q[this.qi].frames) this.qi++;
      const b = q[this.qi];
      if (b && k >= b.start) {
        const a = k - b.start, m = Math.min(stop - i, b.frames - a);
        L.set(b.L.subarray(a, a + m), i); R.set(b.R.subarray(a, a + m), i);
        i += m; k += m;
      } else {
        // Not here: silence up to the next block that is, and counted.
        const m = Math.min(stop - i, b ? b.start - k : stop - i);
        L.fill(0, i, i + m); R.fill(0, i, i + m);
        this.underrun += m;
        i += m; k += m;
      }
    }
    this.pos = k;
    return i;
  }

  /** The fade-in over the samples just written, L/R[from, to). */
  fade(L, R, from, to) {
    const c = this.fadeCurve;
    for (let i = from; i < to && this.fadeI < this.fadeN; i++) {
      const u = this.fadeI++ / this.fadeN;
      let w;
      if (c) { const x = u * (c.length - 1), j = x | 0; w = c[j] + (c[Math.min(c.length - 1, j + 1)] - c[j]) * (x - j); }
      else w = 0.5 - 0.5 * Math.cos(Math.PI * u);
      L[i] *= w; if (R !== L) R[i] *= w;
    }
  }

  /**
   * The quantum starting at frame `f0` into L/R, which must be zeroed: only
   * the samples played are written. `playbackRate` as the parameter reads.
   * False once the voice has finished.
   */
  render(L, R, f0, playbackRate) {
    if (this.state === 2) return false;
    if (this.state === 0) return true;
    const n = L.length;
    if (f0 + n <= this.startFrame) return true;
    let i = f0 < this.startFrame ? this.startFrame - f0 : 0;
    if (this.waiting) {
      // Stopped, or the stream failed (eof pulls `total` in) before a block came.
      if (f0 + n > this.stopFrame || this.pos >= this.total - 1) { this.finish(); return false; }
      if (this.q.length === 0) return true;
      if (this.q[0].start > this.pos) this.pos = this.q[0].start;
      this.waiting = false;
    }
    // The samples are 48 kHz; a context at another rate reads them faster or
    // slower to keep the pitch.
    const rate = playbackRate * (48000 / sampleRate);
    const fading = this.fadeI < this.fadeN, from = i;
    // Where this quantum ends: at the stop, the end of the file, or n.
    let end = n;
    if (this.stopFrame < f0 + n) end = Math.max(i, this.stopFrame - f0);
    if (rate === 1 && this.pos === Math.floor(this.pos) && R !== L) {
      // Whole samples, straight through: copied in runs, not one by one.
      const stop = Math.min(end, i + Math.max(0, this.total - 1 - this.pos));
      i = this.copy(L, R, i, stop);
      if (fading) this.fade(L, R, from, i);
      if (i < n) { this.finish(); return false; }
    } else {
      const last = this.total - 1;
      for (; i < n; i++) {
        if (i >= end || this.pos >= last) break;
        const p = this.pos, k = p | 0, fr = p - k;
        this.read(k);
        if (fr === 0) { L[i] = this.l; R[i] = this.r; }
        else {
          const l0 = this.l, r0 = this.r;
          this.read(k + 1);
          L[i] = l0 + (this.l - l0) * fr;
          R[i] = r0 + (this.r - r0) * fr;
        }
        this.pos = p + rate;
      }
      if (fading) this.fade(L, R, from, i);
      if (i < n) { this.finish(); return false; }
    }
    // Let go of blocks already played, now and then rather than per block.
    if (this.qi > 8) { giveBack(this.q.splice(0, this.qi)); this.qi = 0; }
    if (this.pos - this.lastReport >= REPORT) {
      this.lastReport = this.pos;
      worker?.postMessage({ type: 'need', id: this.id, pos: this.pos | 0 });
    }
    return true;
  }
}

class PianoVoice extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'playbackRate', defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: 'k-rate' }];
  }

  constructor(options) {
    super();
    const o = options.processorOptions;
    this.voice = new Voice(o.id, o.key, o.total, (underrun) => this.port.postMessage({ type: 'ended', underrun }));
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'start') this.voice.begin(d.when, d.offset, d.fade, d.curve);
      else if (d.type === 'stop') this.voice.stop(d.when);
      else if (d.type === 'resume') this.voice.resume();
    };
  }

  process(inputs, outputs, params) {
    const out = outputs[0];
    return this.voice.render(out[0], out[1] ?? out[0], frameOf(this), params.playbackRate[0]);
  }
}

// ---------------------------------------------------------- piano-voices --

const Q = 128;
const f32 = Math.fround;

/**
 * A biquad, one channel: direct form 1 with double coefficients and state,
 * each output rounded to single precision, like Chrome's Biquad::Process
 * (within -100 dB of Chrome's BiquadFilterNode above 200 Hz, -79 dB at
 * 10 Hz). `c` is [b0, b1, b2, a1, a2], normalised.
 */
class Biquad {
  constructor() { this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0; }
  run(buf, from, to, c) {
    const b0 = c[0], b1 = c[1], b2 = c[2], a1 = c[3], a2 = c[4];
    let { x1, x2, y1, y2 } = this;
    for (let i = from; i < to; i++) {
      const x = buf[i];
      const y = f32(b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2);
      buf[i] = y;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
    }
    this.end(x1, x2, y1, y2);
  }
  /** The same with coefficients moving in a straight line from `c` (at `from`) to `d` (at `to`). */
  glide(buf, from, to, c, d) {
    const n = to - from;
    const s0 = (d[0] - c[0]) / n, s1 = (d[1] - c[1]) / n, s2 = (d[2] - c[2]) / n, s3 = (d[3] - c[3]) / n, s4 = (d[4] - c[4]) / n;
    let { x1, x2, y1, y2 } = this;
    for (let i = from, j = 0; i < to; i++, j++) {
      const x = buf[i];
      const y = f32((c[0] + s0 * j) * x + (c[1] + s1 * j) * x1 + (c[2] + s2 * j) * x2 - (c[3] + s3 * j) * y1 - (c[4] + s4 * j) * y2);
      buf[i] = y;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
    }
    this.end(x1, x2, y1, y2);
  }
  end(x1, x2, y1, y2) {
    // A silent input with the tail down among the subnormals: flushed, as Chrome does.
    if (x1 === 0 && x2 === 0 && (y1 !== 0 || y2 !== 0) && Math.abs(y1) < 1.1754943508222875e-38 && Math.abs(y2) < 1.1754943508222875e-38) { y1 = 0; y2 = 0; }
    this.x1 = x1; this.x2 = x2; this.y1 = y1; this.y2 = y2;
  }
}

/** A high- or low-pass at `hz`, Q `q` dB, into `c`: the spec's formulas, as Chrome computes them. */
function passCoefs(c, high, hz, q) {
  const cutoff = Math.max(0, Math.min(1, hz / (0.5 * sampleRate)));
  if (cutoff === 1) { c[0] = high ? 0 : 1; c[1] = c[2] = c[3] = c[4] = 0; }
  else if (cutoff > 0) {
    const theta = Math.PI * cutoff, alpha = Math.sin(theta) / (2 * Math.pow(10, q / 20)), cosw = Math.cos(theta);
    const beta = high ? (1 + cosw) / 2 : (1 - cosw) / 2, a0 = 1 + alpha;
    c[0] = beta / a0; c[1] = (high ? -2 : 2) * beta / a0; c[2] = beta / a0; c[3] = -2 * cosw / a0; c[4] = (1 - alpha) / a0;
  } else { c[0] = high ? 1 : 0; c[1] = c[2] = c[3] = c[4] = 0; }
}

// A moving filter frequency is read every this many samples, and the
// coefficients go in a straight line between one reading and the next (the
// user's choice; Chrome recomputes them every sample, which in JS costs more
// than the voices do). Within -78 dB of Chrome on a tone glide, -95 dB on the
// partial filter's.
const FILTER_RUN = 32;
const HP_Q = f32(Math.SQRT1_2), LP_Q = f32(0.5);

/**
 * A resonance string's filters (resonance.js chain): two high-passes and a
 * low-pass, stereo, shared by the voices on that string, into its key's
 * strip past the direct mute.
 */
class Chain {
  constructor(id, strip, hp, lp) {
    this.id = id; this.strip = strip;
    this.L = new Float32Array(Q); this.R = new Float32Array(Q);
    this.freq = [new Timeline(hp), new Timeline(hp), new Timeline(lp)];
    this.bq = [0, 1, 2].map(() => [new Biquad(), new Biquad()]);
    this.hz = [NaN, NaN, NaN];
    this.c = [0, 1, 2].map(() => new Float64Array(5));      // coefficients at this.hz
    this.d = new Float64Array(5);
    this.fv = new Float32Array(Q);
    this.fed = false;             // input this quantum
    this.ringing = false;         // output last quantum
  }

  /** Filter this quantum's input (frames from f0) into the strip. */
  run(strip, f0) {
    if (!this.fed && !this.ringing) return;
    const { L, R, d } = this;
    for (let k = 0; k < 3; k++) {
      const tl = this.freq[k], bq = this.bq[k], c = this.c[k], high = k < 2, q = high ? HP_Q : LP_Q;
      const v = tl.fill(this.fv, f0, Q, sampleRate);
      if (v === v) {
        const hz = f32(v);
        if (hz !== this.hz[k]) { this.hz[k] = hz; passCoefs(c, high, hz, q); }
        bq[0].run(L, 0, Q, c); bq[1].run(R, 0, Q, c);
      } else {
        if (this.hz[k] !== this.hz[k]) { this.hz[k] = f32(this.fv[0]); passCoefs(c, high, this.hz[k], q); }
        for (let i = 0; i < Q; i += FILTER_RUN) {
          const j = i + FILTER_RUN;
          const hz = f32(j < Q ? this.fv[j] : tl.valueAt((f0 + Q) / sampleRate));
          if (hz === this.hz[k]) { bq[0].run(L, i, j, c); bq[1].run(R, i, j, c); continue; }
          passCoefs(d, high, hz, q);
          bq[0].glide(L, i, j, c, d); bq[1].glide(R, i, j, c, d);
          c.set(d); this.hz[k] = hz;
        }
      }
    }
    let any = false;
    const sL = strip.IL, sR = strip.IR;
    for (let i = 0; i < Q; i++) {
      const l = L[i], r = R[i];
      if (l !== 0 || r !== 0) { any = true; sL[i] += l; sR[i] += r; }
    }
    if (any) strip.fedI = true;
    this.ringing = any;
    this.fed = false;
    L.fill(0); R.fill(0);
  }
}

/** A key's strip: struck voices through `direct` (the solo mute), resonance past it, then the swap and matrix. */
class Strip {
  constructor() {
    this.DL = new Float32Array(Q); this.DR = new Float32Array(Q);
    this.IL = new Float32Array(Q); this.IR = new Float32Array(Q);
    this.direct = new Timeline(1);
    this.m = [1, 0, 0, 1];        // LL RL LR RR, as engine.refreshStrips sets its gains
    this.fedD = false; this.fedI = false;
  }
}

/** A voice with its gains: level, attack, release, multiplied, as the native chain of three. */
class Slot {
  constructor(renderer) {
    this.voice = new Voice(0, '', 0, (underrun) => renderer.ended.push(this.id, underrun));
    this.g = [new Timeline(1), new Timeline(1), new Timeline(1)];
    this.gv = [new Float32Array(Q), new Float32Array(Q), new Float32Array(Q)];
    this.id = 0; this.strip = 0; this.chain = null; this.rate = 1;
  }
  reset(id, key, total, strip, chain) {
    this.voice.reset(id, key, total);
    for (const t of this.g) t.reset(1);
    this.id = id; this.strip = strip; this.chain = chain; this.rate = 1;
  }
}

class PianoVoices extends AudioWorkletProcessor {
  constructor() {
    super();
    this.slots = new Map();       // id -> Slot, created and not yet ended
    this.live = [];               // the same, in an array to run through
    this.spare = [];
    for (let i = 0; i < 64; i++) this.spare.push(new Slot(this));
    this.chains = new Map();      // id -> Chain
    this.strips = [];
    for (let m = 0; m < 128; m++) this.strips.push(new Strip());
    this.L = new Float32Array(Q); this.R = new Float32Array(Q);
    this.gain = new Float32Array(Q);
    this.cs = new Float64Array(3);
    this.ended = [];              // id, underrun, ... this quantum
    this.port.onmessage = (e) => { for (const op of e.data) this.op(op); };
  }

  param(kind, id, k) {
    if (kind === 'v') return this.slots.get(id)?.g[k];
    if (kind === 'c') return this.chains.get(id)?.freq[k];
    return this.strips[id]?.direct;
  }

  op(o) {
    switch (o[0]) {
      case 'v': {                 // ['v', id, key, total, strip, chain id or 0]
        const s = this.spare.pop() ?? new Slot(this);
        s.reset(o[1], o[2], o[3], o[4], o[5] ? this.chains.get(o[5]) ?? null : null);
        this.slots.set(o[1], s); this.live.push(s);
        break;
      }
      case 's': this.slots.get(o[1])?.voice.begin(o[2], o[3], o[4], o[5]); break;
      case 'x': this.slots.get(o[1])?.voice.stop(o[2]); break;
      case 'r': this.slots.get(o[1])?.voice.resume(); break;
      case 'rate': { const s = this.slots.get(o[1]); if (s) s.rate = f32(Math.max(0.25, Math.min(4, o[2]))); break; }
      case 'p': {                 // ['p', kind, id, index, method, args, now]
        const tl = this.param(o[1], o[2], o[3]);
        if (tl) try { tl[o[4]](...o[5], o[6]); } catch { /* refused, as the native param refused it */ }
        break;
      }
      case 'c': this.chains.set(o[1], new Chain(o[1], o[2], o[3], o[4])); break;   // ['c', id, strip, hp Hz, lp Hz]
      case 'cx': this.chains.delete(o[1]); break;
      case 'm': this.strips[o[1]].m = [o[2], o[3], o[4], o[5]]; break;
    }
  }

  process(inputs, outputs) {
    const out = outputs[0], OL = out[0], OR = out[1] ?? out[0];
    const f0 = frameOf(this), sr = sampleRate;
    const L = this.L, R = this.R, G = this.gain;
    const live = this.live;
    for (let n = 0; n < live.length; n++) {
      const s = live[n], v = s.voice;
      let alive = true;
      try {
        if (v.state === 0 || f0 + Q <= v.startFrame) continue;
        L.fill(0); R.fill(0);
        alive = v.render(L, R, f0, s.rate);
        // Gains, as the three native ones would multiply them.
        const cs = this.cs;
        let g = 1, flat = true;
        for (let k = 0; k < 3; k++) {
          const c = cs[k] = s.g[k].fill(s.gv[k], f0, Q, sr);
          if (c === c) g *= c; else flat = false;
        }
        let dL, dR;
        if (s.chain) { dL = s.chain.L; dR = s.chain.R; s.chain.fed = true; }
        else { const st = this.strips[s.strip]; dL = st.DL; dR = st.DR; st.fedD = true; }
        if (flat) {
          if (g !== 0) for (let i = 0; i < Q; i++) { dL[i] += L[i] * g; dR[i] += R[i] * g; }
        } else {
          G.fill(g);
          for (let k = 0; k < 3; k++) {
            if (cs[k] === cs[k]) continue;
            const gv = s.gv[k];
            for (let i = 0; i < Q; i++) G[i] *= gv[i];
          }
          for (let i = 0; i < Q; i++) { dL[i] += L[i] * G[i]; dR[i] += R[i] * G[i]; }
        }
      } catch {
        // One voice's failure ends that voice, not all of them.
        alive = false;
        try { if (v.state !== 2) v.finish(); } catch { this.ended.push(s.id, 0); }
      }
      if (!alive) {
        this.slots.delete(s.id);
        live[n] = live[live.length - 1]; live.pop(); n--;
        s.chain = null;
        if (this.spare.length < 256) this.spare.push(s);
      }
    }
    for (const c of this.chains.values()) c.run(this.strips[c.strip], f0);
    const strips = this.strips;
    for (let m = 0; m < 128; m++) {
      const st = strips[m];
      if (!st.fedD && !st.fedI) continue;
      const { DL, DR, IL, IR } = st;
      if (st.fedD) {
        const d = st.direct.fill(G, f0, Q, sr);
        if (d === d) { if (d !== 1) for (let i = 0; i < Q; i++) { DL[i] *= d; DR[i] *= d; } }
        else for (let i = 0; i < Q; i++) { DL[i] *= G[i]; DR[i] *= G[i]; }
      }
      // The recordings' channels arrive swapped: g0/g2 take the right, g1/g3 the left.
      const [m0, m1, m2, m3] = st.m;
      for (let i = 0; i < Q; i++) {
        const l = DL[i] + IL[i], r = DR[i] + IR[i];
        OL[i] += m0 * r + m1 * l;
        OR[i] += m2 * r + m3 * l;
      }
      DL.fill(0); DR.fill(0); IL.fill(0); IR.fill(0);
      st.fedD = false; st.fedI = false;
    }
    if (this.ended.length) { this.port.postMessage(this.ended); this.ended = []; }
    return true;
  }
}

registerProcessor('piano-hub', PianoHub);
registerProcessor('piano-voice', PianoVoice);
registerProcessor('piano-voices', PianoVoices);
