// Does the JS automation timeline (sampled/src/automation.js) give the same
// gain, sample for sample, as Chrome's own AudioParam? Each case is a list of
// calls on a gain -- the ones the engine and the resonance make on a voice --
// made at given context times. The reference is an OfflineAudioContext
// suspended at each of those times to make them, as a live context would;
// the timeline gets the same calls with the same `now` and is read block by
// block, as the voice renderer reads it.
//
//   node sampled/tools/automation-test.mjs      (part of npm run sampled:test)
//
// Fails if any case is off by more than LIMIT_DB, relative to the case's
// largest value.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROME = [process.env.CHROMIUM, '/opt/pw-browsers/chromium'].find((p) => p && existsSync(p));
const PORT = process.env.PORT || '8137';
const LIMIT_DB = -120;

const server = spawn(process.execPath, [join(REPO, 'tools', 'serve.mjs')], { env: { ...process.env, PORT }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 400));
const browser = await chromium.launch({ ...(CHROME ? { executablePath: CHROME } : {}) });
const page = await browser.newPage();
await page.goto(`http://localhost:${PORT}/sampled/tools/recorder-worklet.js`);

const rows = await page.evaluate(async () => {
  const { Timeline } = await import('/sampled/src/automation.js');
  const SR = 48000, QS = 128 / SR;
  // A context time on a render quantum boundary: where a suspended offline
  // context stops, and so what currentTime reads when the calls are made.
  const q = (t) => Math.round(t / QS) * QS;
  const fall = new Float32Array(64).map((_, i) => Math.pow(1 - i / 63, 2));
  const rise = new Float32Array(64).map((_, i) => Math.sin(Math.PI / 2 * i / 63));
  const from = (v) => fall.map((x) => x * v);
  // holdFade (envelopes.js): cancel from t, ramp to the curve's value there.
  const hold = (t, curve, t0, dur) => {
    const u = Math.min(1, Math.max(0, (t - t0) / dur)), x = u * (curve.length - 1), k = Math.floor(x);
    const v = curve[k] + (curve[Math.min(curve.length - 1, k + 1)] - curve[k]) * (x - k);
    return [['cancelScheduledValues', t], ['linearRampToValueAtTime', v, t]];
  };
  // [name, seconds, [[at, [[method, ...args] | ['value', v]]]]]
  const cases = [
    ['attack curve', 1, [[0, [['setValueAtTime', 1e-5, 0.1], ['setValueCurveAtTime', rise, 0.1, 0.004]]]]],
    ['level only', 1, [[0, [['value', 0.37]]]]],
    ['damper fall', 1.5, [[0, [['value', 1]]], [q(0.5), [['setValueCurveAtTime', fall, q(0.5) + 0.006, 0.12]]]]],
    ['damper fall, called late', 1.5, [[0, [['value', 1]]], [q(0.5), [['setValueCurveAtTime', fall, q(0.5) - 0.004, 0.12]]]]],
    ['fall, held, fall again', 2.5, [[0, [['value', 1]]],
      [q(0.5), [['setValueCurveAtTime', fall, 0.51, 0.4]]],
      [q(0.6), hold(q(0.6) + 0.02, fall, 0.51, 0.4)],
      [q(1.5), [['setValueCurveAtTime', from(0.5625), 1.51, 0.3]]]]],
    ['fall held after 3 s', 4.5, [[0, [['value', 1]]],
      [q(3.0), [['setValueCurveAtTime', fall, 3.01, 0.4]]],
      [q(3.1), hold(q(3.1) + 0.02, fall, 3.01, 0.4)],
      [q(4.0), [['setValueCurveAtTime', from(0.6), 4.01, 0.3]]]]],
    ['top-ups', 3, [[0, [['value', 0.2]]],
      [q(0.3), [['setTargetAtTime', 0.35, 0.31, 0.04]]],
      [q(0.33), [['setTargetAtTime', 0.5, 0.34, 0.04]]],
      [q(2.0), [['setTargetAtTime', 0.55, 2.01, 0.04]]]]],
    ['release as a ramp', 1.5, [[0, [['value', 1]]], [q(0.4), [['setValueAtTime', 0.8, 0.41], ['linearRampToValueAtTime', 0, 0.91]]]]],
    ['tail cut short', 2, [[0, [['value', 1]]],
      [q(0.5), [['setValueCurveAtTime', fall, 0.51, 1.0]]],
      [q(0.8), [...hold(q(0.8) + 0.02, fall, 0.51, 1.0), ['linearRampToValueAtTime', 0, q(0.8) + 0.12]]]]],
    ['revived twice, then cut', 3, [[0, [['value', 1]]],
      [q(0.3), [['setValueCurveAtTime', fall, 0.31, 0.6]]],
      [q(0.4), hold(q(0.4) + 0.02, fall, 0.31, 0.6)],
      [q(1.0), [['setValueCurveAtTime', from(0.7), 1.01, 0.6]]],
      [q(1.2), hold(q(1.2) + 0.02, from(0.7), 1.01, 0.6)],
      [q(2.0), [['setValueCurveAtTime', from(0.3), 2.01, 0.6]]],
      [q(2.1), [...hold(q(2.1) + 0.02, from(0.3), 2.01, 0.6), ['linearRampToValueAtTime', 0, q(2.1) + 0.12]]]]],
    ['fall by target', 1, [[0, [['value', 1]]], [q(0.3), [['setTargetAtTime', 0, 0.31, 0.02]]]]],
    ['solo ramp', 1, [[0, [['value', 1]]], [q(0.3), [['cancelScheduledValues', q(0.3)], ['setValueAtTime', 1, q(0.3)], ['linearRampToValueAtTime', 0, q(0.3) + 0.02]]],
      [q(0.6), [['cancelScheduledValues', q(0.6)], ['setValueAtTime', 0, q(0.6)], ['linearRampToValueAtTime', 1, q(0.6) + 0.02]]]]],
    ['filter glide (Hz)', 1, [[0, [['value', 10]]], [q(0.2), [['setTargetAtTime', 180, 0.21, 0.05]]], [q(0.5), [['setTargetAtTime', 90, 0.5, 0.05]]]]],
  ];

  const out = [];
  for (const [name, secs, steps] of cases) {
    const N = Math.round(secs * SR);
    // Chrome.
    const ctx = new OfflineAudioContext(1, N, SR);
    const b = ctx.createBuffer(1, N, SR); b.getChannelData(0).fill(1);
    const src = ctx.createBufferSource(); src.buffer = b;
    const g = ctx.createGain(); src.connect(g).connect(ctx.destination);
    const apply = (p, calls) => {
      for (const [m, ...a] of calls) { if (m === 'value') p.value = a[0]; else p[m](...a); }
    };
    for (const [at, calls] of steps) {
      if (at === 0) apply(g.gain, calls);
      else ctx.suspend(at).then(() => { apply(g.gain, calls); ctx.resume(); });
    }
    src.start(0);
    const ref = (await ctx.startRendering()).getChannelData(0);
    // The timeline, read a quantum at a time.
    const tl = new Timeline(1);
    const js = new Float32Array(N), blk = new Float32Array(128);
    let s = 0;
    for (let f0 = 0; f0 < N; f0 += 128) {
      const now = f0 / SR;
      while (s < steps.length && Math.abs(steps[s][0] - now) < 1e-9) {
        for (const [m, ...a] of steps[s][1]) {
          if (m === 'value') tl.setValueAtTime(a[0], now, now);
          else tl[m](...a, now);
        }
        s++;
      }
      const n = Math.min(128, N - f0);
      const c = tl.fill(blk, f0, n, SR);
      for (let i = 0; i < n; i++) js[f0 + i] = c === c ? c : blk[i];
    }
    let peak = 0, diff = 0, at = 0;
    for (let i = 0; i < N; i++) {
      peak = Math.max(peak, Math.abs(ref[i]));
      const d = Math.abs(ref[i] - js[i]);
      if (d > diff) { diff = d; at = i; }
    }
    out.push({ name, db: diff ? 20 * Math.log10(diff / peak) : -Infinity, at: at / SR, ref: ref[at], js: js[at] });
  }
  return out;
});
await browser.close();
server.kill();

let bad = 0;
console.log('');
for (const r of rows) {
  const ok = r.db <= LIMIT_DB;
  if (!ok) bad++;
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${r.name.padEnd(28)} ${r.db === -Infinity ? 'identical' : `${r.db.toFixed(1)} dB`}`
    + (ok ? '' : `   (at ${r.at.toFixed(5)} s: Chrome ${r.ref}, timeline ${r.js})`));
}
console.log(bad ? `\n  AUTOMATION: ${bad} FAILED\n` : '\n  AUTOMATION MATCHES CHROME\n');
process.exit(bad ? 1 : 0);
