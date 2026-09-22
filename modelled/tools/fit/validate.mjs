// Close the loop: render the fitted model and re-measure it with the SAME
// extractor used on the samples, then compare. Fitting that is never validated
// by re-measuring its own output is just curve-drawing.
//
//   node tools/fit/validate.mjs <sampleDir> <fittedScale.json> [layer]

import { readFileSync } from 'node:fs';
import { Piano } from '../../src/dsp/piano.js';
import { DEFAULT_SCALE } from '../../src/dsp/scale.js';
import { indexLibrary, loadNote } from './samples.mjs';
import { extractFeatures } from './features.mjs';
import { noteHz, noteName } from '../../src/dsp/physics.js';

const [dir, scalePath, layerArg, bodyPath] = process.argv.slice(2);
const layer = Number(layerArg || 12);
const fitted = JSON.parse(readFileSync(scalePath, 'utf8'));
const bodyCurve = bodyPath ? JSON.parse(readFileSync(bodyPath, 'utf8')).curve : null;
const FS = 48000;

const renderNote = (scale, midi, vel = 0.7, seconds = 3.5, body = null) => {
  const p = new Piano(FS, { quality: 24, scale, body: body ?? { enabled: false } });
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

/** Distance between two attack spectra, in dB, over shared partials. */
function spectralDistance(a, b, nMax = 14) {
  let sum = 0, cnt = 0;
  for (let n = 1; n <= nMax; n++) {
    const pa = a.partials.find((p) => p.n === n && p.reliable);
    const pb = b.partials.find((p) => p.n === n && p.reliable);
    if (!pa || !pb) continue;
    sum += Math.pow(pa.relDb - pb.relDb, 2); cnt++;
  }
  return cnt >= 5 ? Math.sqrt(sum / cnt) : NaN;
}

const lib = indexLibrary(dir).filter((f) => f.layer === layer);
const probes = lib.filter((f) => [21, 33, 45, 54, 60, 69, 72, 84].includes(f.midi));

console.log('\n  Model vs real piano, same extractor on both.');
console.log('  "base" = hand-designed default, "fit" = inverted from these samples.\n');
console.log('  note |  B error base -> fit   | tuning err base -> fit | spectrum RMS base -> fit');
console.log('  -----+------------------------+------------------------+-------------------------');

const acc = { bB: [], fB: [], bT: [], fT: [], bS: [], fS: [] };
for (const f of probes) {
  const { data, rate } = loadNote(f.path);
  const target = extractFeatures(data, rate, noteHz(f.midi), { nMax: 20, decaySpanS: 2.5, attackDelayS: 0.05 });

  const out = {};
  const configs = [['base', DEFAULT_SCALE, { enabled: false }], ['fit', fitted, bodyCurve ? { curve: bodyCurve } : { enabled: false }]];
  for (const [tag, scale, body] of configs) {
    const r = renderNote(scale, f.midi, 0.7, 3.5, body);
    const feat = extractFeatures(r.x, FS, r.f0, { nMax: 20, decaySpanS: 2.5, attackDelayS: 0.05 });
    out[tag] = {
      bErr: 100 * (feat.B / target.B - 1),
      tErr: 1200 * Math.log2(feat.f0 / target.f0),
      spec: spectralDistance(feat, target),
    };
  }
  acc.bB.push(Math.abs(out.base.bErr)); acc.fB.push(Math.abs(out.fit.bErr));
  acc.bT.push(Math.abs(out.base.tErr)); acc.fT.push(Math.abs(out.fit.tErr));
  if (isFinite(out.base.spec)) acc.bS.push(out.base.spec);
  if (isFinite(out.fit.spec)) acc.fS.push(out.fit.spec);

  const f2 = (v, u = '') => (isFinite(v) ? v.toFixed(1) + u : '  --');
  console.log(
    `  ${noteName(f.midi).padEnd(4)} | ${f2(out.base.bErr, '%').padStart(9)} -> ${f2(out.fit.bErr, '%').padStart(9)} | ` +
    `${f2(out.base.tErr, 'c').padStart(9)} -> ${f2(out.fit.tErr, 'c').padStart(9)} | ` +
    `${f2(out.base.spec, 'dB').padStart(10)} -> ${f2(out.fit.spec, 'dB').padStart(10)}`);
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
console.log('  -----+------------------------+------------------------+-------------------------');
console.log(
  `  mean | ${mean(acc.bB).toFixed(1).padStart(9)}% -> ${mean(acc.fB).toFixed(1).padStart(9)}% | ` +
  `${mean(acc.bT).toFixed(1).padStart(9)}c -> ${mean(acc.fT).toFixed(1).padStart(9)}c | ` +
  `${mean(acc.bS).toFixed(1).padStart(10)}dB -> ${mean(acc.fS).toFixed(1).padStart(10)}dB`);
console.log('');
