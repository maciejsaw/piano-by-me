// Main-thread half of the streaming sampler: the plumbing, and a source node
// that the engine can use exactly where it used an AudioBufferSourceNode.
//
//   main ── want / install ──► stream worker ◄── start / need / stop ──┐
//     │                           │ heads, blocks                        │
//     │                           ▼                                      │
//     └── new StreamSource ──► piano-voice ◄── piano-hub (the mailbox) ──┘
//
// The main thread never touches audio data. It is told two things per
// sample -- the worker has it (in memory or on disk), and the worklet has its
// head -- and a sample is playable when both are true.

let nextId = 1;

export class Streamer {
  /**
   * @param base   URL of the samples directory
   * @param files  { key: file } for every note sample
   * @param order  keys in the order a player reaches for them
   * @param tag    identifies this build of the library (cache names hang off it)
   */
  static async create(ctx, base, { files, order, tag }) {
    await ctx.audioWorklet.addModule(new URL('./stream-worklet.js', import.meta.url));
    return new Streamer(ctx, base, files, order, tag);
  }

  constructor(ctx, base, files, order, tag) {
    this.ctx = ctx;
    this.heads = new Set();         // keys whose head is in the worklet
    this.have = new Set();          // keys the worker can stream (memory or disk)
    this.headBytes = 0;
    this.opusBytes = 0;
    this.loaded = 0; this.failed = 0;
    this.installed = 0; this.installing = false;
    this.streams = 0;
    this.underruns = 0;
    this.decoderTrims = null;
    this.headsBundle = null;        // true/false once the worker has tried it
    this.onchange = null;           // (streamer) => void, on any of the above
    this.onerror = null;            // (message) => void

    // Never connected: it exists for its port and its global scope.
    this.hub = new AudioWorkletNode(ctx, 'piano-hub', { numberOfInputs: 0, numberOfOutputs: 1 });
    this.hub.port.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'head') {
        if (!this.heads.has(d.key)) { this.heads.add(d.key); this.headBytes += d.bytes; }
        this.changed();
      }
    };

    this.worker = new Worker(new URL('./stream-worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => this.fromWorker(e.data);
    this.worker.onerror = (e) => this.onerror?.(`stream worker: ${e.message}`);
    const ch = new MessageChannel();
    this.hub.port.postMessage({ type: 'worker', port: ch.port1 }, [ch.port1]);
    this.worker.postMessage({
      type: 'init', base: new URL(base, location.href).href.replace(/\/$/, ''),
      tag, files, order, hub: ch.port2,
    }, [ch.port2]);
  }

  fromWorker(d) {
    if (d.type === 'status') {
      for (const k of d.have) this.have.add(k);
      this.loaded = d.loaded; this.failed = d.failed; this.opusBytes = d.bytes;
      this.installed = d.installed; this.installing = d.installing; this.streams = d.streams;
    } else if (d.type === 'ready') {
      for (const k of d.installed) this.have.add(k);
      this.installed = d.installed.length;
    } else if (d.type === 'heads') {
      this.headsBundle = d.bundle;
      if (!d.bundle) console.info('sampled: no heads bundle -- run `node sampled/tools/heads.mjs` for a faster start');
    } else if (d.type === 'calibrated') {
      this.decoderTrims = d.decoderTrims;
    } else if (d.type === 'error') {
      console.warn('sampled:', d.message);
      this.onerror?.(d.message);
    }
    this.changed();
  }

  changed() { this.onchange?.(this); }

  ready(key) { return this.have.has(key) && this.heads.has(key); }

  /** Ask for samples: [[key, priority], ...]. Higher goes first. */
  want(items) { if (items.length) this.worker.postMessage({ type: 'want', items }); }

  /** Decode the whole library to disk, in `order`. Idempotent. */
  async install(order) {
    // Without this the browser may clear 2.6 GB of OPFS under storage pressure
    // and the next visit starts over.
    try { await navigator.storage?.persist?.(); } catch { /* not granted: still works */ }
    this.worker.postMessage({ type: 'install', order });
  }

  /** Stop the install after the samples already in hand. What is done stays done. */
  stopInstall() { this.worker.postMessage({ type: 'stopInstall' }); }
}

/**
 * A playing sample, used like an AudioBufferSourceNode: connect, start(when,
 * offset), stop(when), onended, and a k-rate `playbackRate` AudioParam.
 */
export class StreamSource {
  constructor(streamer, key, totalFrames) {
    this.streamer = streamer;
    this.id = nextId++;
    this.node = new AudioWorkletNode(streamer.ctx, 'piano-voice', {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
      processorOptions: { id: this.id, key, total: totalFrames },
    });
    this.playbackRate = this.node.parameters.get('playbackRate');
    this.onended = null;
    this.node.port.onmessage = (e) => {
      if (e.data.type !== 'ended') return;
      if (e.data.underrun) {
        // The stream did not arrive in time and part of the note was silence.
        // It should not happen; if it does, this is where to look.
        streamer.underruns++;
        console.warn(`sampled: stream underrun on ${key} (${e.data.underrun} samples)`);
      }
      this.node.port.onmessage = null;
      this.node.disconnect();
      this.onended?.();
    };
  }
  connect(dest) { return this.node.connect(dest); }
  disconnect() { this.node.disconnect(); }
  /**
   * `fade`: seconds of fade-in, applied by the voice to the first samples it
   * plays -- a raised cosine, or `curve` (a 0 -> 1 table) if given.
   */
  start(when = 0, offset = 0, fade = 0, curve = null) { this.node.port.postMessage({ type: 'start', when, offset, fade, curve }); }
  stop(when = 0) { this.node.port.postMessage({ type: 'stop', when }); }
  /** Cancel a stop that has not happened yet. */
  resume() { this.node.port.postMessage({ type: 'resume' }); }
}
