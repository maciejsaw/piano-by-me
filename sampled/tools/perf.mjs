// How much can the sampled piano play before it drops out?
//
//   npm run sampled:perf [-- --json out.json] [-- --setup "js"]
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
const JSON_OUT = arg('--json'), SETUP = arg('--setup');
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

const results = await page.evaluate(async ({ setup, LEVELS, LEVEL_MS, STOP_AFTER, FAIL_MS }) => {
  const { ctx, engine, lib } = window.piano;
  if (setup) new Function('engine', 'piano', setup)(engine, window.piano);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const readProbe = () => new Promise((r) => { probe.port.onmessage = (e) => r(e.data); probe.port.postMessage(0); });

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
