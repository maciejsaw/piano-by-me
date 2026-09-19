// Where does the timbre mismatch actually live?
//
// Before fitting 88 hammers, find out whether the model is wrong per-note or
// wrong the same way everywhere. A constant spectral tilt across the whole
// compass is one soundboard/radiation error, and fitting hammers to absorb it
// would hide the real cause behind 88 wrong hammer weights.
import { Piano } from '../../src/dsp/piano.js';
import { DEFAULT_SCALE } from '../../src/dsp/scale.js';
import { indexLibrary, loadNote } from './samples.mjs';
import { extractFeatures } from './features.mjs';
import { noteHz, noteName } from '../../src/dsp/physics.js';

const [dir, layerArg] = process.argv.slice(2);
const layer = Number(layerArg || 12);
const FS = 48000;

const render = (midi, vel) => {
  const p = new Piano(FS, { quality: 20, scale: DEFAULT_SCALE });
  const N = Math.round(FS * 1.5);
  const x = new Float64Array(N);
  const buf = new Float32Array(256);
  p.noteOn(midi, vel);
  for (let i = 0; i < N; i += 256) {
    p.render(buf, 256);
    for (let k = 0; k < 256 && i + k < N; k++) x[i + k] = buf[k];
  }
  return { x, f0: p.notes[midi - 21].f0 };
};

const lib = indexLibrary(dir).filter((f) => f.layer === layer);
const probes = lib.filter((f) => [33, 45, 54, 60, 66, 72, 78, 84].includes(f.midi));

// Pool residuals into octave bands of ABSOLUTE frequency.
const bands = [];
for (let f = 62.5; f < 16000; f *= 2) bands.push({ lo: f, hi: f * 2, vals: [] });
const perNote = [];

for (const f of probes) {
  const { data, rate } = loadNote(f.path);
  const tgt = extractFeatures(data, rate, noteHz(f.midi), { nMax: 20, decaySpanS: 1.2, attackDelayS: 0.05 });
  const r = render(f.midi, 0.7);
  const mod = extractFeatures(r.x, FS, r.f0, { nMax: 20, decaySpanS: 1.2, attackDelayS: 0.05 });

  const diffs = [];
  for (let n = 1; n <= 20; n++) {
    const a = tgt.partials.find((p) => p.n === n && p.reliable);
    const b = mod.partials.find((p) => p.n === n && p.reliable);
    if (!a || !b) continue;
    const d = b.relDb - a.relDb;             // model minus real, dB
    diffs.push({ n, f: a.f, d });
    const band = bands.find((bd) => a.f >= bd.lo && a.f < bd.hi);
    if (band) band.vals.push(d);
  }
  const mean = diffs.length ? diffs.reduce((s, x) => s + x.d, 0) / diffs.length : NaN;
  perNote.push({ midi: f.midi, mean, n: diffs.length, diffs });
}

console.log('\n  Model minus real, dB (positive = model too strong)\n');
console.log('  per note (mean over partials):');
for (const p of perNote)
  console.log(`    ${noteName(p.midi).padEnd(5)} ${p.mean.toFixed(1).padStart(6)} dB   (${p.n} partials)`);

console.log('\n  pooled by absolute frequency:');
for (const b of bands) {
  if (b.vals.length < 3) continue;
  const m = b.vals.reduce((s, x) => s + x, 0) / b.vals.length;
  const sd = Math.sqrt(b.vals.reduce((s, x) => s + (x - m) ** 2, 0) / b.vals.length);
  const bar = m > 0 ? '+'.repeat(Math.min(30, Math.round(m))) : '-'.repeat(Math.min(30, Math.round(-m)));
  console.log(`    ${String(Math.round(b.lo)).padStart(6)}-${String(Math.round(b.hi)).padEnd(6)} ` +
              `${m.toFixed(1).padStart(6)} dB  (sd ${sd.toFixed(1).padStart(4)}, n=${String(b.vals.length).padStart(3)})  ${bar}`);
}
console.log('');
