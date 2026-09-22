// Captures whatever is connected to it and posts it to the main thread.
//
// Not part of the instrument -- sampled/tools/render.mjs loads it to record a
// performance. It has one silent output, connected to the destination, purely
// so the graph has a reason to pull it: a node with nothing downstream is not
// guaranteed to be processed at all.
const CHUNK = 8192;

class Recorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.l = new Float32Array(CHUNK);
    this.r = new Float32Array(CHUNK);
    this.n = 0;
    this.on = false;
    this.port.onmessage = (e) => {
      if (e.data === 'start') this.on = true;
      if (e.data === 'stop') { this.flush(); this.on = false; this.port.postMessage({ done: true }); }
    };
  }
  flush() {
    if (!this.n) return;
    this.port.postMessage({ l: this.l.slice(0, this.n), r: this.r.slice(0, this.n) });
    this.n = 0;
  }
  process(inputs) {
    if (!this.on) return true;
    const inp = inputs[0];
    const L = inp?.[0], R = inp?.[1] ?? inp?.[0];
    const len = L?.length ?? 128;
    for (let i = 0; i < len; i++) {
      // Silence rather than a gap when nothing is connected yet, so the
      // recording's timeline stays the same length as the performance.
      this.l[this.n] = L ? L[i] : 0;
      this.r[this.n] = R ? R[i] : 0;
      if (++this.n === CHUNK) this.flush();
    }
    return true;
  }
}
registerProcessor('recorder', Recorder);
