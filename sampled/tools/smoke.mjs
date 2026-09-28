// The fast browser check: does the sampled piano play, and does its streaming
// hold up? One page load, a few seconds of sound. The long, detailed audio
// measurements are in browser-test.mjs (slow); the arithmetic is in unit.mjs.
//
//   1. a note sounds, is not clipping, and velocity changes its level
//   2. a released key rings on under the pedal, and lifting the pedal stops it
//   3. twenty notes at once, two of them entering a second in (the path the
//      sympathetic resonance takes), with no underrun: every sample arrived
//      before it was needed, to the end of what was played
//   4. the same again with every other note's decoder killed partway through,
//      sample-identical to the first pass: a decoder that dies mid-note is
//      replaced without a trace
//
//   npm run sampled:smoke
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROME = [process.env.CHROMIUM, '/opt/pw-browsers/chromium'].find((p) => p && existsSync(p));
const PORT = process.env.PORT || '8139';
const server = spawn(process.execPath, [join(REPO, 'tools', 'serve.mjs')], { env: { ...process.env, PORT }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 500));
const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required'],
  ...(CHROME ? { executablePath: CHROME } : {}),
});
const page = await browser.newPage();
const errors = [];
let broken = 0;
const underrunLog = [];
const T0 = Date.now(), stamp = (what) => process.env.SMOKE_TIMING && console.log(`  ${((Date.now() - T0) / 1000).toFixed(1)} s  ${what}`);
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
  if (/stream underrun/.test(m.text())) underrunLog.push(m.text().replace('sampled: stream underrun on ', ''));
});
page.on('pageerror', (e) => errors.push(String(e)));
page.on('worker', (w) => w.on('console', (m) => { if (/forced decoder failure/.test(m.text())) broken++; }));

// A switch in the stream worker, off until the page flips it, that kills every
// other new stream's decoder a moment in -- through the real recovery path.
await page.route('**/sampled/src/stream-worker.js', async (route) => {
  const r = await route.fetch();
  const hooks = [
    ["this.dec.addEventListener?.('dequeue', () => this.pump());",
      "\n    if (globalThis.__killDecoders && !this.retries && this.id % 2 === 0) setTimeout(() => this.recover(new Error('forced decoder failure')), 250 + (this.id % 5) * 90);"],
    ['onmessage = async (e) => {\n  const m = e.data;',
      "\n  if (m.type === 'killDecoders') { globalThis.__killDecoders = true; return; }"],
  ];
  let body = await r.text();
  for (const [at, add] of hooks) {
    if (!body.includes(at)) throw new Error(`smoke: the stream worker changed; update the hook at: ${at}`);
    body = body.replace(at, at + add);
  }
  await route.fulfill({ response: r, body });
});

await page.goto(`http://localhost:${PORT}/sampled/`, { waitUntil: 'domcontentloaded' });
// Stream from memory: a headless profile has nowhere near the quota to install.
await page.evaluate(() => { document.getElementById('installChk').checked = false; });
await page.click('#startBtn');
await page.waitForFunction(() => window.piano, null, { timeout: 30000 });
stamp('started');
await page.waitForFunction(() => window.piano.lib.keysReady() >= 88, null, { timeout: 120000 });
stamp('every key ready');
// And every head decoded, so what is measured is the instrument, not the
// load: playing hard in the first seconds after start is what stress.mjs is for.
await page.waitForFunction(() => window.piano.lib.streamer.headsBundle !== null, null, { timeout: 120000 });
stamp('every head in');

const r = await page.evaluate(async () => {
  const { ctx, engine, lib } = window.piano;
  const wait = (ms) => new Promise((res) => setTimeout(res, ms));
  const an = new AnalyserNode(ctx, { fftSize: 4096 });
  engine.master.connect(an);
  const buf = new Float32Array(an.fftSize);
  const rms = () => { an.getFloatTimeDomainData(buf); let s = 0; for (const v of buf) s += v * v; return Math.sqrt(s / buf.length); };
  const peakOver = async (ms) => { let p = 0; for (let t = 0; t < ms; t += 25) { p = Math.max(p, rms()); await wait(25); } return p; };
  const settle = async () => { engine.panic(); await wait(500); };
  const out = {};

  engine.setLimiter(false);
  engine.noteOn(60, 110); out.loud = await peakOver(400); engine.noteOff(60); await settle();
  engine.noteOn(60, 25); out.soft = await peakOver(400); engine.noteOff(60); await settle();
  engine.setLimiter(true);

  engine.setPedal(1);
  engine.noteOn(55, 110); await wait(200); engine.noteOff(55);
  await wait(500);
  out.pedalHeld = await peakOver(200);
  engine.setPedal(0);
  await wait(400);
  out.pedalLifted = await peakOver(200);
  await settle();
  engine.master.disconnect(an);

  // The raw sample voices, each into its own recorder: no engine, envelopes
  // or room, so what is compared is exactly what the streaming delivered.
  const { StreamSource } = await import('/sampled/src/stream.js');
  await ctx.audioWorklet.addModule('/sampled/tools/recorder-worklet.js');
  const st = lib.streamer;
  const SECONDS = 3;
  const play = async () => {
    const jobs = [];
    for (let m = 36; m < 96; m += 3) jobs.push([m, 0]);
    for (const m of [52, 64]) jobs.push([m, 1.0]);
    const t0 = ctx.currentTime + 0.2, recs = [];
    for (const [m, offset] of jobs) {
      const b = lib.best(m, lib.layers[0]);
      if (!b) continue;
      const src = new StreamSource(st, b.key, b.frames);
      const rec = new AudioWorkletNode(ctx, 'recorder', { numberOfInputs: 1, numberOfOutputs: 1,
        outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' });
      const mute = ctx.createGain(); mute.gain.value = 0;
      rec.connect(mute).connect(ctx.destination);
      const chunks = [];
      rec.port.onmessage = (e) => { if (e.data.l) chunks.push(e.data.l); };
      src.connect(rec);
      rec.port.postMessage('start');
      src.start(t0, offset);
      recs.push({ name: `${b.key}@${offset}`, rec, src, chunks, mute });
    }
    await wait(SECONDS * 1000 + 400);
    for (const x of recs) { x.src.stop(); x.rec.port.postMessage('stop'); }
    await wait(300);
    const got = {};
    for (const x of recs) {
      x.rec.disconnect(); x.mute.disconnect();
      const n = x.chunks.reduce((a, c) => a + c.length, 0), all = new Float32Array(n);
      let p = 0; for (const c of x.chunks) { all.set(c, p); p += c.length; }
      // From the note's first sample, so the two passes line up exactly.
      let i = 0; while (i < n && all[i] === 0) i++;
      got[x.name] = all.slice(i, i + 48000 * (SECONDS - 0.5));
    }
    return got;
  };
  out.earlyUnderruns = st.underruns;
  const clean = await play();
  out.streamUnderruns = st.underruns - out.earlyUnderruns;
  st.worker.postMessage({ type: 'killDecoders' });
  const killed = await play();
  out.killedUnderruns = st.underruns - out.earlyUnderruns - out.streamUnderruns;
  // Compared here: shipping five million samples out to Node took a minute.
  out.names = Object.keys(clean);
  out.differs = out.names.filter((k) => {
    const a = clean[k], b = killed[k];
    return !b || a.length !== b.length || a.some((v, i) => v !== b[i]);
  });
  return out;
});
stamp('measured');
await browser.close();
server.kill();

const { names, differs } = r;
const f = (v) => v.toExponential(2);
const checks = [
  ['a note sounds', r.loud > 0.01, f(r.loud)],
  ['...and is not clipping', r.loud < 0.35, f(r.loud)],
  ['velocity changes level', r.soft < r.loud * 0.5, `${(20 * Math.log10(r.soft / r.loud)).toFixed(1)} dB`],
  ['a released key rings on under the pedal', r.pedalHeld > 5e-3, f(r.pedalHeld)],
  ['lifting the pedal stops it', r.pedalLifted < r.pedalHeld * 0.3, f(r.pedalLifted)],
  ['...all of it with no underruns', r.earlyUnderruns === 0,
    `${r.earlyUnderruns}${underrunLog.length ? ` (${underrunLog.join(', ')})` : ''}`],
  ['many notes at once, streamed', names.length >= 20, `${names.length} notes`],
  ['...with no underruns', r.streamUnderruns === 0, `${r.streamUnderruns}`],
  ['decoders killed mid-note', broken > 0, `${broken}`],
  ['...and still no underruns', r.killedUnderruns === 0, `${r.killedUnderruns}`],
  ['...and every note sample-identical', !differs.length, differs.length ? `differs: ${differs.join(' ')}` : 'yes'],
  ['no console errors', !errors.length, errors.join(' | ') || 'none'],
];
console.log('');
for (const [name, ok, got] of checks) console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name.padEnd(52)} ${got}`);
const ok = checks.every((c) => c[1]);
console.log(ok ? '\n  SMOKE CHECK PASSED\n' : '\n  SMOKE CHECK FAILED\n');
process.exit(ok ? 0 : 1);
