// How much can the sampled piano play before it drops out? A fast
// performance test: load, wait until everything is in, then play a few
// seconds of each of the hardest things a player does and measure what broke.
//
//   npm run sampled:perf [-- --json out.json] [-- --setup "js"]
//
// --setup runs a line of JavaScript in the page first, with `engine` in
// scope, for A/B experiments: --setup "engine.res.enabled = false".
//
// Per scenario:
//   lost ms     audio the output device did not get in time (a dropout),
//               measured by a probe worklet: every render callback compares
//               the audio clock with the wall clock, and a render that falls
//               behind never catches up, so the growth of that lag IS the
//               total dropout time. Checked against a deliberate CPU hog:
//               3 ms per 2.67 ms render quantum loses ~130 ms per second.
//   glitches    separate dropouts of 5 ms or more
//   underruns   stream blocks that arrived after they were needed (silence
//               inside a note, which the probe cannot see)
//   voices      peak note voices / resonance voices, as the engine counts them
//   live        peak sample voices actually running, fading ones included
//   noteOn ms   main-thread cost of one engine.noteOn, median and worst
//   long tasks  main-thread tasks over 50 ms during the scenario
//
// A measurement, not pass/fail: compare against the last run on the same
// machine. The numbers from a headless container are pessimistic, and that
// is useful -- a change that helps here helps everywhere.
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
const server = spawn(process.execPath, [join(REPO, 'tools', 'serve.mjs')], { env: { ...process.env, PORT }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 500));
const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required'],
  ...(CHROME ? { executablePath: CHROME } : {}),
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://localhost:${PORT}/sampled/`, { waitUntil: 'domcontentloaded' });
await page.evaluate(() => { document.getElementById('installChk').checked = false; });
await page.click('#startBtn');
await page.waitForFunction(() => window.piano, null, { timeout: 30000 });
await page.waitForFunction(() => window.piano.lib.keysReady() >= 88, null, { timeout: 120000 });
await page.waitForFunction(() => window.piano.lib.streamer.headsBundle !== null, null, { timeout: 120000 });

const results = await page.evaluate(async (setup) => {
  const { ctx, engine, lib } = window.piano;
  if (setup) new Function('engine', 'piano', setup)(engine, window.piano);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // The probe: lag = wall clock - audio clock, per render callback. Its floor
  // rises by exactly the time lost each time rendering falls behind.
  const src = `
    class PerfProbe extends AudioWorkletProcessor {
      constructor() {
        super();
        this.reset();
        this.port.onmessage = () => { this.port.postMessage({ lost: this.floor - this.base, glitches: this.glitches }); this.reset(); };
      }
      reset() { this.base = Infinity; this.floor = Infinity; this.glitches = 0; }
      process() {
        const lag = Date.now() - currentFrame / sampleRate * 1000;
        if (lag < this.base) { this.base = lag; this.floor = lag; }
        else if (lag > this.floor + 5) { this.glitches++; this.floor = lag; }
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
  let longTasks = 0;
  try { new PerformanceObserver((l) => { longTasks += l.getEntries().length; }).observe({ entryTypes: ['longtask'] }); } catch { /* unsupported */ }

  const CHORD = [36, 40, 43, 48, 52, 55, 60, 64, 67, 72];
  const RUN = []; for (let m = 48; m <= 84; m++) if ([0, 2, 4, 5, 7, 9, 11].includes(m % 12)) RUN.push(m);
  const scenarios = [
    ['idle, nothing playing', false, async () => { await wait(3000); }],
    ['10-key chord x20, no pedal', false, async (on, off) => {
      for (let i = 0; i < 20; i++) { for (const m of CHORD) on(m, 100); await wait(110); for (const m of CHORD) off(m); await wait(40); }
    }],
    ['10-key chord x20, pedal', true, async (on, off) => {
      for (let i = 0; i < 20; i++) { for (const m of CHORD) on(m, 100); await wait(110); for (const m of CHORD) off(m); await wait(40); }
    }],
    ['fast run 25/s, pedal', true, async (on, off) => {
      const seq = [...RUN, ...RUN.slice().reverse(), ...RUN, ...RUN.slice().reverse()];
      for (const m of seq) { on(m, 90); await wait(40); off(m); }
    }],
    ['one key x40 at 20/s', false, async (on, off) => {
      for (let i = 0; i < 40; i++) { on(60, 60 + (i % 5) * 12); await wait(35); off(60); await wait(15); }
    }],
  ];

  const out = [];
  for (const [name, pedal, play] of scenarios) {
    engine.panic(); await wait(1500);
    await readProbe();                                 // start clean
    const u0 = lib.streamer.underruns;
    longTasks = 0;
    const times = []; let peak = 0, peakRes = 0, peakLive = 0;
    const sample = setInterval(() => { const s = engine.stats(); peak = Math.max(peak, s.voices); peakRes = Math.max(peakRes, s.resonating); peakLive = Math.max(peakLive, live); }, 20);
    const on = (m, v) => { const t = performance.now(); engine.noteOn(m, v); times.push(performance.now() - t); };
    const off = (m) => engine.noteOff(m);
    if (pedal) engine.setPedal(1);
    await play(on, off);
    await wait(1000);                                  // the tails are part of the load
    engine.setPedal(0);
    await wait(300);
    clearInterval(sample);
    const p = await readProbe();
    times.sort((a, b) => a - b);
    out.push({
      name, lost: p.lost, glitches: p.glitches, underruns: lib.streamer.underruns - u0,
      voices: peak, resVoices: peakRes, live: peakLive, noteOnMedian: times[times.length >> 1], noteOnMax: times[times.length - 1],
      notes: times.length, longTasks,
    });
  }
  engine.panic();
  return out;
}, SETUP);
await browser.close();
server.kill();

const pad = (s, n) => String(s).padStart(n);
console.log(`\n  ${'scenario'.padEnd(28)}${pad('lost ms', 9)}${pad('glitches', 10)}${pad('underruns', 11)}${pad('voices', 12)}${pad('live', 7)}${pad('noteOn ms', 13)}${pad('long tasks', 12)}`);
for (const r of results) {
  console.log(`  ${r.name.padEnd(28)}${pad(r.lost.toFixed(0), 9)}${pad(r.glitches, 10)}${pad(r.underruns, 11)}`
    + `${pad(`${r.voices} + ${r.resVoices}`, 12)}${pad(r.live, 7)}${pad(r.notes ? `${r.noteOnMedian.toFixed(2)} / ${r.noteOnMax.toFixed(1)}` : '-', 13)}${pad(r.longTasks, 12)}`);
}
const total = results.reduce((a, r) => a + r.lost, 0);
if (SETUP) console.log(`  setup: ${SETUP}`);
console.log(`\n  total lost: ${total.toFixed(0)} ms${errors.length ? `   page errors: ${errors.join(' | ')}` : ''}\n`);
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
