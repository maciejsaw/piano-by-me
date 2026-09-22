// Validate the feature extractor against renders whose parameters we KNOW.
// Pointing a fitter at real recordings before proving it can recover known
// answers is how you end up confidently fitting noise.
import { Piano } from '../../src/dsp/piano.js';
import { extractFeatures } from './features.mjs';

const FS = 48000;
const render = (p, seconds, midi, vel) => {
  const N = Math.round(FS * seconds);
  const x = new Float64Array(N);
  const buf = new Float32Array(256);
  p.noteOn(midi, vel);
  for (let i = 0; i < N; i += 256) {
    p.render(buf, 256);
    for (let k = 0; k < 256 && i + k < N; k++) x[i + k] = buf[k];
  }
  return x;
};

console.log('\n  Recovering known parameters from rendered audio\n');
console.log('  note   B spec      B measured   err     alpha spec  measured   T60 spec  measured');

let worstB = 0, worstA = 0;
for (const midi of [33, 45, 52, 60, 67, 72]) {
  const p = new Piano(FS, { quality: 32, unisonCoupling: 0.02, bridgeCoupling: 0.02 });
  const note = p.notes[midi - 21];
  // zero detune so unison beating does not bias the decay fit
  for (const s of note.voices) p.recompileString(s, { ...s.tuning, detuneCents: 0 });
  const specB = note.phys.B;
  const specAlpha = note.strings[1].strikePosition;
  const specT60 = note.strings[1].t60Low;

  const x = render(p, 4, midi, 0.8);
  const f = extractFeatures(x, FS, note.f0, { nMax: 22, decaySpanS: 3 });

  const errB = (f.B / specB - 1) * 100;
  const errA = (f.strikeAlpha / specAlpha - 1) * 100;
  const t60 = f.partials[0].decay ? f.partials[0].decay.t60Late : NaN;
  worstB = Math.max(worstB, Math.abs(errB));
  worstA = Math.max(worstA, Math.abs(errA));

  console.log(
    `  ${note.name.padEnd(5)} ${specB.toExponential(2)}   ${f.B.toExponential(2)}   ` +
    `${errB.toFixed(1).padStart(6)}%  ${specAlpha.toFixed(3).padStart(8)}  ` +
    `${(f.strikeAlpha || NaN).toFixed(3).padStart(8)} (${errA.toFixed(1)}%)  ` +
    `${specT60.toFixed(1).padStart(7)}s ${(isFinite(t60) ? t60.toFixed(1) : '--').padStart(8)}s`);
}
console.log(`\n  worst B error ${worstB.toFixed(1)}%,  worst strike-position error ${worstA.toFixed(1)}%\n`);
