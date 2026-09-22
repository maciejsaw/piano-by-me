// How steep should the contact-duration curve be? One file per gamma, each
// walking the same notes, so the ear compares the SHAPE across the keyboard
// rather than one note at a time.
//
//   node tools/fit/contact-slope-ab.mjs [gammas]
import { readWav } from './wavread.mjs';
import { buildScale } from '../../src/dsp/scale.js';
import { scaleWithGamma, targetMs } from './hardness.mjs';
import { renderNote } from './decay-report.mjs';
import { writeWav } from '../wav.mjs';

const FS = 48000;
const DIR = process.env.SAMPLES ?? '/home/user/samples/salamander';
const GAMMAS = (process.argv[2] ?? '1,1.3,1.6').split(',').map(Number);
const PICKS = [['A0', 21], ['C2', 36], ['C3', 48], ['C4', 60], ['C5', 72]];
const model = buildScale();
const rms = (x, a, n) => { let v = 0; for (let i = a; i < a + n; i++) v += (x[i] ?? 0) ** 2; return Math.sqrt(v / n); };

for (const g of GAMMAS) {
  const scale = scaleWithGamma(model, g);
  const len = Math.round(2.6 * FS), gap = Math.round(0.35 * FS);
  const out = new Float32Array(PICKS.length * 2 * (len + gap));
  console.log(`\ngamma ${g}   contact ms: ` + PICKS.map(([n, m]) => `${n} ${targetMs(m, g).toFixed(2)}`).join('  '));
  PICKS.forEach(([name, midi], i) => {
    const s = readWav(`${DIR}/${name}v12.wav`);
    const ref = rms(s.data, Math.round(0.3 * s.rate), 9600);
    const x = renderNote(3.5, midi, { velocity: 0.83, scale });
    const gain = ref / Math.max(rms(x, Math.round(0.3 * FS), 9600), 1e-12);
    const a = i * 2 * (len + gap), b = a + len + gap;
    for (let k = 0; k < len; k++) { out[a + k] = s.data[k] ?? 0; out[b + k] = (x[k] ?? 0) * gain; }
  });
  writeWav(`renders/contact-gamma-${String(g).replace('.', 'p')}.wav`, out, FS);
  console.log(`  renders/contact-gamma-${String(g).replace('.', 'p')}.wav  (real, ours, per note, bottom to top)`);
}
