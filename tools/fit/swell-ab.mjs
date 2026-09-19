// Does the note need to arrive QUIETER, not just darker?
//
//   node tools/fit/swell-ab.mjs [note] [midi]
//
// Damping in this model has only ever changed the string's spectrum. A
// dampened string also sounds with less volume, and a soundboard does not
// begin radiating the instant the string moves -- it has to be set going.
// Until it is, the whole note is quieter, top and bottom alike. Leaving that
// out is why the strike can be the right colour and still peak.
//
// This swells what leaves for the soundboard, from `floor` up to full over
// `swellS`, with the same skewed ease as the build. The string's own physics
// and the unison junction are untouched: the strings do not stop hearing each
// other while the board is getting going.
//
// Worth knowing when reading this: the crest measure cannot see it. Crest is
// peak over RMS inside the first 5 ms, and a swell scales both together
// inside that window -- it moved 0.1 dB across every setting below. What it
// changes is the early level against the rest of the note, which is a thing
// the ear is better at than any of the numbers here so far.
import { readWav } from './wavread.mjs';
import { renderNote } from './decay-report.mjs';
import { onsetShape } from './onset.mjs';
import { writeWav } from '../wav.mjs';

const FS = 48000;
const NAME = process.argv[2] ?? 'C4';
const MIDI = Number(process.argv[3] ?? 60);
const s = readWav(`${process.env.SAMPLES ?? '/home/user/samples/salamander'}/${NAME}v12.wav`);
const rms = (x, a, n) => { let v = 0; for (let i = a; i < a + n; i++) v += (x[i] ?? 0) ** 2; return Math.sqrt(v / n); };
const ref = rms(s.data, Math.round(0.3 * s.rate), 9600);

const TAKES = [
  ['no swell (current)', {}],
  ['swell 30 ms from 0.25', { swellS: 0.030, swellFloor: 0.25 }],
  ['swell 30 ms from 0.10', { swellS: 0.030, swellFloor: 0.10 }],
  ['swell 30 ms from 0.25, less board', { swellS: 0.030, swellFloor: 0.25, body: { boardMix: 0.3, boardSpreadMs: 18 } }],
  ['swell 30 ms from 0.10, less board', { swellS: 0.030, swellFloor: 0.10, body: { boardMix: 0.3, boardSpreadMs: 18 } }],
  ['swell 60 ms from 0.05, less board', { swellS: 0.060, swellFloor: 0.05, body: { boardMix: 0.3, boardSpreadMs: 18 } }],
];

const len = Math.round(3.5 * FS), gap = Math.round(0.45 * FS);
const out = new Float32Array((TAKES.length + 1) * (len + gap));
for (let k = 0; k < len; k++) out[k] = s.data[k] ?? 0;
const r = onsetShape(s.data, s.rate);
console.log(`  1. real ${NAME}   half ${r.halfMs} ms  peak ${r.peakMs} ms`);
TAKES.forEach(([label, o], i) => {
  const x = renderNote(4.5, MIDI, { velocity: 0.83, ...o });
  const g = ref / Math.max(rms(x, Math.round(0.3 * FS), 9600), 1e-12);
  const at = (i + 1) * (len + gap);
  for (let k = 0; k < len; k++) out[at + k] = (x[k] ?? 0) * g;
  const q = onsetShape(x, FS);
  console.log(`  ${i + 2}. ${label.padEnd(34)} half ${String(q.halfMs).padStart(3)} ms  peak ${String(q.peakMs).padStart(3)} ms`);
});
writeWav(`renders/swell-${NAME.toLowerCase()}.wav`, out, FS);
console.log(`\nrenders/swell-${NAME.toLowerCase()}.wav`);
