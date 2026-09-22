// The sample library: what exists, what can sound right now, and in what
// order to go and get the rest.
//
// The arithmetic that shapes this file: 88 keys x 16 layers is 188 MB of
// Opus, which is a reasonable download -- and 5.3 GB once decoded, which is
// not a reasonable anything. So the note samples are never decoded whole.
// The stream worker (stream-worker.js) holds them compressed and decodes each
// note while it plays; the first quarter second of every sample is decoded up
// front, so a note-on never waits for anything. See stream.js for the parts.
//
// What that leaves here:
//
//   a warm order        the samples are fetched middle-out from the centre of
//                       the keyboard and from mezzo-forte outwards, because
//                       that is the order a player reaches for them. All of
//                       them are fetched; nothing is ever evicted.
//   nearest ready       during the first download a note-on never waits. If
//                       the exact layer has not arrived it plays the closest
//                       one that has, trimmed to the right level, and moves
//                       the real one to the front of the queue.
//   the short samples   key-release and damper recordings are small (135 MB
//                       decoded, all of them) and wanted on every key lift,
//                       so they are still decoded whole and kept as buffers.
import { Streamer } from './stream.js';
import { RATE } from './ogg.js';

// Priority of a sample a note is waiting for right now.
const URGENT = 10;

export class Library {
  constructor(ctx, base, { concurrency = 6 } = {}) {
    this.ctx = ctx;
    this.base = base.replace(/\/$/, '');
    this.concurrency = concurrency;
    // The short samples, decoded.
    this.cache = new Map();                 // key -> { buf, bytes }
    this.pending = new Map();               // key -> job
    this.queue = [];
    this.inflight = 0;
    // Decoding is gated separately from fetching: decodeAudioData is heavy CPU,
    // and a pile of them at once competes with the audio thread.
    this.decodeConcurrency = 2;
    this.decoding = 0;
    this.decodeWaiters = [];
    this.auxBytes = 0;
    this.auxLoaded = 0;
    this.auxFailed = 0;
    this.streamer = null;
    this.onprogress = null;
  }

  async loadManifest() {
    const r = await fetch(`${this.base}/manifest.json`);
    if (!r.ok) throw new Error(`no manifest at ${this.base}/manifest.json (has the library been built?)`);
    const text = await r.text();
    this.m = JSON.parse(text);
    // Identifies this build of the library: the browser caches and the disk
    // install are named after it, so a rebuild never plays stale samples.
    this.tag = hash(text);
    this.layers = this.m.layers;
    // Level of each velocity layer relative to the loudest, per note, in dB.
    // Measured from the recordings rather than assumed: it is what lets the
    // velocity engine ask for a level and a timbre separately.
    this.relDb = {};
    for (const [midi, n] of Object.entries(this.m.notes)) {
      const top = n.layers[this.layers[this.layers.length - 1]];
      if (!top) continue;
      const rel = {};
      for (const l of this.layers) if (n.layers[l]) rel[l] = 20 * Math.log10(n.layers[l].gain / top.gain);
      this.relDb[midi] = rel;
    }
    return this.m;
  }

  /** Bring up the worker and the worklet. Needs the manifest. */
  async startStreaming() {
    const files = {};
    for (const [midi, n] of Object.entries(this.m.notes)) {
      for (const [l, e] of Object.entries(n.layers)) files[this.key(+midi, +l)] = e.file;
    }
    const order = this.warmOrder(this.m.keys.lo, this.m.keys.hi).map((j) => j.k);
    this.noteTotal = Object.keys(files).length;
    this.streamer = await Streamer.create(this.ctx, this.base, { files, order, tag: this.tag });
    this.streamer.onchange = () => this.onprogress?.(this);
  }

  note(midi) { return this.m.notes[midi]; }
  entry(midi, layer) { return this.m.notes[midi]?.layers[layer] ?? null; }

  key(midi, layer) { return `n${midi}v${layer}`; }
  isNote(k) { return k[0] === 'n'; }

  /** Can this sample sound right now? */
  has(k) { return this.isNote(k) ? !!this.streamer?.ready(k) : this.cache.has(k); }

  /** Kept for the engine, which reports what is sounding. Nothing is evicted any more. */
  setHeld() {}

  // ------------------------------------------------------------------ fetch --
  /**
   * Request a sample. Returns an AudioBuffer for a short sample that is
   * resident, true for a note sample that is ready to stream, otherwise null
   * (and it is queued, or moved up the queue).
   */
  want(file, k, priority = 0) {
    if (this.isNote(k)) {
      if (this.streamer?.ready(k)) return true;
      this.streamer?.want([[k, priority]]);
      return null;
    }
    const c = this.cache.get(k);
    if (c) return c.buf;
    const p = this.pending.get(k);
    if (p) { if (priority > p.priority) { p.priority = priority; this.pump(); } return null; }
    const job = { file, k, priority };
    this.pending.set(k, job);
    this.queue.push(job);
    this.pump();
    return null;
  }

  pump() {
    while (this.queue.length) {
      this.queue.sort((a, b) => b.priority - a.priority);
      if (this.inflight >= this.concurrency && this.queue[0].priority < URGENT) break;
      const job = this.queue.shift();
      this.inflight++;
      this.fetchOne(job)
        .catch(() => { this.auxFailed++; })
        .finally(() => { this.inflight--; this.pending.delete(job.k); this.pump(); });
    }
  }

  /** Decode, never more than `decodeConcurrency` at once, highest priority first. */
  async decode(bytes, job) {
    if (this.decoding >= this.decodeConcurrency) {
      await new Promise((res) => this.decodeWaiters.push({ job, res }));
    }
    this.decoding++;
    try { return await this.ctx.decodeAudioData(bytes); }
    finally {
      this.decoding--;
      const w = this.decodeWaiters;
      if (w.length) {
        let best = 0;
        for (let i = 1; i < w.length; i++) if (w[i].job.priority > w[best].job.priority) best = i;
        w.splice(best, 1)[0].res();
      }
    }
  }

  async fetchOne(job) {
    const r = await fetch(`${this.base}/${job.file}`);
    if (!r.ok) throw new Error(`${r.status} ${job.file}`);
    const buf = await this.decode(await r.arrayBuffer(), job);
    const bytes = buf.length * buf.numberOfChannels * 4;
    this.cache.set(job.k, { buf, bytes });
    this.auxBytes += bytes;
    this.auxLoaded++;
    this.onprogress?.(this);
    return buf;
  }

  /**
   * The best layer of `midi` that can sound RIGHT NOW, and the correction for
   * having settled. `trimDb` is how much quieter the wanted layer was than the
   * one being used, so the caller can hand back the level that was asked for.
   *
   * Returns { key, layer, entry, trimDb, frames } -- `frames` is the sample's
   * length at 48 kHz, which the stream source needs up front.
   */
  best(midi, layer) {
    const n = this.m.notes[midi];
    if (!n || !this.streamer) return null;
    const exact = n.layers[layer];
    if (exact) {
      const k = this.key(midi, layer);
      if (this.streamer.ready(k)) return this.found(midi, layer, exact, 0);
      // Not here yet: to the front of the queue, with the layers either side
      // just behind it, because the next strike of this key will rarely be
      // at exactly the same velocity.
      const items = [[k, URGENT]];
      for (const l of [layer - 1, layer + 1]) if (n.layers[l]) items.push([this.key(midi, l), 4]);
      this.streamer.want(items);
    }
    let found = null, bestD = 1e9;
    for (const l of this.layers) {
      if (!n.layers[l] || !this.streamer.ready(this.key(midi, l))) continue;
      const d = Math.abs(l - layer);
      if (d < bestD) { bestD = d; found = l; }
    }
    if (found == null) return null;
    const trimDb = (this.relDb[midi]?.[layer] ?? 0) - (this.relDb[midi]?.[found] ?? 0);
    return this.found(midi, found, n.layers[found], trimDb);
  }

  found(midi, layer, entry, trimDb) {
    return { key: this.key(midi, layer), layer, entry, trimDb, frames: Math.round(entry.dur * RATE) };
  }

  /** A short auxiliary sample -- key release or damper resonance. */
  aux(desc, k, priority = 1) { return desc ? this.want(desc.file, k, priority) : null; }

  /** Stop the warm pass (offline rendering asks for exactly what it needs instead). */
  stopWarm() { this.stopped = true; }

  // ------------------------------------------------------------------ stats --
  /** How many keys can speak: their softest layer is ready. */
  keysReady() {
    let n = 0;
    const soft = this.layers[0];
    for (let m = this.m.keys.lo; m <= this.m.keys.hi; m++) if (this.has(this.key(m, soft))) n++;
    return n;
  }

  /** Note samples ready to play. */
  get loaded() {
    const s = this.streamer;
    if (!s) return 0;
    let n = 0;
    for (const k of s.have) if (s.heads.has(k)) n++;
    return n;
  }
  get failed() { return this.auxFailed + (this.streamer?.failed ?? 0); }
  /** Bytes held: short samples decoded, note samples compressed, heads decoded. */
  get bytes() { return this.auxBytes + (this.streamer?.opusBytes ?? 0) + (this.streamer?.headBytes ?? 0); }

  /** How many of the small release samples are in memory. */
  auxResident(lo, hi) {
    let n = 0;
    for (const j of this.auxOrder(lo, hi)) if (this.cache.has(j.k)) n++;
    return n;
  }

  // ------------------------------------------------------------------ warm --
  /**
   * Every key-release and damper-release sample, as one list.
   *
   * These go first. They are fetched on demand otherwise, and a fetch takes
   * longer than a key release does -- so the FIRST time any key was let go,
   * its release sample was not there yet and nothing was heard.
   */
  auxOrder(lo, hi) {
    const out = [];
    for (let m = lo; m <= hi; m++) {
      const n = this.m.notes[m];
      if (!n) continue;
      if (n.release) out.push({ file: n.release.file, k: `r${m}` });
      for (const [variant, d] of Object.entries(n.damper ?? {})) out.push({ file: d.file, k: `h${m}${variant}` });
    }
    // The pedal-action recordings are deliberately not here and never
    // fetched: the engine has no pedal sample. See setPedal().
    return out;
  }

  /**
   * The order a player empties the library in.
   *
   * The softest layer of every key first: it is what the sympathetic
   * resonance plays, on every key, whatever is struck. Then layers in the
   * order 12, 8, 16, 4, 14, 10, 6, 2, ... -- mezzo-forte before the extremes,
   * because that is where most notes land and a near-miss there is least
   * audible -- each outward from middle C.
   */
  warmOrder(lo, hi) {
    const soft = this.layers[0];
    const ls = [soft, ...this.layers.filter((l) => l !== soft).sort((a, b) => score(a) - score(b))];
    function score(l) { return Math.abs(l - 12) + (l % 2) * 0.5; }
    const keys = [];
    for (let m = lo; m <= hi; m++) keys.push(m);
    keys.sort((a, b) => Math.abs(a - 60) - Math.abs(b - 60));
    const out = [];
    for (const l of ls) for (const m of keys) {
      const e = this.entry(m, l);
      if (e) out.push({ file: e.file, k: this.key(m, l), priority: -out.length / 1e6 });
    }
    return out;
  }

  /** Fetch everything: the short samples here, the note samples in the worker. */
  startWarm(lo, hi) {
    const aux = this.auxOrder(lo, hi);
    aux.forEach((j, i) => this.want(j.file, j.k, 6 - i / 1e6));
    this.streamer.want(this.warmOrder(lo, hi).map((j) => [j.k, j.priority]));
  }

  /** Decode the whole library to disk (opt-in; see stream-worker.js). */
  install() {
    return this.streamer?.install(this.warmOrder(this.m.keys.lo, this.m.keys.hi).map((j) => j.k));
  }
}

function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}
