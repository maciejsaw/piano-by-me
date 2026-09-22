// Is the treble blur the soundboard's ring-up rather than the strike?
//
//   node tools/fit/blur-ab.mjs [note] [midi]
//
// The board diffuser spreads a transient over a fixed 37 ms whatever the note
// is. At C4 that is ten periods; at C5 it is twenty, and at C6 forty. A real
// board does not behave that way -- the treble bridge region is small and
// stiff and gives its energy up quickly -- so a fixed spread should smear the
// top of the keyboard more and more the higher it goes, which is what "too
// blurred at C5" sounds like. This varies the spread alone.
import { readWav } from './wavread.mjs';
import { renderNote } from './decay-report.mjs';
import { writeWav } from '../wav.mjs';
import { noteHz } from '../../src/dsp/physics.js';

const FS = 48000;
const NAME = process.argv[2] ?? 'C5';
const MIDI = Number(process.argv[3] ?? 72);
const s = readWav(`${process.env.SAMPLES ?? '/home/user/samples/salamander'}/${NAME}v12.wav`);
const rms = (x, a, n) => { let v = 0; for (let i = a; i < a + n; i++) v += (x[i] ?? 0) ** 2; return Math.sqrt(v / n); };
const ref = rms(s.data, Math.round(0.3 * s.rate), 9600);

const SPREADS = (process.env.SPREADS ?? '37,24,15,9').split(',').map(Number);
const len = Math.round(3 * FS), gap = Math.round(0.45 * FS);
const out = new Float32Array((SPREADS.length + 1) * (len + gap));
for (let k = 0; k < len; k++) out[k] = s.data[k] ?? 0;
console.log(`  1. real ${NAME}   (period ${(1000 / noteHz(MIDI)).toFixed(2)} ms)`);
SPREADS.forEach((sp, i) => {
  const x = renderNote(4, MIDI, { velocity: 0.83, body: { boardSpreadMs: sp } });
  const g = ref / Math.max(rms(x, Math.round(0.3 * FS), 9600), 1e-12);
  const at = (i + 1) * (len + gap);
  for (let k = 0; k < len; k++) out[at + k] = (x[k] ?? 0) * g;
  console.log(`  ${i + 2}. board spread ${sp} ms  (${(sp * noteHz(MIDI) / 1000).toFixed(0)} periods)`);
});
writeWav(`renders/blur-${NAME.toLowerCase()}.wav`, out, FS);
console.log(`\nrenders/blur-${NAME.toLowerCase()}.wav`);
