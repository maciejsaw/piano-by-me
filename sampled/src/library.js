// The sample library: fetching, decoding, and deciding what to keep in memory.
//
// The arithmetic that shapes this file: 88 keys x 16 layers is about 185 MB of
// Opus, which is a reasonable download -- and about 4 GB once decoded, which
// is not a reasonable anything. A browser will not hold the library in RAM, so
// this is a streaming sampler whether it wants to be one or not.
//
// Three things make that invisible while playing:
//
//   a warm order        layers are loaded middle-out from the centre of the
//                       keyboard and from mezzo-forte outwards, because that
//                       is the order a player reaches for them
//   nearest resident    a note-on never waits. If the exact layer is not in
//                       memory it plays the closest one that is, trimmed to
//                       the right level, and queues the real one. The result
//                       is a momentarily approximate timbre instead of a
//                       dropout, which is the right way round.
//   LRU by bytes        eviction is by decoded size, not by count, so one
//                       25-second A0 does not quietly cost what forty C8s do
// Priority of a sample a note is waiting for right now. See pump().
const URGENT = 10;

export class Library {
  constructor(ctx, base, { budgetMb = 640, concurrency = 6 } = {}) {
    this.ctx = ctx;
    this.base = base.replace(/\/$/, '');
    this.budget = budgetMb * 1048576;
    this.concurrency = concurrency;
    this.cache = new Map();                 // key -> { buf, bytes, used }
    this.pending = new Map();               // key -> Promise
    this.queue = [];                        // keys waiting for a slot
    this.inflight = 0;
    // Decoding is gated SEPARATELY from fetching. A fetch is network -- cheap to
    // run many at once -- but decodeAudioData is heavy CPU, and several Opus
    // decodes firing together starve the audio render thread (which is also
    // running the convolvers), so a note playing while they land pops. Fetch
    // stays parallel; decodes are funnelled two at a time. This is why the
    // clicks clustered at session start (the warm-up decode storm) and on the
    // first play of any note (which kicks off its own decode).
    this.decodeConcurrency = 2;
    this.decoding = 0;
    this.decodeWaiters = [];
    this.bytes = 0;
    this.clock = 0;
    // One layer of every key, never evicted. See startWarm.
    this.pinned = new Set();
    this.onprogress = null;
    this.loaded = 0; this.failed = 0;
  }

  async loadManifest() {
    const r = await fetch(`${this.base}/manifest.json`);
    if (!r.ok) throw new Error(`no manifest at ${this.base}/manifest.json (has the library been built?)`);
    this.m = await r.json();
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

  note(midi) { return this.m.notes[midi]; }
  entry(midi, layer) { return this.m.notes[midi]?.layers[layer] ?? null; }

  key(midi, layer) { return `n${midi}v${layer}`; }

  // ---------------------------------------------------------------- memory --
  touch(k) { const c = this.cache.get(k); if (c) c.used = ++this.clock; return c; }

  put(k, buf) {
    const bytes = buf.length * buf.numberOfChannels * 4;
    this.cache.set(k, { buf, bytes, used: ++this.clock });
    this.bytes += bytes;
    this.evict();
  }

  evict() {
    if (this.bytes <= this.budget) return;
    const order = [...this.cache.entries()].sort((a, b) => a[1].used - b[1].used);
    for (const [k, c] of order) {
      if (this.bytes <= this.budget * 0.9) break;
      if (this.held?.has(k)) continue;         // never evict something sounding
      if (this.pinned.has(k)) continue;        // nor the last layer standing for a key
      this.cache.delete(k);
      this.bytes -= c.bytes;
    }
  }

  /** Keys currently attached to a playing voice, which must survive eviction. */
  setHeld(set) { this.held = set; }

  // ----------------------------------------------------------------- fetch --
  /**
   * Decode, but never more than `decodeConcurrency` at once.
   *
   * Highest priority first, not FIFO. During the warm-up there are always a
   * handful of warm files fetched and waiting here, and a key the player has
   * just struck used to queue behind all of them -- which is most of why its
   * first play was a substitute layer for so long. The priority is read from
   * the job when a slot frees, so a bump from want() counts even after the
   * fetch has started.
   */
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
    const { file, k } = job;
    const r = await fetch(`${this.base}/${file}`);
    if (!r.ok) throw new Error(`${r.status} ${file}`);
    // Fetch (network) in parallel, but hold the compressed bytes at the decode
    // gate so the CPU-heavy decode does not glitch whatever is sounding.
    const buf = await this.decode(await r.arrayBuffer(), job);
    this.put(k, buf);
    if (this.floor?.has(k)) this.pinned.add(k);
    this.loaded++;
    this.onprogress?.(this);
    return buf;
  }

  /** Request a buffer. Returns it if resident, otherwise queues and returns null. */
  want(file, k, priority = 0) {
    const c = this.touch(k);
    if (c) return c.buf;
    const p = this.pending.get(k);
    if (p) {
      // Already asked for -- typically by the warm pass, at a low priority and
      // far down the queue. A player asking for it now is a different request.
      if (priority > p.priority) { p.priority = priority; this.pump(); }
      return null;
    }
    const job = { file, k, priority };
    this.pending.set(k, job);
    this.queue.push(job);
    this.pump();
    return null;
  }

  pump() {
    while (this.queue.length) {
      // Highest priority first, and cheap to keep sorted because the queue is
      // only ever appended to between pumps.
      this.queue.sort((a, b) => b.priority - a.priority);
      // A note being played does not wait for a fetch slot: every slot can be
      // held by the warm pass, and a played key is worth one fetch over the cap.
      if (this.inflight >= this.concurrency && this.queue[0].priority < URGENT) break;
      const job = this.queue.shift();
      this.inflight++;
      this.fetchOne(job)
        .catch(() => { this.failed++; })
        .finally(() => { this.inflight--; this.pending.delete(job.k); this.pump(); });
    }
  }

  /**
   * The best layer of `midi` that can sound RIGHT NOW, and the correction for
   * having settled. `trimDb` is how much quieter the wanted layer was than the
   * one being used, so the caller can hand back the level that was asked for.
   */
  best(midi, layer) {
    const n = this.m.notes[midi];
    if (!n) return null;
    const exact = n.layers[layer];
    if (exact) {
      const buf = this.want(exact.file, this.key(midi, layer), URGENT);
      if (buf) return { buf, layer, entry: exact, trimDb: 0 };
      // A miss means the player is somewhere memory is not. The next strike of
      // this key will rarely be at exactly the same velocity, so queue the
      // layers either side as well -- below the release samples and the floor,
      // which matter more, and above the rest of the warm pass.
      for (const l of [layer - 1, layer + 1]) {
        if (n.layers[l]) this.want(n.layers[l].file, this.key(midi, l), 4);
      }
    }
    let found = null, bestD = 1e9;
    for (const l of this.layers) {
      const c = this.cache.get(this.key(midi, l));
      if (!c || !n.layers[l]) continue;
      const d = Math.abs(l - layer);
      if (d < bestD) { bestD = d; found = { buf: c.buf, layer: l, entry: n.layers[l] }; }
    }
    if (!found) return null;
    this.touch(this.key(midi, found.layer));
    found.trimDb = (this.relDb[midi]?.[layer] ?? 0) - (this.relDb[midi]?.[found.layer] ?? 0);
    return found;
  }

  /** A short auxiliary sample -- key release or damper resonance. */
  aux(desc, k, priority = 1) { return desc ? this.want(desc.file, k, priority) : null; }

  /**
   * Stop filling memory.
   *
   * For offline rendering: a warm pass running underneath a performance can
   * evict a sample the performance is about to need, which is fine while
   * playing (the nearest resident layer covers it) and not fine when the point
   * is to hear exactly the layers the score asks for.
   */
  stopWarm() { this.stopped = true; this.queue.length = 0; }

  /** How many keys are guaranteed to speak: one pinned layer each. */
  keysReady() {
    let n = 0;
    const soft = this.layers[0];
    for (let m = this.m.keys.lo; m <= this.m.keys.hi; m++) if (this.pinned.has(this.key(m, soft))) n++;
    return n;
  }

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
   * These go first in the warm order and it matters more than their size
   * suggests. They are fetched on demand otherwise, and a fetch takes longer
   * than a key release does -- so the FIRST time any key was let go, its
   * release sample was not there yet and nothing was heard. Silently. All 268
   * of them together are a few megabytes, against 190 for the note layers.
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
   * Fill memory in the order a player empties it.
   *
   * Layers first in the order 12, 8, 16, 4, 14, 10, 6, 2, ... -- mezzo-forte
   * before the extremes, because that is where most notes land and because a
   * near-miss there is least audible. Keys outward from middle C.
   */
  warmOrder(lo, hi) {
    const ls = [...this.layers].sort((a, b) => score(a) - score(b));
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

  /**
   * Fill memory, and pin a floor under it.
   *
   * Two things are pinned -- never evicted, whatever the LRU thinks -- and
   * both are there to close off a failure that is worse than it sounds: a key
   * with nothing resident makes NO sound, and the player cannot tell that
   * from a dud key.
   *
   *   the release samples   14 MB of key-up thuds and 120 MB of damper
   *                         releases. Small, wanted on every key lift, and
   *                         their absence is silent -- the first time a key
   *                         was let go, nothing happened, and the fetch it
   *                         queued arrived too late to be heard.
   *   the softest layer     one per key, about 190 MB. The SOFTEST, because
   *                         those are the shortest files: a mezzo-forte layer
   *                         for every key is 383 MB, which is most of the
   *                         budget spent on a floor that is almost never the
   *                         thing actually playing. When a better layer is
   *                         resident it is used; this is only what stops the
   *                         key going quiet, level-matched by best() so it is
   *                         the timbre that is approximate and not the level.
   *
   * Order matters: both of those are loaded before the mezzo-forte pass, and
   * both are quick because soft, short samples are small ones.
   *
   * On a small budget the pin is skipped, because pinning most of the memory
   * would leave nothing to stream with.
   */
  startWarm(lo, hi, limitMb = null) {
    const soft = this.layers[0];
    const floor = [];
    for (let m = lo; m <= hi; m++) {
      const e = this.entry(m, soft);
      if (e) floor.push({ file: e.file, k: this.key(m, soft) });
    }
    const aux = this.auxOrder(lo, hi);
    const order = [
      ...aux.map((j, i) => ({ ...j, priority: 6 - i / 1e6 })),
      ...floor.map((j, i) => ({ ...j, priority: 5 - i / 1e6 })),
      ...this.warmOrder(lo, hi),
    ];
    const cap = (limitMb ?? this.budget / 1048576 * 0.8) * 1048576;
    this.floor = this.budget >= 300 * 1048576
      ? new Set([...aux.map((j) => j.k), ...floor.map((j) => j.k)])
      : new Set();
    let i = 0;
    const step = () => {
      if (this.stopped) { this.warming = false; return; }
      while (i < order.length && this.queue.length < 40) {
        if (this.bytes > cap) { this.warming = false; return; }
        const j = order[i++];
        if (!this.cache.has(j.k)) this.want(j.file, j.k, j.priority);
      }
      if (i < order.length) setTimeout(step, 120); else this.warming = false;
    };
    this.warming = true;
    step();
  }
}
