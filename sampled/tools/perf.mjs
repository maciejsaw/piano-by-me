// How much can the sampled piano play before it drops out?
//
//   npm run sampled:perf [-- --json out.json] [-- --setup "js"] [-- --micro]
//                        [-- --nodes [idle,churn,proto]]
//
// Loads the page, waits until every key and every head is in, then climbs a
// ladder: at each level a chord is struck over and over for LEVEL_MS, with
// more keys and faster repeats than the level before -- from 1 key every
// 800 ms up to 21 keys every 35 ms, geometrically. Its tails are counted
// with it. The ladder stops after STOP_AFTER failed levels, so a struggling
// build is measured quickly. Done twice: without the pedal and with it held.
//
// A level FAILS if it loses FAIL_MS or more of audio, or a stream underruns,
// twice running: a failed level is played again, and one that passes the
// second time is reported as flaky rather than failed. (Isolated 3-4 ms
// steps, and the odd larger spike, happen even with two voices sounding and
// resonance off: background, not load. Real overload loses tens to hundreds
// of ms per level, every time.)
//
// The SCORE of a ladder is the last level before the first failure. The goal
// is to push it up.
//
// Dropouts are measured by a probe AudioWorklet. On every render callback it
// takes lag = wall clock - audio clock and keeps the minimum per 50 ms
// window (callbacks come in bursts, so the raw lag saw-tooths by a few ms;
// the windowed minimum is flat). A render that falls behind never catches
// up, so a step up in that minimum IS audio lost, and a step of 3 ms or more
// is a dropout (counted, and shown as `drops`). Checked: idle reads 0; a CPU
// hog of 2.5 ms per 2.67 ms render quantum reads ~120 ms lost per second.
//
// Also per level: stream underruns (silence inside a note, which the probe
// cannot see), peak sample voices actually running (fading ones included)
// against what the engine counts, and the main-thread cost of noteOn.
//
// --setup runs a line of JavaScript in the page first, with `engine` and
// `piano` in scope, for A/B experiments: --setup "engine.res.enabled = false".
// A measurement, not pass/fail: compare runs on the same machine.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROME = [process.env.CHROMIUM, '/opt/pw-browsers/chromium'].find((p) => p && existsSync(p));
const PORT = process.env.PORT || '8143';
const arg = (k) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : null);
const JSON_OUT = arg('--json'), SETUP = arg('--setup'), MICRO = process.argv.includes('--micro');
const NODES = process.argv.includes('--nodes') ? (arg('--nodes')?.startsWith('-') ? null : arg('--nodes')) ?? 'idle,churn,proto' : null;
const LEVELS = 20, LEVEL_MS = 1600, STOP_AFTER = 3, FAIL_MS = 10;

const server = spawn(process.execPath, [join(REPO, 'tools', 'serve.mjs')], { env: { ...process.env, PORT }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 500));
const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required'],
  ...(CHROME ? { executablePath: CHROME } : {}),
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.text().startsWith('PERF ')) console.log(m.text().slice(5)); });
await page.goto(`http://localhost:${PORT}/sampled/`, { waitUntil: 'domcontentloaded' });
await page.evaluate(() => { document.getElementById('installChk').checked = false; });
await page.click('#startBtn');
await page.waitForFunction(() => window.piano, null, { timeout: 30000 });
await page.waitForFunction(() => window.piano.lib.keysReady() >= 88, null, { timeout: 120000 });
await page.waitForFunction(() => window.piano.lib.streamer.headsBundle !== null, null, { timeout: 120000 });

// The dropout probe, shared by both modes: installs itself in the page as
// window.__probe() -> Promise<{ lost, drops }> since the last call.
await page.evaluate(async () => {
  const { ctx } = window.piano;

  const src = `
    class PerfProbe extends AudioWorkletProcessor {
      constructor() {
        super();
        this.floor = null; this.win = Infinity; this.left = 2400;
        this.lost = 0; this.drops = 0;
        this.port.onmessage = () => {
          this.port.postMessage({ lost: this.lost, drops: this.drops });
          this.lost = 0; this.drops = 0;
        };
      }
      process() {
        const lag = Date.now() - currentFrame / sampleRate * 1000;
        if (lag < this.win) this.win = lag;
        if ((this.left -= 128) <= 0) {
          if (this.floor === null || this.win < this.floor) this.floor = this.win;
          else if (this.win > this.floor + 3) { this.lost += this.win - this.floor; this.drops++; this.floor = this.win; }
          this.win = Infinity; this.left = 2400;
        }
        return true;
      }
    }
    registerProcessor('perf-probe', PerfProbe);`;
  await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
  const probe = new AudioWorkletNode(ctx, 'perf-probe');
  const mute = ctx.createGain(); mute.gain.value = 0;
  probe.connect(mute).connect(ctx.destination);
  window.__probe = () => new Promise((r) => { probe.port.onmessage = (e) => r(e.data); probe.port.postMessage(0); });
});

if (MICRO) await micro();
if (NODES) await nodes(NODES.split(','));

const results = MICRO || NODES ? [] : await page.evaluate(async ({ setup, LEVELS, LEVEL_MS, STOP_AFTER, FAIL_MS }) => {
  const { ctx, engine, lib } = window.piano;
  if (setup) new Function('engine', 'piano', setup)(engine, window.piano);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const readProbe = window.__probe;

  // Every sample voice alive, fading ones included: what the audio thread runs.
  const { StreamSource } = await import('/sampled/src/stream.js');
  let live = 0;
  const realStart = StreamSource.prototype.start;
  StreamSource.prototype.start = function (...a) {
    live++;
    const prev = this.node.port.onmessage;
    this.node.port.onmessage = (e) => { if (e.data.type === 'ended') live--; prev?.call(this.node.port, e); };
    return realStart.apply(this, a);
  };

  // Spread across the keyboard, so the chord grows in range as well as size.
  const POOL = [48, 52, 55, 60, 64, 67, 36, 72, 43, 76, 40, 79, 57, 84, 45, 62, 69, 38, 74, 50, 88];
  // Geometric in both, from 1 key every 800 ms to 21 keys every 35 ms.
  const level = (k) => {
    const u = (k - 1) / (LEVELS - 1);
    return { keys: POOL.slice(0, Math.round(Math.pow(21, u))), every: Math.round(800 * Math.pow(35 / 800, u)) };
  };

  const ladders = [];
  for (const pedal of [false, true]) {
    const rows = [];
    let failed = 0;
    engine.panic(); await wait(1500); await readProbe();
    const play = async (k) => {
      const { keys, every } = level(k);
      const u0 = lib.streamer.underruns, times = [];
      let peakLive = 0, peakVoices = 0, peakRes = 0;
      const sample = setInterval(() => {
        const s = engine.stats();
        peakLive = Math.max(peakLive, live); peakVoices = Math.max(peakVoices, s.voices); peakRes = Math.max(peakRes, s.resonating);
      }, 20);
      if (pedal) engine.setPedal(1);
      const until = performance.now() + LEVEL_MS;
      while (performance.now() < until) {
        for (const m of keys) { const t = performance.now(); engine.noteOn(m, 96); times.push(performance.now() - t); }
        await wait(every * 0.7);
        for (const m of keys) engine.noteOff(m);
        await wait(every * 0.3);
      }
      if (pedal) engine.setPedal(0);
      await wait(600);                               // the tails are part of the load
      clearInterval(sample);
      const p = await readProbe();
      engine.panic(); await wait(300); await readProbe();   // start the next level clean
      times.sort((a, b) => a - b);
      const row = { level: k, keys: keys.length, every, lost: p.lost, drops: p.drops,
        underruns: lib.streamer.underruns - u0, live: peakLive, voices: peakVoices, resVoices: peakRes,
        noteOnMedian: times[times.length >> 1] ?? 0 };
      row.failed = p.lost >= FAIL_MS || row.underruns > 0;
      return row;
    };
    for (let k = 1; k <= LEVELS && failed < STOP_AFTER; k++) {
      let row = await play(k);
      // A one-off spike is not the level's load: a failure counts only if the
      // level fails again straight away.
      if (row.failed) {
        const again = await play(k);
        if (!again.failed) { again.flaky = row.lost; row = again; }
      }
      rows.push(row);
      if (row.failed) failed++;
      console.log(`PERF   ${pedal ? 'pedal   ' : 'no pedal'} level ${String(k).padStart(2)}: ${String(row.keys).padStart(2)} keys every ${String(row.every).padStart(3)} ms`
        + `  lost ${row.lost.toFixed(0).padStart(5)} ms  drops ${String(row.drops).padStart(3)}  underruns ${row.underruns}`
        + `  live ${String(row.live).padStart(3)} (engine ${row.voices} + ${row.resVoices})  noteOn ${row.noteOnMedian.toFixed(2)} ms`
        + (row.failed ? '  FAIL' : row.flaky != null ? `  (passed on retry; first try lost ${row.flaky.toFixed(0)} ms)` : ''));
    }
    const first = rows.find((r) => r.failed);
    ladders.push({ pedal, score: first ? first.level - 1 : rows.length, rows });
  }
  engine.panic();
  return ladders;
}, { setup: SETUP, LEVELS, LEVEL_MS, STOP_AFTER, FAIL_MS });
await browser.close();
server.kill();

console.log('');
if (SETUP) console.log(`  setup: ${SETUP}`);
for (const l of results) {
  const r = l.rows[l.score - 1];
  console.log(`  SCORE ${l.pedal ? 'pedal   ' : 'no pedal'} ${String(l.score).padStart(2)} / ${LEVELS}`
    + (r ? `   (clean up to ${r.keys} keys every ${r.every} ms, ${r.live} voices running)` : '   (dropped at the first level)'));
}
if (errors.length) console.log(`  page errors: ${errors.join(' | ')}`);
console.log('');
if (JSON_OUT && !MICRO && !NODES) writeFileSync(JSON_OUT, JSON.stringify({ at: new Date().toISOString(), setup: SETUP, levels: LEVELS, results }, null, 2));

// --micro: what one voice costs the audio thread, by chain. N silent voices
// of a chain are started (real streams on real keys, output muted), held
// for a second, and the probe read; N goes up by half each step until the
// probe fails. The N reached is the chain's capacity on this machine.
//   node      the voice worklet alone
//   note      + level, attack, release gains (a struck note's chain)
//   res       + 2 high-pass + 1 low-pass biquad, fixed frequencies (a resonance voice)
//   res-auto  res, with the filter frequencies moved by setTargetAtTime as
//             the resonance does (partial filter, tone)
async function micro() {
  const rows = await page.evaluate(async ({ FAIL_MS }) => {
    const { ctx, lib } = window.piano;
    const { StreamSource } = await import('/sampled/src/stream.js');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const readProbe = window.__probe;
    const sink = ctx.createGain(); sink.gain.value = 0; sink.connect(ctx.destination);
    const keys = [];
    for (let m = 21; m <= 108; m++) { const b = lib.best(m, lib.layers[0]); if (b) keys.push(b); }
    const chain = (kind, src, i) => {
      let at = src.node;
      const nodes = [];
      const link = (n) => { at.connect(n); at = n; nodes.push(n); };
      if (kind !== 'node') {
        if (kind.startsWith('res')) {
          for (let j = 0; j < 2; j++) { const h = ctx.createBiquadFilter(); h.type = 'highpass'; h.Q.value = Math.SQRT1_2; h.frequency.value = 10; link(h); }
          const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.5; lp.frequency.value = 3400; link(lp);
          if (kind === 'res-auto') {
            const t = ctx.currentTime;
            nodes[0].frequency.setTargetAtTime(200 + i, t, 0.05); nodes[1].frequency.setTargetAtTime(200 + i, t, 0.05);
            lp.frequency.setTargetAtTime(3400, t, 0.02);
          }
          link(ctx.createGain()); link(ctx.createGain());
        } else { link(ctx.createGain()); link(ctx.createGain()); link(ctx.createGain()); }
      }
      at.connect(sink);
      return nodes;
    };
    const out = [];
    for (const kind of ['node', 'note', 'res', 'res-auto']) {
      let best = 0;
      for (let n = 8; n <= 512; n = Math.ceil(n * 1.5)) {
        const trial = async () => {
        const voices = [];
        for (let i = 0; i < n; i++) {
          const b = keys[i % keys.length];
          const src = new StreamSource(lib.streamer, b.key, b.frames);
          const nodes = chain(kind, src, i);
          src.start(ctx.currentTime + 0.05, 0);
          voices.push({ src, nodes });
        }
        await wait(400); await readProbe();         // creation is not the load being measured
        await wait(1000);
        const p = await readProbe();
        for (const v of voices) { v.src.stop(); for (const x of v.nodes) x.disconnect(); }
        await wait(500); await readProbe();
        return p;
        };
        // As in the ladder: a failure counts only if it happens twice running.
        let p = await trial();
        if (p.lost >= FAIL_MS) p = await trial();
        const ok = p.lost < FAIL_MS;
        console.log(`PERF   ${kind.padEnd(8)} ${String(n).padStart(3)} voices  lost ${p.lost.toFixed(0).padStart(4)} ms  drops ${p.drops}${ok ? '' : '  FAIL'}`);
        if (!ok) break;
        best = n;
      }
      out.push({ kind, capacity: best });
    }
    return out;
  }, { FAIL_MS });
  console.log('');
  for (const r of rows) console.log(`  CAPACITY ${r.kind.padEnd(8)} ${r.capacity} voices`);
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ at: new Date().toISOString(), micro: rows }, null, 2));
}

// --nodes: the measurements that decide whether voices should share nodes
// (sampled/PLAN-voices.md, stage 0). Parts, comma-separated (default all):
//   idle   capacity of voice nodes that exist but have not started (a pool's
//          spares), output connected and not; an empty worklet for scale
//   churn  voice nodes created and ended K times a second (note chain,
//          50 ms each), with nothing else playing and with a steady load of
//          60% of the note chain's capacity; lost ms per 8 s, against the
//          same live count held without churn
//   proto  capacity of ONE worklet node playing N voices in plain JS: copy
//          from a buffer, 3 per-sample gain ramps, per-key accumulate and
//          2x2 matrix; `res` adds 3 biquads per voice, fixed; `res-auto`
//          recomputes their coefficients every sample, `res-block` once
//          per 128 samples. Compare with the node-per-voice chains, measured
//          in the same run.
async function nodes(parts) {
  const res = await page.evaluate(async ({ FAIL_MS, parts }) => {
    const { ctx, lib } = window.piano;
    const { StreamSource } = await import('/sampled/src/stream.js');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const readProbe = window.__probe;
    const log = (s) => console.log(`PERF   ${s}`);
    const sink = ctx.createGain(); sink.gain.value = 0; sink.connect(ctx.destination);
    const keys = [];
    for (let m = 21; m <= 108; m++) { const b = lib.best(m, lib.layers[0]); if (b) keys.push(b); }

    const src = `
      class PerfEmpty extends AudioWorkletProcessor {
        constructor() { super(); this.alive = true; this.port.onmessage = () => { this.alive = false; }; }
        process() { return this.alive; }
      }
      registerProcessor('perf-empty', PerfEmpty);
      const F = 48000, NB = 16, MAX = 4096, NK = 88, Q = 128;
      class ProtoVoices extends AudioWorkletProcessor {
        constructor() {
          super();
          this.n = 0; this.mode = 'note';
          this.bL = []; this.bR = [];
          for (let b = 0; b < NB; b++) {
            const L = new Float32Array(F), R = new Float32Array(F);
            for (let i = 0; i < F; i++) { L[i] = (Math.random() - 0.5) * 0.1; R[i] = (Math.random() - 0.5) * 0.1; }
            this.bL.push(L); this.bR.push(R);
          }
          this.pos = new Int32Array(MAX);
          this.g = new Float64Array(MAX * 3);          // lvl, att, rel
          this.gt = new Float64Array(MAX * 3);
          this.f = new Float64Array(MAX * 3);          // filter frequencies, and targets
          this.ft = new Float64Array(MAX * 3);
          this.c = new Float64Array(MAX * 3 * 5);      // b0 b1 b2 a1 a2
          this.z = new Float64Array(MAX * 3 * 4);      // DF2T state, L and R
          this.tL = new Float32Array(Q); this.tR = new Float32Array(Q);
          this.aL = new Float32Array(NK * Q); this.aR = new Float32Array(NK * Q);
          this.m = new Float32Array(NK * 4);
          for (let k = 0; k < NK; k++) { this.m[k * 4] = 0.9; this.m[k * 4 + 1] = 0.1; this.m[k * 4 + 2] = 0.1; this.m[k * 4 + 3] = 0.9; }
          for (let v = 0; v < MAX; v++) {
            this.pos[v] = (v * 997) % (F - Q);
            for (let j = 0; j < 3; j++) { this.g[v * 3 + j] = 0.5; this.gt[v * 3 + j] = 0.5 + 0.001 * j; }
            this.f[v * 3] = this.f[v * 3 + 1] = 10; this.f[v * 3 + 2] = 3400;
            this.ft[v * 3] = this.ft[v * 3 + 1] = 200 + (v % 88); this.ft[v * 3 + 2] = 3000;
            for (let j = 0; j < 3; j++) this.coef(v * 3 + j, j < 2, this.f[v * 3 + j]);
          }
          this.alive = true;
          this.port.onmessage = (e) => { this.n = e.data.n; this.mode = e.data.mode; if (e.data.die) this.alive = false; };
        }
        // The spec's highpass / lowpass (Q in dB), as Chrome computes them.
        coef(j, hp, freq) {
          const w = 2 * Math.PI * freq / sampleRate, s = Math.sin(w), cs = Math.cos(w);
          const a = s / (2 * Math.pow(10, (hp ? 3.0103 : 0) / 20));
          const a0 = 1 + a, c = this.c, o = j * 5;
          if (hp) { c[o] = (1 + cs) / 2 / a0; c[o + 1] = -(1 + cs) / a0; c[o + 2] = c[o]; }
          else { c[o] = (1 - cs) / 2 / a0; c[o + 1] = (1 - cs) / a0; c[o + 2] = c[o]; }
          c[o + 3] = -2 * cs / a0; c[o + 4] = (1 - a) / a0;
        }
        filt(j, perSample) {
          const c = this.c, z = this.z, o = j * 5, zo = j * 4, tL = this.tL, tR = this.tR;
          const hp = j % 3 < 2, k = 1 - Math.exp(-1 / (0.05 * sampleRate));
          let b0 = c[o], b1 = c[o + 1], b2 = c[o + 2], a1 = c[o + 3], a2 = c[o + 4];
          let l1 = z[zo], l2 = z[zo + 1], r1 = z[zo + 2], r2 = z[zo + 3];
          for (let i = 0; i < Q; i++) {
            if (perSample) {
              this.f[j] += (this.ft[j] - this.f[j]) * k;
              this.coef(j, hp, this.f[j]);
              b0 = c[o]; b1 = c[o + 1]; b2 = c[o + 2]; a1 = c[o + 3]; a2 = c[o + 4];
            }
            const x = tL[i], y = b0 * x + l1; l1 = b1 * x - a1 * y + l2; l2 = b2 * x - a2 * y; tL[i] = y;
            const xr = tR[i], yr = b0 * xr + r1; r1 = b1 * xr - a1 * yr + r2; r2 = b2 * xr - a2 * yr; tR[i] = yr;
          }
          z[zo] = l1; z[zo + 1] = l2; z[zo + 2] = r1; z[zo + 3] = r2;
        }
        process(inputs, outputs) {
          const OL = outputs[0][0], OR = outputs[0][1] ?? OL;
          const aL = this.aL, aR = this.aR, tL = this.tL, tR = this.tR, g = this.g, gt = this.gt;
          const n = this.n, mode = this.mode, res = mode !== 'note';
          const used = Math.min(n, NK);
          aL.fill(0, 0, used * Q); aR.fill(0, 0, used * Q);
          for (let v = 0; v < n; v++) {
            try {
              const b = v % NB;
              let p = this.pos[v]; if (p + Q > F) p = 0;
              tL.set(this.bL[b].subarray(p, p + Q)); tR.set(this.bR[b].subarray(p, p + Q));
              this.pos[v] = p + Q;
              if (res) {
                for (let j = v * 3; j < v * 3 + 3; j++) {
                  if (mode === 'res-block') {
                    const k = 1 - Math.exp(-Q / (0.05 * sampleRate));
                    this.f[j] += (this.ft[j] - this.f[j]) * k;
                    this.coef(j, j % 3 < 2, this.f[j]);
                  }
                  this.filt(j, mode === 'res-auto');
                }
              }
              const o = v * 3;
              const g0 = g[o], g1 = g[o + 1], g2 = g[o + 2];
              const d0 = (gt[o] - g0) / Q, d1 = (gt[o + 1] - g1) / Q, d2 = (gt[o + 2] - g2) / Q;
              const ko = (v % NK) * Q;
              for (let i = 0; i < Q; i++) {
                const w = (g0 + d0 * i) * (g1 + d1 * i) * (g2 + d2 * i);
                aL[ko + i] += tL[i] * w; aR[ko + i] += tR[i] * w;
              }
              // Gains glide back and forth between two values, so they are
              // always ramping (the dearer case).
              for (let j = 0; j < 3; j++) { const t = gt[o + j]; gt[o + j] = g[o + j]; g[o + j] = t; }
            } catch (e) { /* one voice, not all */ }
          }
          const m = this.m;
          for (let k = 0; k < used; k++) {
            const ko = k * Q, m0 = m[k * 4], m1 = m[k * 4 + 1], m2 = m[k * 4 + 2], m3 = m[k * 4 + 3];
            for (let i = 0; i < Q; i++) {
              const l = aL[ko + i], r = aR[ko + i];
              OL[i] += l * m0 + r * m1; if (OR !== OL) OR[i] += l * m2 + r * m3;
            }
          }
          return this.alive;
        }
      }
      registerProcessor('proto-voices', ProtoVoices);`;
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));

    // The largest N that `build(n)` -> teardown can hold for a second without
    // losing FAIL_MS, N x1.5 per step; a failure counts if it happens twice.
    const capacity = async (label, build, max = 1024) => {
      let best = 0;
      for (let n = 8; n <= max; n = Math.ceil(n * 1.5)) {
        const trial = async () => {
          const down = await build(n);
          await wait(400); await readProbe();
          await wait(1000);
          const p = await readProbe();
          await down();
          await wait(500); await readProbe();
          return p;
        };
        let p = await trial();
        if (p.lost >= FAIL_MS) p = await trial();
        const ok = p.lost < FAIL_MS;
        log(`${label.padEnd(12)} ${String(n).padStart(4)}  lost ${p.lost.toFixed(0).padStart(4)} ms  drops ${p.drops}${ok ? '' : '  FAIL'}`);
        if (!ok) break;
        best = n;
      }
      return best;
    };
    // A voice node that is never started returns true forever: start it and
    // stop it at once so it ends and is collected.
    const end = async (srcs) => {
      await Promise.all(srcs.map((s) => new Promise((r) => { s.onended = r; s.start(0, 0); s.stop(0); })));
    };
    const voice = (i, chain) => {
      const b = keys[i % keys.length];
      const s = new StreamSource(lib.streamer, b.key, b.frames);
      let at = s.node;
      const gains = [];
      if (chain) for (let j = 0; j < 3; j++) { const g = ctx.createGain(); at.connect(g); at = g; gains.push(g); }
      at.connect(sink);
      s.gains = gains;
      return s;
    };
    const holdVoices = async (n) => {
      const vs = [];
      for (let i = 0; i < n; i++) { const s = voice(i, true); s.start(ctx.currentTime + 0.05, 0); vs.push(s); }
      return async () => { for (const s of vs) { s.stop(); for (const g of s.gains) g.disconnect(); } };
    };

    const out = {};
    let noteCap = null;
    const measureNote = async () => (noteCap ??= out.note = await capacity('note', holdVoices));

    if (parts.includes('idle')) {
      out.empty = await capacity('empty', async (n) => {
        const ns = [];
        for (let i = 0; i < n; i++) { const x = new AudioWorkletNode(ctx, 'perf-empty'); x.connect(sink); ns.push(x); }
        return async () => { for (const x of ns) { x.port.postMessage(0); x.disconnect(); } };
      });
      for (const connected of [true, false]) {
        out[connected ? 'idleConnected' : 'idleDisconnected'] = await capacity(connected ? 'idle conn' : 'idle disc', async (n) => {
          const ss = [];
          for (let i = 0; i < n; i++) {
            const b = keys[i % keys.length];
            const s = new StreamSource(lib.streamer, b.key, b.frames);
            if (connected) s.connect(sink);
            ss.push(s);
          }
          return () => end(ss);
        });
      }
    }

    if (parts.includes('proto') || parts.includes('churn')) await measureNote();

    if (parts.includes('proto')) {
      out.res = await capacity('res', async (n) => {
        const vs = [];
        for (let i = 0; i < n; i++) {
          const b = keys[i % keys.length];
          const s = new StreamSource(lib.streamer, b.key, b.frames);
          let at = s.node; const ns = [];
          const link = (x) => { at.connect(x); at = x; ns.push(x); };
          for (let j = 0; j < 2; j++) { const h = ctx.createBiquadFilter(); h.type = 'highpass'; h.Q.value = Math.SQRT1_2; h.frequency.value = 10; link(h); }
          const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.5; lp.frequency.value = 3400; link(lp);
          link(ctx.createGain()); link(ctx.createGain());
          at.connect(sink);
          s.start(ctx.currentTime + 0.05, 0);
          vs.push({ s, ns });
        }
        return async () => { for (const v of vs) { v.s.stop(); for (const x of v.ns) x.disconnect(); } };
      });
      for (const mode of ['note', 'res', 'res-block', 'res-auto']) {
        out[`proto-${mode}`] = await capacity(`proto ${mode}`, async (n) => {
          const x = new AudioWorkletNode(ctx, 'proto-voices', { numberOfInputs: 0, outputChannelCount: [2] });
          x.connect(sink);
          x.port.postMessage({ n, mode });
          return async () => { x.port.postMessage({ n: 0, mode, die: true }); x.disconnect(); };
        }, 4096);
      }
    }

    if (parts.includes('churn')) {
      const SECS = 8, LIFE = 0.05;
      const bgN = Math.floor(noteCap * 0.6);
      out.churn = [];
      for (const bg of [0, bgN]) {
        const down = bg ? await holdVoices(bg) : null;
        for (const K of [0, 10, 30, 100]) {
          // K = 0: as many voices as K = 100 keeps alive, held with no churn.
          await wait(500); await readProbe();
          let made = 0;
          const timer = K ? setInterval(() => {
            const s = voice(made++, true);
            const t = ctx.currentTime + 0.01;
            s.onended = () => { for (const g of s.gains) g.disconnect(); };
            s.start(t, 0); s.stop(t + LIFE);
          }, 1000 / K) : null;
          const held = K ? null : await holdVoices(Math.round(100 * LIFE));
          await wait(SECS * 1000);
          if (timer) clearInterval(timer);
          const p = await readProbe();
          if (held) await held();
          await wait(600); await readProbe();
          const row = { bg, K, made, lost: p.lost, drops: p.drops };
          out.churn.push(row);
          log(`churn bg ${String(bg).padStart(3)}  ${K ? `${String(K).padStart(3)}/s (${made} made)` : `  0/s (${Math.round(100 * LIFE)} held)`}  lost ${p.lost.toFixed(0).padStart(4)} ms  drops ${p.drops}`);
        }
        if (down) await down();
        await wait(600); await readProbe();
      }
    }
    return out;
  }, { FAIL_MS, parts });
  console.log('');
  for (const [k, v] of Object.entries(res)) if (typeof v === 'number') console.log(`  CAPACITY ${k.padEnd(18)} ${v}`);
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ at: new Date().toISOString(), nodes: res }, null, 2));
}
