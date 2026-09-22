// Measure a real piano from its samples. Same extractor used on model renders.
import { indexLibrary, loadNote } from './samples.mjs';
import { extractFeatures } from './features.mjs';
import { noteHz } from '../../src/dsp/physics.js';

const dir = process.argv[2];
const layer = Number(process.argv[3] || 12);
const lib = indexLibrary(dir).filter((f) => f.layer === layer);

console.log(`\n  ${lib.length} notes, velocity layer ${layer}\n`);
console.log('  note  midi     f0(Hz)  tuning     B          alpha   T60 early/late(s)  rel  str  pts');

const rows = [];
for (const f of lib) {
  const { data, rate } = loadNote(f.path);
  const nominal = noteHz(f.midi);
  const feat = extractFeatures(data, rate, nominal, { nMax: 24, decaySpanS: 3.0, attackDelayS: 0.05 });
  const cents = 1200 * Math.log2(feat.f0 / nominal);
  const d = feat.strongest ? feat.strongest.decay : null;
  const nRel = feat.partials.filter((p) => p.reliable).length;
  rows.push({ midi: f.midi, note: f.note, f0: feat.f0, cents, B: feat.B, alpha: feat.strikeAlpha,
              t60e: d ? d.t60Early : NaN, t60l: d ? d.t60Late : NaN, nRel });
  console.log(
    `  ${f.note.padEnd(4)} ${String(f.midi).padStart(4)} ${feat.f0.toFixed(2).padStart(9)} ` +
    `${(cents >= 0 ? '+' : '') + cents.toFixed(1).padStart(5)}c  ${feat.B.toExponential(2)}  ` +
    `${(feat.strikeAlpha || NaN).toFixed(3).padStart(6)}  ` +
    `${(d ? d.t60Early.toFixed(1) : '--').padStart(6)} /${(d ? d.t60Late.toFixed(1) : '--').padStart(6)}   ` +
    `${String(nRel).padStart(4)}  p${String(feat.strongest ? feat.strongest.n : 0).padStart(2)}  ` +
    `curve:${String(feat.decayCurve.length).padStart(3)}`);
}
console.log('');
export {};
