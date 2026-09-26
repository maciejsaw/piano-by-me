// Does the one-worklet voice renderer (engine.renderer = true, voices.js)
// sound like the node-per-voice path? The same scripted performance --
// notes, chords, the pedal and half pedal, re-strikes, a quick pedal change
// that brings falling strings back, many strings at once, a panic -- is
// played through the whole engine both ways in one page, the dry bus
// recorded sample for sample, and the two compared.
//
//   npm run sampled:ab:renderer [-- --limit -90]
//
// To make two runs comparable at all:
//   - the engine runs on a virtual clock (its ctx.currentTime), 100 ms
//     ahead of the audio clock (audioNow stays the real one), and every event and resonance tick is
//     at a scripted time on it;
//   - Math.random is seeded the same for each run (damper stagger, round robin);
//   - the resonance enters its recordings at the head's start (startAt 0),
//     since a start past the head waits for the stream, a few ms at random,
//     and the stream then has the whole head to catch up in;
//   - only the dry bus is recorded (no rooms);
//   - it waits until the library has stopped loading.
// A warm-up run goes first: the release and damper noises load on first
// use. The node-per-voice path is then played twice, and must match itself exactly,
// to show the harness is deterministic.
//
// Passes if the renderer is within LIMIT dB of the peak everywhere.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROME = [process.env.CHROMIUM, '/opt/pw-browsers/chromium'].find((p) => p && existsSync(p));
const PORT = process.env.PORT || '8136';
const arg = (k) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : null);
const LIMIT = Number(arg('--limit') ?? -90);
const SETUP = arg('--setup');

const server = spawn(process.execPath, [join(REPO, 'tools', 'serve.mjs')], { env: { ...process.env, PORT }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 500));
const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required'],
  ...(CHROME ? { executablePath: CHROME } : {}),
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') errors.push(m.text()); });
await page.goto(`http://localhost:${PORT}/sampled/`, { waitUntil: 'domcontentloaded' });
await page.evaluate(() => { document.getElementById('installChk').checked = false; });
await page.click('#startBtn');
await page.waitForFunction(() => window.piano, null, { timeout: 30000 });
await page.waitForFunction(() => window.piano.lib.keysReady() >= 88, null, { timeout: 120000 });
await page.waitForFunction(() => window.piano.lib.streamer.headsBundle !== null, null, { timeout: 120000 });
// Wait for the whole library: a note plays the best layer in memory, so one
// arriving between runs would change what a run plays.
await page.evaluate(async () => {
  const { lib } = window.piano;
  const lo = lib.m.keys.lo, hi = lib.m.keys.hi;
  let last = '', same = 0;
  for (let i = 0; i < 400 && same < 8; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const now = `${lib.loaded}/${lib.auxResident(lo, hi)}`;
    same = now === last ? same + 1 : 0;
    last = now;
  }
});

const got = await page.evaluate(async ([SETUP, DEBUG]) => {
  const { ctx, engine } = window.piano;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const SR = ctx.sampleRate, MARGIN = 0.1, SECS = 13;

  // A recorder of a fixed frame range, so runs line up to the sample.
  // It counts frames itself: `currentFrame` is now and then not moved on
  // between two render quanta (seen here, under load), which put a quantum
  // in the wrong place. How often is reported.
  const src = `
    class RangeRec extends AudioWorkletProcessor {
      constructor() { super(); this.from = Infinity; this.frame = -1; this.odd = 0; this.port.onmessage = (e) => {
        this.from = e.data.from; this.n = e.data.n; this.L = new Float32Array(this.n); this.R = new Float32Array(this.n); this.odd = 0; }; }
      process(inputs) {
        if (this.frame < 0) this.frame = currentFrame;
        else { this.frame += 128; if (currentFrame !== this.frame) this.odd++; }
        const f = this.frame;
        const inp = inputs[0], L = inp[0], R = inp[1] ?? inp[0];
        if (f + 128 <= this.from || this.from === Infinity) return true;
        for (let i = 0; i < 128; i++) {
          const k = f + i - this.from;
          if (k >= 0 && k < this.n) { this.L[k] = L ? L[i] : 0; this.R[k] = R ? R[i] : 0; }
        }
        if (f + 128 >= this.from + this.n) {
          this.port.postMessage({ L: this.L, R: this.R, odd: this.odd }, [this.L.buffer, this.R.buffer]);
          this.from = Infinity;
        }
        return true;
      }
    }
    registerProcessor('range-rec', RangeRec);`;
  await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
  const rec = new AudioWorkletNode(ctx, 'range-rec', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2, channelCountMode: 'explicit', outputChannelCount: [2] });
  const mute = ctx.createGain(); mute.gain.value = 0;
  rec.connect(mute).connect(ctx.destination);
  engine.dry.connect(rec);

  // The engine's clock, and the resonance's, taken over.
  let vnow = 0;
  const clock = new Proxy(ctx, {
    get(t, k) {
      if (k === 'currentTime') return vnow;
      const v = Reflect.get(t, k);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  engine.ctx = clock; engine.res.ctx = clock;
  // A fade held partway is put back from where the audio really is.
  engine.audioNow = engine.res.audioNow = () => ctx.currentTime;
  const tick = engine.tick.bind(engine);
  engine.tick = () => {};                     // main.js's timer: the script ticks instead
  engine.res.startAt = 0;
  if (SETUP) new Function('engine', SETUP)(engine);
  const realRandom = Math.random;

  // [time s, action]
  const S = [];
  const on = (t, m, v) => S.push([t, (w) => engine.noteOn(m, v, w)]);
  const off = (t, m) => S.push([t, (w) => engine.noteOff(m, 64, w)]);
  const ped = (t, v) => S.push([t, (w) => engine.setPedal(v, w)]);
  on(0.1, 60, 90); off(1.0, 60);                                        // a note and its damper
  ped(1.3, 1); for (const m of [48, 55, 64, 67]) on(1.4, m, 100);       // pedalled chord
  for (const m of [48, 55, 64, 67]) off(1.9, m);
  on(2.2, 55, 110); on(2.5, 55, 70); off(2.6, 55);                      // re-strikes pile up, top-ups
  ped(3.2, 0); ped(3.3, 1);                                             // quick change: strings come back
  on(3.5, 72, 80); off(3.8, 72);
  ped(4.4, 0);                                                          // the lift, swept, damper sounds
  for (let i = 0; i < 8; i++) { on(4.8 + i * 0.09, 62, 60 + i * 8); off(4.84 + i * 0.09, 62); }   // repeated, no pedal
  ped(5.8, 0.6); for (const m of [36, 43, 52, 59, 64, 71, 76, 83]) on(5.9, m, 105);             // many strings
  for (const m of [36, 43, 52, 59, 64, 71, 76, 83]) off(6.6, m);
  ped(7.2, 0.25);                                                       // half pedal
  on(7.6, 40, 100); on(7.62, 47, 95); off(8.4, 40); off(8.45, 47);
  ped(8.8, 0);
  on(9.3, 96, 100); on(9.35, 101, 90); on(9.4, 30, 120); ped(9.6, 1);   // undamped top, a bass
  off(10.2, 96); off(10.2, 101); off(10.3, 30);
  S.push([11.0, () => engine.panic()]);
  for (let t = 0; t < SECS - 0.5; t += 0.04) S.push([t, () => tick(0.04)]);
  S.sort((a, b) => a[0] - b[0]);

  // DEBUG: what each run plays and posts to the renderer, to find where two runs part.
  let played = [], T0g = 0, idBase = 0;
  if (DEBUG) {
    const { StreamSource } = await import('/sampled/src/stream.js');
    const { RVoice } = await import('/sampled/src/voices.js');
    for (const C of [StreamSource, RVoice]) {
      const st = C.prototype.start;
      C.prototype.start = function (when, offset, fade) { played.push(`v ${(when - T0g).toFixed(5)} ${this.key} ${offset.toFixed(5)} ${fade}`); return st.apply(this, arguments); };
    }
    const { VoiceRenderer } = await import('/sampled/src/voices.js');
    const post = VoiceRenderer.prototype.post;
    VoiceRenderer.prototype.post = function (op) {
      const rel = op.map((x, i) => (typeof x === 'number' && x > T0g - 1 && x < T0g + 100 ? `t${(x - T0g).toFixed(6)}` : x instanceof Float32Array ? `c${x.length}:${x[0]}` : Array.isArray(x) ? x.map((y) => (typeof y === 'number' && y > T0g - 1 && y < T0g + 100 ? `t${(y - T0g).toFixed(6)}` : y instanceof Float32Array ? `c${y.length}` : y)).join(',') : x));
      // Ids differ between runs: make them relative.
      if (op[0] === 'v' || op[0] === 's' || op[0] === 'x' || op[0] === 'r' || op[0] === 'rate' || (op[0] === 'p' && op[1] === 'v')) rel[op[0] === 'p' ? 2 : 1] = `v${op[op[0] === 'p' ? 2 : 1] - idBase}`;
      played.push('op ' + rel.join(' '));
      return post.call(this, op);
    };
    const os = engine.oneShot.bind(engine);
    engine.oneShot = (buf, gain, rate, when, offset, dest) => { played.push(`o ${((when ?? 0) - T0g).toFixed(5)} ${buf ? buf.length : 'none'} ${gain.toFixed(6)} ${(offset ?? 0).toFixed(6)}`); return os(buf, gain, rate, when, offset, dest); };
  }

  async function run(renderer) {
    played = [];
    if (DEBUG) idBase = (await import('/sampled/src/stream.js')).newVoiceId();
    engine.panic(); await wait(1500);
    engine.renderer = renderer;
    let seed = 12345;
    const seeded = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
    const T0 = T0g = Math.ceil((ctx.currentTime + 0.5) * SR / 128) * 128 / SR;
    const done = new Promise((r) => { rec.port.onmessage = (e) => r(e.data); });
    rec.port.postMessage({ from: Math.round(T0 * SR), n: Math.round(SECS * SR) });
    let late = 0;
    for (const [t, act] of S) {
      while (ctx.currentTime < T0 + t - MARGIN) await wait(2);
      if (ctx.currentTime > T0 + t - 0.01) late++;
      // A third of a sample off the grid: an event exactly on a sample
      // boundary can round to either side of it from one run to the next.
      vnow = T0 + t + 1 / (3 * SR);
      // Seeded only inside the engine's own calls: the page's UI draws on
      // Math.random too, whenever it likes.
      Math.random = seeded;
      try { act(vnow); } finally { Math.random = realRandom; }
    }
    const r = await done;
    return { ...r, late, played };
  }
  await run(false);                           // warm-up: noises and streams loaded on first use
  const a = await run(false);
  const b = await run(true);
  const a2 = await run(false);
  const b2 = await run(true);
  engine.renderer = false;
  engine.ctx = ctx; engine.res.ctx = ctx; engine.tick = tick;
  delete engine.audioNow; delete engine.res.audioNow;
  const enc = (x) => {
    const bytes = new Uint8Array(x.buffer);
    let s = '';
    for (let k = 0; k < bytes.length; k += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(k, k + 0x8000));
    return btoa(s);
  };
  return { SR, odd: [a.odd, b.odd, a2.odd, b2.odd], played: [a.played, b.played, a2.played, b2.played], late: [a.late, b.late, a2.late, b2.late], runs: [a, b, a2, b2].map((r) => ({ L: enc(r.L), R: enc(r.R) })) };
}, [SETUP, !!process.env.DEBUG]);
await browser.close();
server.kill();

const dec = (s) => { const b = Buffer.from(s, 'base64'); return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4); };
const [A, B, A2, B2] = got.runs.map((r) => ({ L: dec(r.L), R: dec(r.R) }));
const SR = got.SR, N = A.L.length, QN = Math.ceil(N / 128);
let peak = 0;
for (const x of [A.L, A.R]) for (const v of x) peak = Math.max(peak, Math.abs(v));
/** Largest difference in each render quantum. */
const perQ = (x, y) => {
  const d = new Float64Array(QN);
  for (const ch of ['L', 'R']) for (let i = 0; i < N; i++) { const e = Math.abs(x[ch][i] - y[ch][i]); if (e > d[i >> 7]) d[i >> 7] = e; }
  return d;
};
if (process.env.DUMP) {
  const { writeFileSync } = await import('node:fs');
  for (const [nm, x] of [['A', A], ['B', B], ['A2', A2], ['B2', B2]]) { writeFileSync(`${process.env.DUMP}/${nm}.L.f32`, Buffer.from(x.L.buffer)); writeFileSync(`${process.env.DUMP}/${nm}.R.f32`, Buffer.from(x.R.buffer)); }
}
if (process.env.DEBUG) {
  const [pb, pb2] = [got.played[1], got.played[3]].map((l) => l.filter((x) => !x.startsWith('op m ')));
  let shown = 0;
  for (let i = 0; i < Math.max(pb.length, pb2.length) && shown < 10; i++) if (pb[i] !== pb2[i]) { console.log(`  #${i}: B  [${pb[i]}]\n        B2 [${pb2[i]}]`); shown++; }
  console.log(`  ops/plays: B ${pb.length}, B2 ${pb2.length}`);
  if (process.env.DEBUG === 'ops') for (const l of pb) if (/^op (c|cx|p c) /.test(l)) console.log('   ', l.slice(0, 160));
}
const dAA = perQ(A, A2), dBB = perQ(B, B2), dAB = perQ(A, B), dA2B = perQ(A2, B);
const db = (d) => (d ? (20 * Math.log10(d / peak)).toFixed(1) : '-inf');
// A quantum where the two native runs differ by more than this has glitched
// in one of them (see below); the renderer is held to the run it matches.
const GLITCH = peak * 1e-4;
let glitches = 0, worst = 0, at = 0;
const wins = new Float64Array(Math.ceil(N / (SR / 2)));
for (let q = 0; q < QN; q++) {
  if (dAA[q] > GLITCH) glitches++;
  const d = Math.min(dAB[q], dA2B[q]);
  if (d > worst) { worst = d; at = q * 128 / SR; }
  const w = Math.floor(q * 128 / (SR / 2));
  wins[w] = Math.max(wins[w], d);
}
const selfB = Math.max(...dBB);
console.log(`\n  dry bus, ${(N / SR).toFixed(1)} s, peak ${peak.toFixed(3)}; events late (<10 ms ahead): ${got.late.join(' / ')}`);
console.log(`  currentFrame not moved on by 128, per run: ${got.odd.join(' / ')}`);
console.log(`  renderer vs itself:        max difference ${db(selfB)} dB below peak`);
console.log(`  node per voice vs itself:  ${glitches} of ${QN} render quanta differ by more than ${db(GLITCH)} dB`);
console.log(`  renderer vs node per voice (the run without a glitch there): max difference ${db(worst)} dB below peak (at ${at.toFixed(3)} s)`);
console.log('  per half second:  ' + [...wins].map((d, i) => `${(i * 0.5).toFixed(1)}s ${db(d)}`).join('  '));
if (errors.length) console.log(`  page warnings/errors: ${errors.join(' | ')}`);
const ok = 20 * Math.log10(Math.max(selfB, 1e-30) / peak) <= -120 && 20 * Math.log10(Math.max(worst, 1e-30) / peak) <= LIMIT && !errors.length;
console.log(ok ? `\n  RENDERER MATCHES (within ${LIMIT} dB)\n` : `\n  RENDERER DIFFERS (limit ${LIMIT} dB${selfB ? '; renderer not deterministic' : ''})\n`);
process.exit(ok ? 0 : 1);
