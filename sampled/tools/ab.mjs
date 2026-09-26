// Does a change to the streaming sampler change a single sample? Records a
// set of raw sample voices -- no engine, envelopes or room: exactly what the
// voice worklet and the stream deliver -- with the working tree and with a
// git revision (default HEAD), and compares them sample by sample.
//
//   npm run sampled:ab [-- REF]
//
// The revision's sampled/src is served from git (`git show`), so worklets and
// workers come from it too -- request routing in the browser cannot reach an
// AudioWorklet module -- and nothing needs checking out. The samples are the
// working tree's.
//
// The voices cover every path the voice worklet has: from the head at rate 1,
// a fractional start (the engine's alignment), detuned rates, a start past
// the head (the resonance: waits for its first block), fade-ins raised cosine
// and curved, and a scheduled stop. Each recording starts at its first
// non-zero sample, so a voice that waits for its stream lines up however
// long it waited.
//
// Passes if every voice is identical. Otherwise prints each one that differs,
// and by how much below its own peak.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROME = [process.env.CHROMIUM, '/opt/pw-browsers/chromium'].find((p) => p && existsSync(p));
const REF = process.argv[2] || 'HEAD';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.opus': 'audio/ogg', '.ogg': 'audio/ogg' };

/** The repo, with sampled/src/ taken from `ref` when given. */
function serve(port, ref) {
  const server = createServer(async (req, res) => {
    try {
      const url = decodeURIComponent(req.url.split('?')[0]);
      if (url === '/sampled') { res.writeHead(301, { location: '/sampled/' }).end(); return; }
      const rel = normalize(url.endsWith('/') ? url + 'index.html' : url).replace(/^\/+/, '');
      if (rel.startsWith('..')) { res.writeHead(403).end(); return; }
      const body = ref && rel.startsWith('sampled/src/')
        ? execFileSync('git', ['show', `${ref}:${rel}`], { cwd: REPO, maxBuffer: 64 << 20 })
        : await readFile(join(REPO, rel));
      res.writeHead(200, { 'content-type': TYPES[extname(rel)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch { res.writeHead(404).end('not found'); }
  });
  return new Promise((r) => server.listen(port, () => r(server)));
}

const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required'],
  ...(CHROME ? { executablePath: CHROME } : {}),
});

async function record(port) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://localhost:${port}/sampled/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { document.getElementById('installChk').checked = false; });
  await page.click('#startBtn');
  await page.waitForFunction(() => window.piano, null, { timeout: 30000 });
  await page.waitForFunction(() => window.piano.lib.keysReady() >= 88, null, { timeout: 120000 });
  await page.waitForFunction(() => window.piano.lib.streamer.headsBundle !== null, null, { timeout: 120000 });
  const got = await page.evaluate(async () => {
    const { ctx, lib } = window.piano;
    const { StreamSource } = await import('/sampled/src/stream.js');
    await ctx.audioWorklet.addModule('/sampled/tools/recorder-worklet.js');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const SECONDS = 2.5;
    const curve = new Float32Array(64).map((_, i) => Math.pow(i / 63, 2.2));
    // [midi, offset s, cents, fade s, curve?, stop after s]
    const batches = [[
      [36, 0, 0, 0], [45, 0, 0, 0], [52, 0, 0, 0], [60, 0, 0, 0], [67, 0, 0, 0], [74, 0, 0, 0], [81, 0, 0, 0], [96, 0, 0, 0],
      [40, 0.00051, 0, 0.0015], [58, 0.00073, 0, 0.0015], [71, 0.0002, 0, 0.0015],
      [48, 0, 7, 0], [63, 0, -13, 0], [88, 0, 42.5, 0],
    ], [
      [43, 0.4, 3, 0.2, true], [55, 0.4, -2, 0.2, true], [64, 0.6, 0, 0.2, true], [77, 0.4, 11, 0.1, true],
      [50, 1.0, 0, 0.05], [69, 0.7, 0, 0.05],
      [38, 0, 0, 0, false, 0.8], [62, 0.00051, 0, 0.0015, false, 1.1], [84, 0, 5, 0, false, 0.37],
      [101, 0, 0, 0], [21, 0, 0, 0],
    ]];
    const out = {};
    let underruns = 0;
    for (const jobs of batches) {
      const u0 = lib.streamer.underruns;
      const t0 = ctx.currentTime + 0.2, recs = [];
      for (const [m, offset, cents, fade, curved, stopAfter] of jobs) {
        const b = lib.best(m, lib.layers[0]);
        if (!b) continue;
        const src = new StreamSource(lib.streamer, b.key, b.frames);
        src.playbackRate.value = Math.pow(2, cents / 1200);
        const rec = new AudioWorkletNode(ctx, 'recorder', { numberOfInputs: 1, numberOfOutputs: 1,
          outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' });
        const mute = ctx.createGain(); mute.gain.value = 0;
        rec.connect(mute).connect(ctx.destination);
        const chunks = [];
        rec.port.onmessage = (e) => { if (e.data.l) chunks.push(e.data); };
        src.connect(rec);
        rec.port.postMessage('start');
        src.start(t0, offset, fade, curved ? curve : null);
        if (stopAfter) src.stop(t0 + stopAfter);
        recs.push({ name: `${m}:${b.key}@${offset}${cents ? ` ${cents}c` : ''}${fade ? ` fade ${fade}${curved ? ' curved' : ''}` : ''}${stopAfter ? ` stop ${stopAfter}` : ''}`, rec, src, chunks, mute });
      }
      await wait(SECONDS * 1000 + 600);
      for (const x of recs) { x.src.stop(); x.rec.port.postMessage('stop'); }
      await wait(300);
      for (const x of recs) {
        x.rec.disconnect(); x.mute.disconnect();
        const n = x.chunks.reduce((a, c) => a + c.l.length, 0);
        let i = 0, p = 0;
        const all = new Float32Array(2 * n);
        for (const c of x.chunks) { all.set(c.l, p); all.set(c.r, n + p); p += c.l.length; }
        while (i < n && all[i] === 0 && all[n + i] === 0) i++;
        const len = Math.min(n - i, Math.round(48000 * SECONDS));
        const lr = new Float32Array(2 * len);
        lr.set(all.subarray(i, i + len)); lr.set(all.subarray(n + i, n + i + len), len);
        // base64: far quicker out of the page than a JSON array of numbers
        const bytes = new Uint8Array(lr.buffer);
        let s = '';
        for (let k = 0; k < bytes.length; k += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(k, k + 0x8000));
        out[x.name] = btoa(s);
      }
      underruns += lib.streamer.underruns - u0;
      await wait(300);
    }
    return { out, underruns };
  });
  await context.close();
  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  const voices = {};
  for (const [k, v] of Object.entries(got.out)) {
    const b = Buffer.from(v, 'base64');
    voices[k] = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
  }
  return { voices, underruns: got.underruns };
}

const [base, cur] = [await serve(8151, REF), await serve(8152, null)];
const rev = execFileSync('git', ['rev-parse', '--short', REF], { cwd: REPO }).toString().trim();
const a = await record(8151);
const b = await record(8152);
await browser.close();
base.close(); cur.close();

console.log(`\n  ${REF} (${rev}) against the working tree, ${Object.keys(a.voices).length} voices\n`);
let same = 0;
const bad = [];
for (const [name, x] of Object.entries(a.voices)) {
  const y = b.voices[name];
  if (!y) { bad.push(`${name}: missing`); continue; }
  let peak = 0, diff = 0;
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) diff = Math.max(diff, Math.abs(x[i] - y[i]));
  if (diff === 0 && x.length === y.length) { same++; continue; }
  bad.push(`${name}: ${x.length !== y.length ? `length ${x.length / 2} vs ${y.length / 2}, ` : ''}`
    + `max difference ${diff ? (20 * Math.log10(diff / peak)).toFixed(1) + ' dB below peak' : 'none in the common part'}`);
}
for (const l of bad) console.log(`  DIFFERS  ${l}`);
console.log(`  identical: ${same} of ${Object.keys(a.voices).length}`);
console.log(`  underruns: ${a.underruns} (${rev}), ${b.underruns} (working tree)`);
const ok = !bad.length && !a.underruns && !b.underruns;
console.log(ok ? '\n  A/B IDENTICAL\n' : '\n  A/B DIFFERS\n');
process.exit(ok ? 0 : 1);
