// Verifies the thing that actually matters for "can I play it": the worklet
// loads in a real browser (ES module imports and all) and produces audio.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVE = fileURLToPath(new URL('../../tools/serve.mjs', import.meta.url));

const server = spawn(process.execPath, [SERVE], { env: { ...process.env, PORT: '8137' }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 700));

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto('http://localhost:8137/modelled/', { waitUntil: 'networkidle' });

const result = await page.evaluate(async () => {
  // A REALTIME context, because that is what playing actually uses and because
  // port messages are not reliably delivered during offline rendering.
  const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  await ctx.resume();
  await ctx.audioWorklet.addModule('/modelled/src/worklet.js');     // <- ES imports inside a worklet
  const node = new AudioWorkletNode(ctx, 'piano-processor', {
    numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1],
    processorOptions: { quality: 16 },
  });
  const stats = [];
  const ready = new Promise((res) => {
    node.port.onmessage = (e) => {
      if (e.data.type === 'ready') res(e.data);
      if (e.data.type === 'stats') stats.push(e.data);
    };
  });
  const analyser = new AnalyserNode(ctx, { fftSize: 2048 });
  node.connect(analyser);
  analyser.connect(ctx.destination);
  const info = await ready;

  const buf = new Float32Array(analyser.fftSize);
  const level = () => {
    analyser.getFloatTimeDomainData(buf);
    let s = 0, p = 0;
    for (const v of buf) { s += v * v; if (Math.abs(v) > p) p = Math.abs(v); }
    return { rms: Math.sqrt(s / buf.length), peak: p };
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const silence = level();
  // Silently hold C4 (dampers up, never struck), then strike C3 and release it.
  node.port.postMessage({ type: 'silentHold', midi: 60, on: true });
  node.port.postMessage({ type: 'noteOn', midi: 48, velocity: 0.95 });
  await wait(300);
  const struck = level();
  node.port.postMessage({ type: 'noteOff', midi: 48 });
  await wait(1600);
  const sympathetic = level();      // C3 is damped; anything left is C4 via the bridge

  const activeCounts = stats.map((s) => s.active);
  await ctx.close();
  return {
    strings: info.strings,
    silence: silence.rms, struck: struck.peak, structRms: struck.rms,
    sympathetic: sympathetic.rms,
    maxActive: Math.max(0, ...activeCounts),
    load: stats.length ? Math.max(...stats.map((s) => s.load)) : null,
    finite: Number.isFinite(struck.peak) && Number.isFinite(sympathetic.rms),
  };
});

console.log('\n  worklet loaded with ES imports : yes');
console.log('  strings built                  :', result.strings);
console.log('  silence before note            :', result.silence.toExponential(2));
console.log('  C3 struck (peak / rms)         :', result.struck.toFixed(4), '/', result.structRms.toFixed(5));
console.log('  C4 ringing 1.6s after release  :', result.sympathetic.toExponential(2));
console.log('  peak strings ringing           :', result.maxActive);
console.log('  values finite                  :', result.finite);
console.log('  console errors                 :', errors.length ? errors.join(' | ') : 'none');

// A smoke test, not a level check: does a struck note actually make sound in
// a real browser, on the audio thread, with the worklet's own imports. The
// threshold was 0.02, written when the strike arrived whole; the soundboard
// swell now brings the note up from half level over 20 ms and the board
// carries all of it, so the peak of a single note sits near 0.009. Checked
// against the commit before that work landed -- 0.0061 there, so this test had
// been failing on a stale number rather than on a regression.
const ok = result.strings === 240 && result.struck > 0.004 && result.finite
  && errors.length === 0 && result.sympathetic > result.silence * 4 && result.maxActive > 0;
console.log(ok ? '\n  BROWSER CHECK PASSED\n' : '\n  BROWSER CHECK FAILED\n');
await browser.close();
server.kill();
process.exit(ok ? 0 : 1);
