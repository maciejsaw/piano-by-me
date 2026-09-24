// Offline demo renders. `node tools/render.mjs [outDir]`
import { mkdirSync } from 'node:fs';
import { Piano } from '../src/dsp/piano.js';
import { writeWav } from './wav.mjs';

const FS = 48000;
const outDir = process.argv[2] || 'renders';
mkdirSync(outDir, { recursive: true });

function scene(seconds, script, opts = {}) {
  const p = new Piano(FS, { quality: opts.quality ?? 32, ...opts });
  const N = Math.round(FS * seconds);
  const x = new Float32Array(N);
  const buf = new Float32Array(256);
  let ev = 0;
  const evs = [...script].sort((a, b) => a.at - b.at);
  for (let i = 0; i < N; i += 256) {
    while (ev < evs.length && evs[ev].at * FS <= i) { evs[ev].run(p); ev++; }
    p.render(buf, 256);
    for (let k = 0; k < 256 && i + k < N; k++) x[i + k] = buf[k];
  }
  return x;
}
const on = (at, midi, v) => ({ at, run: (p) => p.noteOn(midi, v) });
const off = (at, midi) => ({ at, run: (p) => p.noteOff(midi) });
const ped = (at, v) => ({ at, run: (p) => p.setSustain(v) });

const scenes = {
  // A single note, so the unison beating and double decay are exposed.
  'single-note-c4': () => scene(9, [on(0.05, 60, 0.75), off(6.5, 60)]),

  // Wound bass vs plain treble, same gesture.
  'register-sweep': () => scene(13, [21, 33, 45, 57, 69, 81, 93, 105]
    .flatMap((m, i) => [on(0.1 + i * 1.5, m, 0.8), off(1.3 + i * 1.5, m)])),

  // The sympathetic test: C4 held silently, C3 struck and released.
  'sympathetic-resonance': () => scene(8, [
    { at: 0.0, run: (p) => { for (const s of p.notes[60 - 21].voices) s.setDamper(false); p.refreshActive(); } },
    on(0.3, 48, 0.95), off(0.9, 48),
  ]),

  // Same gesture with and without the pedal: the halo is the difference.
  'pedal-halo': () => scene(10, [
    on(0.1, 48, 0.95), on(0.1, 52, 0.95), on(0.1, 55, 0.95),
    off(0.45, 48), off(0.45, 52), off(0.45, 55),
    ped(5.0, true),
    on(5.2, 48, 0.95), on(5.2, 52, 0.95), on(5.2, 55, 0.95),
    off(5.55, 48), off(5.55, 52), off(5.55, 55),
  ]),

  // Dynamics: the hammer pulse shortens with velocity, so tone brightens.
  'velocity-response': () => scene(11, [0.15, 0.35, 0.6, 0.85, 1.0]
    .flatMap((v, i) => [on(0.1 + i * 2.1, 64, v), off(1.7 + i * 2.1, 64)])),

  // Una corda: hammer misses the outer string, which rings sympathetically.
  'una-corda': () => scene(11, [
    on(0.1, 60, 0.8), off(4.0, 60),
    { at: 5.0, run: (p) => p.setUnaCorda(true) },
    on(5.3, 60, 0.8), off(9.2, 60),
  ]),

  // Same phrase three times: no case at all, the default case, then a small
  // shallow case. The string model is identical in all three.
  'body-comparison': () => {
    const phrase = (t0) => [
      ...[52, 56, 59, 64].flatMap((m, i) => [on(t0 + i * 0.13, m, 0.85)]),
      ...[52, 56, 59, 64].map((m) => off(t0 + 2.0, m)),
    ];
    const parts = [
      scene(3.4, phrase(0.1), { body: { enabled: false } }),
      scene(3.4, phrase(0.1), { body: {} }),
      scene(3.4, phrase(0.1), { body: { caseWidth: 1.05, caseLength: 1.35, caseDepth: 0.14, cavityMix: 0.34 } }),
    ];
    const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  },

  // The bass, with the dispersion chain sized per note and then left at the
  // base 16 sections. Same five notes twice; the difference is the metallic
  // edge on the first half.
  'bass-detail-ab': () => {
    const notes = [21, 28, 33, 40, 45];
    const phrase = notes.flatMap((m, i) => [on(0.1 + i * 1.6, m, 0.85), off(1.4 + i * 1.6, m)]);
    const a = scene(8.5, phrase, { detailSplit: 0 });
    const b = scene(8.5, phrase, {});
    const out = new Float32Array(a.length + b.length);
    out.set(a); out.set(b, a.length);
    return out;
  },

  'chord-with-pedal': () => scene(12, [
    ped(0, true),
    ...[40, 47, 52, 56, 59].flatMap((m, i) => [on(0.1 + i * 0.09, m, 0.8)]),
    ...[40, 47, 52, 56, 59].map((m) => off(2.2, m)),
    ...[45, 52, 57, 61, 64].flatMap((m, i) => [on(2.6 + i * 0.09, m, 0.85)]),
    ...[45, 52, 57, 61, 64].map((m) => off(5.0, m)),
    ...[36, 48, 55, 60, 64, 67].flatMap((m, i) => [on(5.4 + i * 0.07, m, 0.9)]),
  ]),
};

for (const [name, make] of Object.entries(scenes)) {
  const t0 = Date.now();
  const x = make();
  let pk = 0; for (const v of x) pk = Math.max(pk, Math.abs(v));
  writeWav(`${outDir}/${name}.wav`, x, FS);
  console.log(`  ${name.padEnd(24)} ${(x.length / FS).toFixed(1)}s  peak ${pk.toFixed(3)}  (${Date.now() - t0}ms)`);
}
console.log(`\n  wrote ${Object.keys(scenes).length} files to ${outDir}/\n`);
