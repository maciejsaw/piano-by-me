// Estimate the missing body/radiation response from a sample library.
//
//   node tools/fit/body.mjs <sampleDir> <fittedScale.json> [layer] [out.json]
//
// The model stops at the bridge: it knows how the soundboard LOADS the strings
// but not how soundboard motion becomes pressure in a room. Everything
// downstream of the bridge -- plate radiation efficiency, the case acting as a
// baffle, cavity modes, the lid, the mics, the room -- is one linear,
// time-invariant block, and it is the same block for every note.
//
// That is what makes it separable. String parameters vary per note; the body
// does not. So pool residuals by ABSOLUTE frequency across many notes and the
// body response emerges, while per-note errors average out.
//
// Each note's partials are measured relative to that note's strongest partial,
// so every note carries an unknown level offset. Solving the body curve and the
// per-note offsets together (alternating least squares) resolves them, because
// partials from different notes overlap in frequency and tie the system down.

import { writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { Piano } from '../../src/dsp/piano.js';
import { DEFAULT_SCALE } from '../../src/dsp/scale.js';
import { indexLibrary, loadNote } from './samples.mjs';
import { extractFeatures } from './features.mjs';
import { noteHz, noteName } from '../../src/dsp/physics.js';

const [dir, scalePath, layerArg, outArg] = process.argv.slice(2);
const layer = Number(layerArg || 12);
const out = outArg || 'body-response.json';
const scale = scalePath ? JSON.parse(readFileSync(scalePath, 'utf8')) : DEFAULT_SCALE;
const FS = 48000;

const render = (midi, vel, seconds = 1.5) => {
  const p = new Piano(FS, { quality: 20, scale });
  const N = Math.round(FS * seconds);
  const x = new Float64Array(N);
  const buf = new Float32Array(256);
  p.noteOn(midi, vel);
  for (let i = 0; i < N; i += 256) {
    p.render(buf, 256);
    for (let k = 0; k < 256 && i + k < N; k++) x[i + k] = buf[k];
  }
  return { x, f0: p.notes[midi - 21].f0 };
};

// --- 1/6-octave log-frequency grid ---
const F_LO = 28, F_HI = 14000, PER_OCT = 6;
const nBins = Math.ceil(Math.log2(F_HI / F_LO) * PER_OCT);
const binCentre = (b) => F_LO * Math.pow(2, (b + 0.5) / PER_OCT);
const binOf = (f) => Math.floor(Math.log2(f / F_LO) * PER_OCT);

const lib = indexLibrary(dir).filter((f) => f.layer === layer);
console.log(`\n  measuring body response from ${lib.length} notes\n`);

const obs = [];            // { note, bin, resid }
const noteIds = [];
for (const f of lib) {
  const { data, rate } = loadNote(f.path);
  const tgt = extractFeatures(data, rate, noteHz(f.midi), { nMax: 22, decaySpanS: 1.2, attackDelayS: 0.05 });
  const r = render(f.midi, 0.7);
  const mod = extractFeatures(r.x, FS, r.f0, { nMax: 22, decaySpanS: 1.2, attackDelayS: 0.05 });

  const id = noteIds.length;
  let used = 0;
  for (let n = 1; n <= 22; n++) {
    const a = tgt.partials.find((p) => p.n === n && p.reliable);
    const b = mod.partials.find((p) => p.n === n && p.reliable);
    if (!a || !b) continue;
    const bin = binOf(a.f);
    if (bin < 0 || bin >= nBins) continue;
    // Positive => the real piano has MORE here than the model: the body's doing.
    obs.push({ note: id, bin, resid: a.relDb - b.relDb });
    used++;
  }
  if (used >= 4) { noteIds.push(f.midi); }
  else { obs.length -= used; }             // too few matches to be worth an offset
  process.stdout.write(`\r  ${noteName(f.midi).padEnd(5)} ${used} partials   `);
}
console.log(`\n  ${obs.length} partial observations across ${noteIds.length} notes`);

// --- alternating least squares: resid[i] = body[bin] + offset[note] ---
const body = new Float64Array(nBins);
const offset = new Float64Array(noteIds.length);
const bodyN = new Float64Array(nBins);
for (const o of obs) bodyN[o.bin]++;

for (let iter = 0; iter < 200; iter++) {
  const offSum = new Float64Array(noteIds.length), offN = new Float64Array(noteIds.length);
  for (const o of obs) { offSum[o.note] += o.resid - body[o.bin]; offN[o.note]++; }
  for (let i = 0; i < offset.length; i++) if (offN[i]) offset[i] = offSum[i] / offN[i];

  const bSum = new Float64Array(nBins);
  bSum.fill(0);
  for (const o of obs) bSum[o.bin] += o.resid - offset[o.note];
  for (let b = 0; b < nBins; b++) if (bodyN[b]) body[b] = bSum[b] / bodyN[b];

  // Fix the global constant: the split between body and offsets is otherwise
  // free to slide, so pin the body curve's weighted mean to 0 dB.
  let s = 0, w = 0;
  for (let b = 0; b < nBins; b++) if (bodyN[b]) { s += body[b] * bodyN[b]; w += bodyN[b]; }
  const mean = w ? s / w : 0;
  for (let b = 0; b < nBins; b++) body[b] -= mean;
  for (let i = 0; i < offset.length; i++) offset[i] += mean;
}

// --- fill empty bins and smooth ---
const filled = Array.from(body);
for (let b = 0; b < nBins; b++) {
  if (bodyN[b] >= 2) continue;
  let lo = b, hi = b;
  while (lo >= 0 && bodyN[lo] < 2) lo--;
  while (hi < nBins && bodyN[hi] < 2) hi++;
  if (lo < 0 && hi >= nBins) { filled[b] = 0; continue; }
  if (lo < 0) filled[b] = body[hi];
  else if (hi >= nBins) filled[b] = body[lo];
  else filled[b] = body[lo] + ((body[hi] - body[lo]) * (b - lo)) / (hi - lo);
}
const smoothed = filled.map((_, b) => {
  let s = 0, w = 0;
  for (let k = -2; k <= 2; k++) {
    const j = b + k;
    if (j < 0 || j >= nBins) continue;
    const wt = Math.exp(-0.5 * (k / 1.1) ** 2);
    s += filled[j] * wt; w += wt;
  }
  return s / w;
});

const curve = [];
for (let b = 0; b < nBins; b++) curve.push([+binCentre(b).toFixed(1), +smoothed[b].toFixed(2)]);
writeFileSync(out, JSON.stringify({ perOctave: PER_OCT, fLo: F_LO, curve }, null, 1));

console.log(`\n  body response (dB to ADD to the model):\n`);
for (let b = 0; b < nBins; b += 2) {
  const v = smoothed[b];
  const bar = v > 0 ? '+'.repeat(Math.min(40, Math.round(v * 1.2)))
                    : '-'.repeat(Math.min(40, Math.round(-v * 1.2)));
  console.log(`   ${binCentre(b).toFixed(0).padStart(6)} Hz  ${v.toFixed(1).padStart(6)} dB  ` +
              `${String(bodyN[b] | 0).padStart(3)} obs  ${bar}`);
}
console.log(`\n  wrote ${out}\n`);
