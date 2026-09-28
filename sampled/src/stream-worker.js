// The stream worker: the sample library, compressed, and the decoder that
// turns it into sound only as fast as it is played.
//
// Decoded, the library is 5.3 GB of float; as Opus it is 188 MB. So this
// holds the Opus -- every file, all the time -- and decodes each note while
// it sounds, a second or so ahead of the playhead, straight into the voice
// that is playing it (a MessagePort to the worklet, no main-thread hop).
// Nothing is waited for at note-on, because the first quarter second of every
// sample (its HEAD) is decoded up front and already sitting in the worklet;
// the stream only has to arrive before that runs out.
//
// Three sources, cheapest first:
//
//   disk     opt-in. The whole library decoded once to 16-bit PCM in the
//            Origin Private File System (~2.65 GB). Streaming from it is a
//            file read and a conversion -- no decoding while you play, and no
//            Opus kept in memory for a key once it is on disk.
//   memory   the Opus bytes, demuxed, decoded by WebCodecs as they play.
//   network  the Cache API first, so a second visit downloads nothing, then
//            the server.
import { demux, unpackHead, opusHead, RATE } from './ogg.js';

const AHEAD = RATE * 1.2;      // decoded ahead of the playhead, per stream
const BLOCK = 4800;            // frames per message to the worklet (100 ms)
const FIRST = 960;             // ...except a stream's first, sent once it has this many
const CONCURRENCY = 6;
const PREROLL = 3840;          // 80 ms of Opus decoded and thrown away before a seek point
const URGENT = 10;

let base = '', tag = '';
let hub = null;                          // MessagePort to the worklet hub
let files = {};                          // key -> file name
let headFrames = Math.round(RATE * 0.25);
let cache = null;                        // Cache API store, or null
const store = new Map();                 // key -> demuxed Opus, in memory
const headDone = new Set();              // keys whose head has been sent to the worklet
const queue = [], pending = new Map();
let dirty = false;                       // queue needs re-sorting
let inflight = 0, loaded = 0, failed = 0, bytes = 0;

// Whether WebCodecs trims the Opus pre-skip itself. Established once, from
// the first thing decoded, because the answer decides where every sample
// starts and it is not something to assume.
let decoderTrims = null;
let calibrating = null;

// ------------------------------------------------------------------ status --
let statusQueued = false;
const haveQueue = [];
function status() {
  if (statusQueued) return;
  statusQueued = true;
  setTimeout(() => {
    statusQueued = false;
    const have = haveQueue.splice(0);
    postMessage({ type: 'status', loaded, failed, bytes, have, installed: disk.installed.size,
      installing: disk.running, streams: streams.size });
  }, 150);
}
function announce(key) { haveQueue.push(key); status(); }

// ------------------------------------------------------------------- fetch --
function want(key, priority = 0) {
  if (store.has(key) || disk.installed.has(key)) return;
  const p = pending.get(key);
  if (p) { if (priority > p.priority) { p.priority = priority; dirty = true; pump(); } return; }
  const file = files[key];
  if (!file) return;
  const job = { key, file, priority };
  pending.set(key, job);
  queue.push(job);
  dirty = true;
  pump();
}

function pump() {
  while (queue.length) {
    if (dirty) { queue.sort((a, b) => b.priority - a.priority); dirty = false; }
    if (inflight >= CONCURRENCY && queue[0].priority < URGENT) break;
    if (queue[0].priority < URGENT && pressed()) break;      // the heartbeat tries again
    const job = queue.shift();
    inflight++;
    load(job)
      .catch((e) => { failed++; console.warn('sample', job.file, e); })
      .finally(() => {
        inflight--; pending.delete(job.key);
        const w = waiters.get(job.key);
        if (w) { waiters.delete(job.key); for (const f of w) f(); }
        status(); pump();
      });
  }
}

// Promises waiting for a key's download to finish, for the install.
const waiters = new Map();

/** The demuxed key once it has arrived; null if it failed. Asks for it if needed. */
function arrived(key) {
  if (store.has(key)) return Promise.resolve(store.get(key));
  return new Promise((res) => {
    const list = waiters.get(key) ?? [];
    list.push(() => res(store.get(key) ?? null));
    waiters.set(key, list);
    want(key, 2);
    // Neither in memory nor on its way (already installed, or no such file).
    if (!pending.has(key) && !store.has(key)) { waiters.delete(key); res(store.get(key) ?? null); }
  });
}

async function fetchBytes(url) {
  let r = null;
  try { r = await cache?.match(url); } catch { r = null; }
  if (!r) {
    r = await fetch(url);
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    try { await cache?.put(url, r.clone()); } catch { /* quota: fine, just not cached */ }
  }
  return new Uint8Array(await r.arrayBuffer());
}

async function load(job) {
  const d = demux(await fetchBytes(`${base}/${job.file}`));
  if (disk.installed.has(job.key)) return;        // installed while it was downloading
  store.set(job.key, d);
  bytes += d.data.byteLength;
  loaded++;
  await calibrate(d);
  if (!headDone.has(job.key)) await sendHead(job.key, d);
  announce(job.key);
}

// ------------------------------------------------------------------ decode --
function config(d) {
  return { codec: 'opus', sampleRate: RATE, numberOfChannels: d.channels, description: d.head };
}

/** Decode packets [0, n) of `d` in one go. Resolves to planar chunks and their total. */
function decodeRange(d, n) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let out = 0;
    const dec = new AudioDecoder({
      output: (ad) => { chunks.push(planes(ad)); out += ad.numberOfFrames; ad.close(); },
      error: reject,
    });
    dec.configure(config(d));
    let ts = 0;
    for (let i = 0; i < n; i++) {
      dec.decode(chunk(d, i, ts));
      ts += d.dur[i];
    }
    dec.flush().then(() => { dec.close(); resolve({ chunks, out, fed: ts }); }, reject);
  });
}

function chunk(d, i, ts) {
  return new EncodedAudioChunk({
    type: 'key', timestamp: Math.round(ts * 1e6 / RATE),
    data: d.data.subarray(d.off[i], d.off[i] + d.len[i]),
  });
}

/** An AudioData as [left, right] Float32Arrays. Mono is doubled. */
function planes(ad) {
  const f = ad.numberOfFrames;
  const L = new Float32Array(f);
  ad.copyTo(L, { planeIndex: 0, format: 'f32-planar' });
  let R = L;
  if (ad.numberOfChannels > 1) { R = new Float32Array(f); ad.copyTo(R, { planeIndex: 1, format: 'f32-planar' }); }
  return [L, R];
}

function trimOf(d) { return decoderTrims ? 0 : d.preskip; }

/**
 * Does the decoder drop the pre-skip itself? Decode a stretch, flush, and see
 * whether what came out is short by it. Either answer is fine; not knowing
 * would put every sample 6.5 ms early or late, and the head and the stream
 * out of step with each other.
 */
function calibrate(d) {
  if (decoderTrims !== null) return Promise.resolve();
  calibrating ??= (async () => {
    try {
      const n = Math.min(d.n, 30);
      const { out, fed } = await decodeRange(d, n);
      decoderTrims = fed - out >= d.preskip / 2;
      postMessage({ type: 'calibrated', decoderTrims });
    } catch (e) {
      postMessage({ type: 'error', message: `this browser cannot decode Opus (WebCodecs): ${e.message ?? e}` });
      throw e;
    }
  })();
  return calibrating;
}

/** Copy frames [from, to) of the decoded file out of `chunks` (which start at `pos0`). */
function slice(chunks, pos0, from, to) {
  const n = Math.max(0, to - from);
  const L = new Float32Array(n), R = new Float32Array(n);
  let p = pos0;
  for (const [cl, cr] of chunks) {
    const a = Math.max(p, from), b = Math.min(p + cl.length, to);
    if (b > a) { L.set(cl.subarray(a - p, b - p), a - from); R.set(cr.subarray(a - p, b - p), a - from); }
    p += cl.length;
    if (p >= to) break;
  }
  return [L, R];
}

function toI16(L, R) {
  const n = L.length, out = new Int16Array(n * 2);
  for (let i = 0; i < n; i++) {
    const l = L[i] * 32768, r = R[i] * 32768;
    out[2 * i] = l > 32767 ? 32767 : l < -32768 ? -32768 : l;
    out[2 * i + 1] = r > 32767 ? 32767 : r < -32768 ? -32768 : r;
  }
  return out;
}

/** Decode the first headFrames of `d` and hand them to the worklet for good. */
async function sendHead(key, d) {
  if (headDone.has(key)) return;
  headDone.add(key);
  try {
    let k = 0, sum = 0;
    const need = trimOf(d) + headFrames + 960;
    while (k < d.n && sum < need) sum += d.dur[k++];
    const { chunks } = await decodeRange(d, k);
    const frames = Math.min(headFrames, d.total);
    const [L, R] = slice(chunks, -trimOf(d), 0, frames);
    const data = toI16(L, R);
    hub.postMessage({ type: 'head', key, data, frames }, [data.buffer]);
  } catch (e) {
    headDone.delete(key);
    console.warn('head', key, e);
  }
}

/** An installed key's head, read straight off its PCM file. */
async function headFromDisk(key) {
  if (headDone.has(key)) return;
  const h = await disk.open(key);
  if (!h) return;
  headDone.add(key);
  const frames = Math.min(headFrames, h.getSize() / 4);
  const data = new Int16Array(frames * 2);
  h.read(data, { at: 0 });
  disk.release(key);
  hub.postMessage({ type: 'head', key, data, frames }, [data.buffer]);
}

function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

/**
 * The heads bundle: the first packets of every sample, in one request. With
 * it every key plays within seconds; without it (not built) each head is
 * decoded from its full file as that arrives, which also works, just later.
 */
async function loadHeads(order) {
  let index, text;
  try {
    const r = await fetch(`${base}/heads.json`);
    if (!r.ok) return false;
    text = await r.text();
    index = JSON.parse(text);
  } catch { return false; }
  // Keyed by the index it belongs to, so a rebuilt bundle is never read
  // from the cache against a new index.
  const bin = await fetchBytes(`${base}/heads.bin?v=${hash(text)}`);
  headFrames = index.headFrames ?? headFrames;
  const parts = new Map();
  for (const [key, [off, len, channels, preskip, total]] of Object.entries(index.entries)) {
    parts.set(key, unpackHead(bin.subarray(off, off + len), { channels, preskip, total, head: opusHead(channels, preskip) }));
  }
  // In the order a player reaches for them, so the middle of the keyboard at
  // mezzo-forte is ready first.
  const ordered = new Set(order);
  const keys = [...order.filter((k) => parts.has(k)), ...[...parts.keys()].filter((k) => !ordered.has(k))];
  // One at a time. Four at once got every head in three seconds sooner and
  // made the notes played meanwhile underrun ten times as often.
  for (const key of keys) {
    const d = parts.get(key);
    // Heads for keys not yet played wait while a note that is playing needs
    // the machine (see pressed()).
    while (pressed()) await new Promise((r) => setTimeout(r, 10));
    await calibrate(d);
    await sendHead(key, d);
    if (store.has(key) || disk.installed.has(key)) announce(key);
  }
  return true;
}

// ----------------------------------------------------------------- streams --
const streams = new Map();     // id -> stream

// A struck note starts playing its head the instant it is struck, and its
// stream has to arrive before the head runs out. The same strike starts a
// score of sympathetic-resonance streams whose voices simply wait for their
// first block. Started all at once they share the machine evenly, and on a
// busy one the struck note's stream came in after its head had run out -- a
// gap in the note. So until every playing voice's stream is SAFE ahead, the
// waiting ones hold off opening a decoder (for SOFT_WAIT at most) and the
// background downloads hold off starting.
const SAFE = RATE * 0.35;
const SOFT_WAIT = 250;         // ms
function pressed() {
  for (const s of streams.values()) if (!s.soft && !s.closed && s.sent < s.end && s.sent - s.consumed < SAFE) return true;
  return false;
}

// Block buffers, back from the worklet once played (see giveBack there) and
// sent out again, so neither thread allocates a stream as it plays.
const pool = [];
const POOL_MAX = 512;          // ~10 MB
function block() { return pool.pop() ?? new Float32Array(BLOCK); }
function recycle(bufs) {
  for (const b of bufs) if (b.byteLength === BLOCK * 4 && pool.length < POOL_MAX) pool.push(new Float32Array(b));
}

class DecodeStream {
  constructor(id, key, d, from, retries = 0, exact = false) {
    this.id = id; this.key = key; this.d = d;
    this.retries = retries;
    this.from = from; this.sent = from; this.consumed = from;
    this.end = d.total;
    this.next = 0; this.ts = 0;
    // A stream that starts well past the head (the resonance enters a
    // recording ~1 s in) seeks instead of decoding everything before it: from
    // the packet PREROLL ahead of `from`, which Opus needs to converge. Output
    // positions follow the same rule as from the top -- whatever the decoder
    // does with the pre-skip, it does it to its first output after configure.
    // Starts at the head keep decoding from packet 0, so the join with the
    // head is sample-exact.
    // A recovery (see recover) decodes from the top as well, so the note
    // carries on sample-exact instead of through a pre-roll's approximation.
    if (!exact && from > headFrames + PREROLL) {
      const want = from + trimOf(d) - PREROLL;
      while (this.next < d.n - 1 && this.ts + d.dur[this.next] <= want) this.ts += d.dur[this.next++];
    }
    this.outPos = this.ts - trimOf(d);
    this.acc = null; this.accN = 0; this.accStart = from;
    this.closed = false;
    // A stream that starts past the head has a voice waiting for it, not one
    // already playing: it can give way to one that is (see pressed()), until
    // its first block is out.
    this.soft = from > headFrames && !retries;
    this.first = true;
    this.born = performance.now();
    this.dec = null;
  }

  open() {
    this.dec = new AudioDecoder({
      output: (ad) => this.onOut(ad),
      error: (e) => this.recover(e),
    });
    this.dec.configure(config(this.d));
    this.dec.addEventListener?.('dequeue', () => this.pump());
  }

  pump() {
    if (this.closed) return;
    if (!this.dec) {
      if (this.soft && performance.now() - this.born < SOFT_WAIT && pressed()) return;
      this.open();
    }
    const d = this.d, trim = trimOf(d);
    // Feed while the decoded-so-far (fed) is short of the target, a few
    // packets in flight at a time so no single stream hogs the decoder --
    // except for the stretch before `sent` that is decoded only to be thrown
    // away: the head, for a note that is already playing it, or what a
    // recovery has to catch up on. Both are racing the playhead.
    const target = Math.min(this.end, this.consumed + AHEAD) + trim;
    while (this.next < d.n && this.ts < target
      && this.dec.decodeQueueSize < (this.ts < this.sent + trim ? 64 : 6)) {
      this.dec.decode(chunk(d, this.next, this.ts));
      this.ts += d.dur[this.next++];
    }
    // Flush once everything up to the end has been fed, not only once every
    // packet has: the last packets of a file can lie wholly past its end, so
    // they are never fed, and without a flush the decoder holds on to its
    // last few frames -- the note's final 50-70 ms played as silence and its
    // stream never ended.
    if ((this.next >= d.n || this.ts >= this.end + trim) && !this.flushing) {
      this.flushing = true;
      this.dec.flush().then(() => this.done(), () => {});
    }
  }

  onOut(ad) {
    if (this.closed) { ad.close(); return; }
    const [L, R] = planes(ad);
    ad.close();
    const p0 = this.outPos;
    this.outPos += L.length;
    const a = Math.max(p0, this.sent), b = Math.min(p0 + L.length, this.end);
    if (b <= a) return;
    this.take(L.subarray(a - p0, b - p0), R.subarray(a - p0, b - p0));
    if (this.sent >= this.end) this.done();
  }

  /** Gather decoded frames into BLOCK-sized messages. */
  take(L, R) {
    let i = 0;
    while (i < L.length) {
      if (!this.acc) { this.acc = [block(), block()]; this.accN = 0; this.accStart = this.sent; }
      const n = Math.min(BLOCK - this.accN, L.length - i);
      this.acc[0].set(L.subarray(i, i + n), this.accN);
      this.acc[1].set(R.subarray(i, i + n), this.accN);
      this.accN += n; this.sent += n; i += n;
      // The first block goes as soon as there is a little of it, when a voice
      // is already playing its head and counting down: 20 ms now beats 100 ms
      // later. A voice still waiting would start on it and run straight out.
      if (this.accN === BLOCK || (this.first && !this.soft && this.accN >= FIRST)) { this.first = false; this.post(); }
    }
  }

  post() {
    if (!this.acc || !this.accN) return;
    let [L, R] = this.acc;
    if (this.accN < BLOCK) {
      L = L.slice(0, this.accN); R = R.slice(0, this.accN);
      recycle([this.acc[0].buffer, this.acc[1].buffer]);
    }
    hub.postMessage({ type: 'block', id: this.id, start: this.accStart, frames: this.accN, L, R }, [L.buffer, R.buffer]);
    this.acc = null; this.accN = 0;
    this.soft = false;
  }

  done() {
    if (this.closed) return;
    this.post();
    hub.postMessage({ type: 'end', id: this.id, total: this.sent });
    this.close();
  }
  fail() {
    if (this.closed) return;
    this.post();
    hub.postMessage({ type: 'fail', id: this.id, at: this.sent });
    this.close();
  }
  /**
   * The decoder died mid-note -- the browser can reclaim one under resource
   * pressure, and a hundred of them are open in a pedalled passage. Pick up
   * where it got to with a fresh decoder, decoding from the top again so the
   * join is exact -- the stream runs over a second ahead of the playhead, so
   * there is time for that -- rather than cut the note off.
   * Twice at most: a file that keeps failing is broken, not unlucky.
   */
  recover(e) {
    if (this.closed) return;
    console.warn('stream', this.key, e);
    if (this.retries >= 2 || this.sent >= this.end) { this.fail(); return; }
    this.post();
    const consumed = this.consumed;
    this.close();
    const s = new DecodeStream(this.id, this.key, this.d, this.sent, this.retries + 1, true);
    s.consumed = consumed;
    streams.set(this.id, s);
    s.pump();
  }
  close() {
    this.closed = true;
    if (streams.get(this.id) === this) streams.delete(this.id);
    try { this.dec?.close(); } catch { /* already */ }
  }
}

class DiskStream {
  constructor(id, key, h, from) {
    this.id = id; this.key = key; this.h = h;
    this.end = h.getSize() / 4;                   // 16-bit stereo
    this.sent = from; this.consumed = from;
    this.closed = false;
    this.buf = new Int16Array(BLOCK * 2);
  }
  pump() {
    if (this.closed) return;
    let budget = 4;                               // blocks per pass, so streams take turns
    while (budget-- > 0 && this.sent < this.end && this.sent < this.consumed + AHEAD) {
      const n = Math.min(BLOCK, this.end - this.sent);
      const view = this.buf.subarray(0, n * 2);
      this.h.read(view, { at: this.sent * 4 });
      const L = n === BLOCK ? block() : new Float32Array(n), R = n === BLOCK ? block() : new Float32Array(n);
      for (let i = 0; i < n; i++) { L[i] = view[2 * i] / 32768; R[i] = view[2 * i + 1] / 32768; }
      hub.postMessage({ type: 'block', id: this.id, start: this.sent, frames: n, L, R }, [L.buffer, R.buffer]);
      this.sent += n;
    }
    if (this.sent >= this.end) {
      hub.postMessage({ type: 'end', id: this.id, total: this.end });
      this.close();
    }
  }
  close() { this.closed = true; if (streams.get(this.id) === this) streams.delete(this.id); disk.release(this.key); }
}

// Voices that stopped before their stream had finished opening (a disk
// handle is async), so the stream is not started for nobody.
const stoppedEarly = new Set();
const opening = new Set();

async function startStream(id, key, from) {
  try {
    if (disk.installed.has(key)) {
      const h = await disk.open(key);
      if (h && stoppedEarly.delete(id)) { disk.release(key); return; }
      if (h) {
        const s = new DiskStream(id, key, h, from);
        streams.set(id, s); s.pump(); return;
      }
    }
    const d = store.get(key);
    if (!d) {
      // Not here: nothing to stream, and the voice has only its head. The
      // engine does not start a note on a key it has not been told is ready,
      // so this is a key evicted by an install in another tab, or a race.
      want(key, URGENT);
      hub.postMessage({ type: 'fail', id, at: from });
      return;
    }
    await calibrate(d);
    if (stoppedEarly.delete(id)) return;
    const s = new DecodeStream(id, key, d, from);
    streams.set(id, s);
    s.pump();
  } catch (e) {
    console.warn('stream', key, e);
    hub.postMessage({ type: 'fail', id, at: from });
  }
}

// A heartbeat, for the decoders whose 'dequeue' event this browser does not
// fire, and for disk streams, which have no events at all.
setInterval(() => {
  for (const s of streams.values()) s.pump();
  if (queue.length && inflight < CONCURRENCY) pump();
}, 25);

function fromWorklet(e) {
  const m = e.data;
  if (m.type === 'start') { opening.add(m.id); startStream(m.id, m.key, m.from).finally(() => { opening.delete(m.id); stoppedEarly.delete(m.id); }); }
  else if (m.type === 'need') {
    const s = streams.get(m.id);
    if (s) { s.consumed = Math.max(s.consumed, m.pos); s.pump(); }
  } else if (m.type === 'free') {
    recycle(m.bufs);
  } else if (m.type === 'stop') {
    const s = streams.get(m.id);
    if (s) s.close(); else if (opening.has(m.id)) stoppedEarly.add(m.id);
  }
}

// -------------------------------------------------------------------- disk --
//
// The opt-in install. Every sample decoded once, in full, to 16-bit stereo
// PCM, one OPFS file per sample; `installed.json` lists the finished ones, so
// a file cut short by closing the tab is simply redone. Reading uses sync
// access handles, which only a dedicated worker may have: a read is a copy
// into a buffer we own, with no promise and no allocation.
const disk = {
  dir: null,
  installed: new Set(),
  running: false,
  handles: new Map(),          // key -> { h, users, used }
  clock: 0,

  async init() {
    try {
      const root = await navigator.storage.getDirectory();
      const name = `piano-pcm-${tag}`;
      // A library rebuilt since the last install is a different library.
      for await (const [n] of root.entries()) {
        if (n.startsWith('piano-pcm-') && n !== name) await root.removeEntry(n, { recursive: true }).catch(() => {});
      }
      this.dir = await root.getDirectoryHandle(name, { create: true });
      const f = await this.dir.getFileHandle('installed.json').catch(() => null);
      if (f) {
        const list = JSON.parse(await (await f.getFile()).text());
        for (const k of list) this.installed.add(k);
      }
    } catch (e) { console.warn('disk', e); this.dir = null; }
  },

  async save() {
    const f = await this.dir.getFileHandle('installed.json', { create: true });
    const w = await f.createWritable();
    await w.write(JSON.stringify([...this.installed]));
    await w.close();
  },

  async open(key) {
    const c = this.handles.get(key);
    if (c) { c.users++; c.used = ++this.clock; return c.h; }
    try {
      const fh = await this.dir.getFileHandle(`${key}.pcm`);
      const h = await fh.createSyncAccessHandle();
      this.handles.set(key, { h, users: 1, used: ++this.clock });
      this.trim();
      return h;
    } catch (e) {
      // Most likely another tab holds the lock. Fall back to the Opus.
      console.warn('disk open', key, e);
      this.installed.delete(key);
      want(key, URGENT);
      return null;
    }
  },

  release(key) {
    const c = this.handles.get(key);
    if (c) c.users = Math.max(0, c.users - 1);
    this.trim();
  },

  /** Keep a bounded number of handles open; the least recently used idle ones go. */
  trim() {
    if (this.handles.size <= 96) return;
    const idle = [...this.handles.entries()].filter(([, c]) => !c.users).sort((a, b) => a[1].used - b[1].used);
    for (const [k, c] of idle.slice(0, this.handles.size - 96)) { try { c.h.close(); } catch { /* */ } this.handles.delete(k); }
  },

  async install(order) {
    if (this.running) return;
    if (!this.dir) { postMessage({ type: 'error', message: 'install stopped: this browser has no private file storage' }); return; }
    this.running = true;
    this.stopReq = false;
    status();
    const keys = order.filter((k) => !this.installed.has(k));
    let next = 0, n = 0, saving = Promise.resolve();
    // Two lanes: one decoding while the other writes, and the fetches for
    // what comes next already on their way.
    const lane = async () => {
      while (next < keys.length && !this.stopReq) {
        const i = next++;
        for (let j = i; j < Math.min(keys.length, i + 12); j++) want(keys[j], 2 - j / 1e6);
        const key = keys[i];
        const d = await arrived(key);
        if (!d || this.stopReq) continue;
        await calibrate(d);
        const { chunks } = await decodeRange(d, d.n);
        const [L, R] = slice(chunks, -trimOf(d), 0, d.total);
        const pcm = toI16(L, R);
        const fh = await this.dir.getFileHandle(`${key}.pcm`, { create: true });
        const h = await fh.createSyncAccessHandle();
        h.truncate(0);
        h.write(pcm, { at: 0 });
        h.flush(); h.close();
        this.installed.add(key);
        // The point of the install: this key no longer needs its Opus in memory.
        if (!streamsUsing(key)) { bytes -= d.data.byteLength; store.delete(key); }
        if (++n % 16 === 0) saving = saving.then(() => this.save());
        status();
      }
    };
    try {
      await Promise.all([lane(), lane()]);
      await saving;
      await this.save();
    } catch (e) {
      console.warn('install', e);
      postMessage({ type: 'error', message: `install stopped: ${e.message}` });
    } finally {
      this.running = false;
      status();
    }
  },
};

function streamsUsing(key) {
  for (const s of streams.values()) if (s.key === key) return true;
  return false;
}

// ---------------------------------------------------------------- messages --
// Requests wait for the disk index, or every installed sample would be
// downloaded again before we knew it was already here.
let initDone;
const inited = new Promise((res) => { initDone = res; });

onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'init') {
    base = m.base; tag = m.tag; files = m.files; hub = m.hub;
    hub.onmessage = fromWorklet;
    try {
      cache = await caches.open(`piano-samples-${tag}`);
      for (const k of await caches.keys()) if (k.startsWith('piano-samples-') && k !== `piano-samples-${tag}`) caches.delete(k);
    } catch { cache = null; }
    await disk.init();
    initDone();
    postMessage({ type: 'ready', installed: [...disk.installed] });
    // Installed keys are playable as soon as their heads are in.
    const hadBundle = await loadHeads(m.order);
    postMessage({ type: 'heads', bundle: hadBundle });
    // An installed key the bundle did not cover (or no bundle at all) takes
    // its head from its own file on disk.
    for (const k of [...disk.installed]) await headFromDisk(k);
  } else if (m.type === 'want') {
    await inited;
    for (const [key, priority] of m.items) want(key, priority);
  } else if (m.type === 'install') {
    await inited;
    disk.install(m.order);
  } else if (m.type === 'stopInstall') {
    disk.stopReq = true;
  }
};
