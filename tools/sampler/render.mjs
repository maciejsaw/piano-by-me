// Play a MIDI performance through the sampled piano and record the result.
//
//   node tools/sampler/render.mjs <file.mid> [--from 0] [--seconds 30] [--out x.wav]
//
// It drives the real instrument in a real browser rather than reimplementing
// it offline, which is the only way to be sure that what comes out is what a
// listener would hear: the same voice allocation, the same convolver, the same
// resonance engine on the same control tick.
//
// That means recording in REAL TIME -- thirty seconds of music takes thirty
// seconds -- and it means the recording is only as good as the audio thread's
// ability to keep up. The capture is checked for dropouts afterwards rather
// than assumed.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseMidi, slice } from './lib/midi.mjs';
import { writeWav24 } from './lib/wav.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const midiPath = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1]?.startsWith('--') !== true);
if (!midiPath) {
  console.log('\n  usage: node tools/sampler/render.mjs <file.mid> [--from S] [--seconds N] [--out FILE]\n');
  process.exit(1);
}
const from = +arg('--from', 'auto');
const seconds = +arg('--seconds', 30);
const tail = +arg('--tail', 4);
const out = arg('--out', join('renders', basename(midiPath).replace(/\.midi?$/i, '') + '-sampled.wav'));
// For telling apart what the instrument does from what the effects on top of
// it do. `--bare` is the sampler and nothing else.
const opts = {
  resonance: !argv.includes('--no-resonance') && !argv.includes('--bare'),
  room: !argv.includes('--no-room') && !argv.includes('--bare'),
  noise: !argv.includes('--no-noise') && !argv.includes('--bare'),
  resAmount: +arg('--res-amount', 'NaN'),
  resVoices: +arg('--res-voices', 'NaN'),
  resComp: !argv.includes('--no-res-comp'),
  voices: +arg('--voices', 'NaN'),
  wet: +arg('--wet', 'NaN'),
};
const PORT = process.env.PORT || '8151';

// ---------------------------------------------------------------- the score --
const midi = parseMidi(midiPath);
const firstNote = midi.events.find((e) => e.type === 'noteOn')?.t ?? 0;
const start = Number.isFinite(from) ? from : firstNote;
const events = slice(midi.events, start, start + seconds);
const notes = events.filter((e) => e.type === 'noteOn');
console.log(`\n  ${basename(midiPath)}`);
console.log(`  ${(midi.duration / 60).toFixed(1)} min, ${midi.events.filter((e) => e.type === 'noteOn').length} notes`);
console.log(`  rendering ${start.toFixed(2)}s .. ${(start + seconds).toFixed(2)}s + ${tail}s tail`);
console.log(`  ${notes.length} notes, ${events.filter((e) => e.type === 'cc' && e.cc === 64).length} pedal moves`);
console.log(`  resonance ${opts.resonance ? 'on' : 'OFF'}   room ${opts.room ? 'on' : 'OFF'}   mechanical noise ${opts.noise ? 'on' : 'OFF'}\n`);

// ------------------------------------------------------------------ browser --
const CHROME = [process.env.CHROMIUM, '/opt/pw-browsers/chromium'].find((p) => p && existsSync(p));
const server = spawn(process.execPath, ['tools/serve.mjs'], { env: { ...process.env, PORT }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 700));
const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required', '--disable-features=AudioServiceOutOfProcess'],
  ...(CHROME ? { executablePath: CHROME } : {}),
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('  page error:', e.stack ?? String(e)));
await page.goto(`http://localhost:${PORT}/sampled/`, { waitUntil: 'domcontentloaded' });
await page.click('#startBtn');
await page.waitForFunction(() => window.piano, null, { timeout: 30000 });
process.stdout.write('  warming the library');
await page.waitForFunction(() => window.piano.lib.keysReady() >= 88
  && window.piano.lib.auxResident(21, 108) >= window.piano.lib.auxOrder(21, 108).length,
  null, { timeout: 180000 });
process.stdout.write(' done\n');

const result = await page.evaluate(async ({ events, seconds, tail, opts }) => {
  const { ctx, engine, lib, curves } = window.piano;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  engine.res.enabled = opts.resonance;
  if (!opts.room) engine.wet.gain.value = 0;
  if (Number.isFinite(opts.wet)) engine.wet.gain.value = opts.wet;
  if (!opts.noise) { engine.releaseNoise = 0; engine.damperNoise = 0; engine.pedalNoise = 0; }
  if (Number.isFinite(opts.resAmount)) engine.res.amount = opts.resAmount;
  if (Number.isFinite(opts.resVoices)) engine.res.maxVoices = opts.resVoices;
  if (Number.isFinite(opts.voices)) engine.maxVoices = opts.voices;
  engine.res.compensate = opts.resComp;

  // Stop streaming, then fetch exactly the layers this score asks for. With
  // the warm pass still running it could evict one of them mid-performance,
  // which the player covers by substituting a neighbour -- correct while
  // playing, wrong when the point is to hear the score's own layers.
  lib.stopWarm();
  const wanted = new Set();
  for (const e of events) {
    if (e.type !== 'noteOn') continue;
    const bias = Math.round(curves.at('layerBias', e.note));
    const layer = window.piano.pickLayer(e.vel, lib.m.hivel, lib.layers, bias);
    const entry = lib.entry(e.note, layer);
    if (entry) { wanted.add(lib.key(e.note, layer)); lib.want(entry.file, lib.key(e.note, layer), 20); }
  }
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline && [...wanted].some((k) => !lib.cache.has(k))) await wait(200);
  const missing = [...wanted].filter((k) => !lib.cache.has(k)).length;

  // --- the recorder -------------------------------------------------------
  await ctx.audioWorklet.addModule('/tools/sampler/recorder-worklet.js');
  const rec = new AudioWorkletNode(ctx, 'recorder', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
  const chunks = [];
  let done = false;
  rec.port.onmessage = (e) => { if (e.data.done) done = true; else chunks.push(e.data); };
  (engine.limiterOn ? engine.limiter : engine.master).connect(rec);
  rec.connect(ctx.destination);

  // --- play it ------------------------------------------------------------
  // The keyboard repaint is main-thread work every 40 ms, which is exactly
  // what makes a 2 ms scheduling loop fire late. The resonance tick keeps
  // running; only the drawing stops.
  window.piano.ui = false;
  engine.panic();
  await wait(400);
  // A lookahead scheduler, which is the only way to get this right. A browser
  // timer is good to about four milliseconds and clamps under load -- half the
  // events in the first attempt at this arrived late, the worst by 10.6 ms.
  // So the loop runs EARLY and hands the engine the exact time each event is
  // supposed to happen; the audio clock, which is good to a sample, does the
  // rest.
  //
  // 60 ms of lookahead rather than more because the resonance excitation is
  // still applied when the loop runs rather than when the note sounds -- it is
  // an accumulator, not a schedule -- so the halo would start early by
  // whatever this is. At 60 ms that is well inside its own 45 ms attack.
  const LOOKAHEAD = 0.06;
  let peakVoices = 0, peakRes = 0;
  const watch = setInterval(() => {
    const st = engine.stats();
    peakVoices = Math.max(peakVoices, st.voices);
    peakRes = Math.max(peakRes, st.resonating);
  }, 50);
  rec.port.postMessage('start');
  const t0 = ctx.currentTime + 0.25;
  let i = 0, late = 0, worstLate = 0;
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      const now = ctx.currentTime - t0;
      while (i < events.length && events[i].t <= now + LOOKAHEAD) {
        const e = events[i++];
        const at = t0 + e.t;
        const d = ctx.currentTime - at;
        if (d > 0) { late++; worstLate = Math.max(worstLate, d); }
        if (e.type === 'noteOn') engine.noteOn(e.note, e.vel, at);
        else if (e.type === 'noteOff') engine.noteOff(e.note, e.vel || 64, at);
        else if (e.type === 'cc') {
          if (e.cc === 64) engine.setPedal(e.value / 127, at);
          else if (e.cc === 66) engine.setSostenuto(e.value >= 64);
          else if (e.cc === 67) engine.setUnaCorda(e.value / 127);
        }
      }
      if (now > seconds + tail) { clearInterval(timer); resolve(); }
    }, 10);
  });
  clearInterval(watch);
  rec.port.postMessage('stop');
  while (!done) await wait(50);

  let n = 0;
  for (const c of chunks) n += c.l.length;
  const L = new Float32Array(n), R = new Float32Array(n);
  let o = 0;
  for (const c of chunks) { L.set(c.l, o); R.set(c.r, o); o += c.l.length; }
  const b64 = (a) => {
    const u8 = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    let s = '';
    for (let k = 0; k < u8.length; k += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(k, k + 0x8000));
    return btoa(s);
  };
  return { L: b64(L), R: b64(R), frames: n, rate: ctx.sampleRate, missing, late, worstLate,
    voicesPeak: peakVoices, resPeak: peakRes };
}, { events, seconds, tail, opts });

await browser.close();
server.kill();

// ------------------------------------------------------------------- write --
const un = (s) => { const b = Buffer.from(s, 'base64'); return new Float32Array(b.buffer, b.byteOffset, b.length / 4); };
const L = un(result.L), R = un(result.R);

// Did the audio thread keep up? A realtime capture that underran shows as a
// run of exact zeros in the middle of a decaying piece, which nothing else
// produces.
let peak = 0, gaps = 0, run = 0;
// Only between the first and last sound: the quarter second of lead-in before
// the downbeat is silence by design, not an underrun.
let head = 0, tailAt = L.length - 1;
while (head < L.length && L[head] === 0 && R[head] === 0) head++;
while (tailAt > head && L[tailAt] === 0 && R[tailAt] === 0) tailAt--;
for (let i = 0; i < L.length; i++) {
  const a = Math.max(Math.abs(L[i]), Math.abs(R[i]));
  if (a > peak) peak = a;
  if (i < head || i > tailAt) continue;
  if (L[i] === 0 && R[i] === 0) { if (++run === 480) gaps++; } else run = 0;
}
const expected = Math.round((seconds + tail) * result.rate);

console.log(`  captured   ${(result.frames / result.rate).toFixed(2)} s at ${result.rate} Hz (expected ${(expected / result.rate).toFixed(2)} s)`);
console.log(`  peak       ${(20 * Math.log10(peak)).toFixed(2)} dBFS`);
console.log(`  timing     ${result.late} of ${events.length} events missed their slot${result.late ? `, worst ${(result.worstLate * 1000).toFixed(1)} ms` : ' — sample accurate'}`);
console.log(`  layers     ${result.missing ? `${result.missing} NOT resident` : 'all resident'}`);
console.log(`  dropouts   ${gaps ? `${gaps} gaps of 10 ms or more` : 'none'}  (lead-in ${(head / result.rate * 1000).toFixed(0)} ms)`);
console.log(`  voices     ${result.voicesPeak} struck at once, ${result.resPeak} ringing sympathetically`);

writeWav24(out, [L, R], result.rate);
console.log(`\n  -> ${out}\n`);
if (gaps || result.missing) process.exitCode = 1;
