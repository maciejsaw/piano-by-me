// How much can the sampled piano play before it drops out?
//
//   npm run sampled:perf [-- --json out.json] [-- --setup "js"] [-- --micro]
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

const results = MICRO ? [] : await page.evaluate(async ({ setup, LEVELS, LEVEL_MS, STOP_AFTER, FAIL_MS }) => {
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
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ at: new Date().toISOString(), setup: SETUP, levels: LEVELS, results }, null, 2));

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
