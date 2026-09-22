// What owns the metallic zing in the bass: the strike, or the decay?
//
//   node tools/fit/bass-zing-ab.mjs
//
// Two candidates, and they call for opposite work, so the ear should separate
// them before either is built:
//
//   strike   contact too short for a wound string. A wound bass string is a
//            soft thick surface the felt sinks into; too brief a contact is a
//            sharp pulse on a long string. Cured by lengthening contact.
//   decay    the high partials are excited about right but then ring on far
//            too long. Measured, A0 sits 26 dB too bright and gets BRIGHTER
//            through the note where the real one sheds 27 dB. Cured by
//            cutting the high-frequency T60 in the bass, which is what the
//            keyboard-wide damping fit asked for and never got applied.
//
// If lengthening contact alone fixes it, it is the strike. If cutting the
// bass T60 alone fixes it, it is the decay, and no amount of felt will do it.
import { readWav } from './wavread.mjs';
import { buildScale, DEFAULT_SCALE } from '../../src/dsp/scale.js';
import { scaleWithGamma, targetMs } from './hardness.mjs';
import { renderNote } from './decay-report.mjs';
import { writeWav } from '../wav.mjs';

const FS = 48000;
const DIR = process.env.SAMPLES ?? '/home/user/samples/salamander';
const PICKS = [['A0', 21], ['C2', 36], ['C3', 48]];
const model = buildScale();
const WOUND = 52.5;

/** Cut t60High below the wound break only, leaving the rest of the scale alone. */
const cutBassTreble = (scale, k) => ({
  ...scale,
  voicing: {
    ...scale.voicing,
    t60High: scale.voicing.t60High.map(([m, v]) => [m, m < WOUND ? v * k : v]),
  },
});

const rms = (x, a, n) => { let v = 0; for (let i = a; i < a + n; i++) v += (x[i] ?? 0) ** 2; return Math.sqrt(v / n); };
const takes = [
  ['A  contact gB2 gT2, bass T60 as is', scaleWithGamma(model, 2, 2)],
  ['B  contact gB3 gT2.5, bass T60 as is', scaleWithGamma(model, 3, 2.5)],
  ['C  contact gB2 gT2, bass t60High x0.1', cutBassTreble(scaleWithGamma(model, 2, 2), 0.1)],
  ['D  contact gB3 gT2.5, bass t60High x0.1', cutBassTreble(scaleWithGamma(model, 3, 2.5), 0.1)],
];

for (const [name, midi] of PICKS) {
  const s = readWav(`${DIR}/${name}v12.wav`);
  const ref = rms(s.data, Math.round(0.3 * s.rate), 9600);
  const len = Math.round(3.5 * FS), gap = Math.round(0.45 * FS);
  const out = new Float32Array((takes.length + 1) * (len + gap));
  for (let k = 0; k < len; k++) out[k] = s.data[k] ?? 0;
  takes.forEach(([label, scale], i) => {
    const x = renderNote(4.5, midi, { velocity: 0.83, scale });
    const g = ref / Math.max(rms(x, Math.round(0.3 * FS), 9600), 1e-12);
    const at = (i + 1) * (len + gap);
    for (let k = 0; k < len; k++) out[at + k] = (x[k] ?? 0) * g;
  });
  writeWav(`renders/zing-${name.toLowerCase()}.wav`, out, FS);
  console.log(`renders/zing-${name.toLowerCase()}.wav  contact ${targetMs(midi, 2, 2).toFixed(2)} / ${targetMs(midi, 3, 2.5).toFixed(2)} ms`);
}
console.log('\n  1 real,  2 = A,  3 = B,  4 = C,  5 = D');
takes.forEach(([l]) => console.log('    ' + l));
