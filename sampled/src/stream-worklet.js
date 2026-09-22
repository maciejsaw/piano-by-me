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
//
// Heads are kept as 16-bit: at the level of a sample's first quarter second
// that is 96 dB below the note, and it halves the only thing held here for
// good.

const heads = new Map();      // key -> { data: Int16Array (stereo, interleaved), frames }
const voices = new Map();     // id -> PianoVoice
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
// How often a voice tells the worker where it has got to: ~100 ms.
const REPORT = 4800;

class PianoVoice extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'playbackRate', defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: 'k-rate' }];
  }

  constructor(options) {
    super();
    const o = options.processorOptions;
    this.id = o.id; this.key = o.key;
    this.total = o.total;               // samples in the file (best knowledge until the worker says)
    this.state = 0;                     // 0 waiting for start, 1 playing, 2 done
    this.startFrame = 0; this.stopFrame = Infinity;
    this.pos = 0;                       // read position in the file, samples
    this.head = null; this.hf = 0;
    this.q = []; this.qi = 0;           // stream blocks, in order
    this.lastReport = 0;
    this.underrun = 0;
    this.l = 0; this.r = 0;             // read() results, to avoid allocating
    this.fadeN = 0; this.fadeI = 0;     // fade-in, in output samples, and how far through
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'start') this.begin(d.when, d.offset, d.fade);
      else if (d.type === 'stop') this.stopFrame = Math.min(this.stopFrame, Math.round(d.when * sampleRate));
    };
  }

  begin(when, offset, fade = 0) {
    if (this.state !== 0) return;
    this.state = 1;
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
    this.port.postMessage({ type: 'ended', underrun: this.underrun });
  }

  process(inputs, outputs, params) {
    if (this.state === 2) return false;
    const out = outputs[0];
    const L = out[0], R = out[1] ?? out[0];
    if (this.state === 0) return true;
    const n = L.length, f0 = currentFrame;
    if (f0 + n <= this.startFrame) return true;
    let i = f0 < this.startFrame ? this.startFrame - f0 : 0;
    // The samples are 48 kHz; a context at another rate reads them faster or
    // slower to keep the pitch.
    const rate = params.playbackRate[0] * (48000 / sampleRate);
    const last = this.total - 1;
    for (; i < n; i++) {
      if (f0 + i >= this.stopFrame || this.pos >= last) { this.finish(); return false; }
      const p = this.pos, k = p | 0, fr = p - k;
      this.read(k);
      if (fr === 0) { L[i] = this.l; R[i] = this.r; }
      else {
        const l0 = this.l, r0 = this.r;
        this.read(k + 1);
        L[i] = l0 + (this.l - l0) * fr;
        R[i] = r0 + (this.r - r0) * fr;
      }
      if (this.fadeI < this.fadeN) {
        const w = 0.5 - 0.5 * Math.cos(Math.PI * this.fadeI++ / this.fadeN);
        L[i] *= w; if (R !== L) R[i] *= w;
      }
      this.pos = p + rate;
    }
    // Let go of blocks already played, now and then rather than per block.
    if (this.qi > 8) { this.q.splice(0, this.qi); this.qi = 0; }
    if (this.pos - this.lastReport >= REPORT) {
      this.lastReport = this.pos;
      worker?.postMessage({ type: 'need', id: this.id, pos: this.pos | 0 });
    }
    return true;
  }
}

registerProcessor('piano-hub', PianoHub);
registerProcessor('piano-voice', PianoVoice);
