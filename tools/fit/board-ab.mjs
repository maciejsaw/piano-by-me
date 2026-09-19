// How much of what you hear is the board, and how slowly does it get going?
//
//   node tools/fit/board-ab.mjs [note] [midi]
//
// A string radiates almost nothing by itself -- it is too thin to move much
// air. What reaches the room is the soundboard, driven through the bridge, and
// a soundboard is a big slow plate: it takes tens of milliseconds for its
// modes to take up the energy of a blow. If the balance here leans on the
// string's own motion instead, the result is a struck string heard nearly
// directly, which is very close to the definition of a clavinet.
//
// Two knobs move that balance:
//
//   boardMix      how much of the output goes through the plate's diffusion
//                 rather than straight out. At 1 the body is exactly an
//                 allpass -- magnitude untouched, energy only moved in time,
//                 so none of the fitted spectral balance is at risk. It is the
//                 PARTIAL mixes that colour, by combing the dry against the
//                 diffused, so turning this up is not the reckless direction.
//   boardSpreadMs how big the plate is, in effect: how far the smear reaches.
//
// and the swell sets how quiet the note is while that is happening.
//
// Level-matched at 0.3 s, so what changes between takes is the arrival and not
// the volume.
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
  ['current (board 0.67 / 37 ms, no swell)', {}],
  ['all board (1.0 / 37 ms), no swell', { body: { boardMix: 1 } }],
  ['all board + swell 30 ms from 0.25', { swellS: 0.030, swellFloor: 0.25, body: { boardMix: 1 } }],
  ['all board + swell 60 ms from 0.05', { swellS: 0.060, swellFloor: 0.05, body: { boardMix: 1 } }],
  ['all board, bigger (1.0 / 45 ms) + swell 30 from 0.15', { swellS: 0.030, swellFloor: 0.15, body: { boardMix: 1, boardSpreadMs: 45, boardStages: 6, boardG: 0.70 } }],
  ['all board, big and slow (1.0 / 60 ms) + swell 45 from 0.10', { swellS: 0.045, swellFloor: 0.10, body: { boardMix: 1, boardSpreadMs: 60, boardStages: 7, boardG: 0.72 } }],
];

const len = Math.round(3.5 * FS), gap = Math.round(0.45 * FS);
const out = new Float32Array((TAKES.length + 1) * (len + gap));
for (let k = 0; k < len; k++) out[k] = s.data[k] ?? 0;
const r = onsetShape(s.data, s.rate);
console.log(`  1. real ${NAME}${''.padEnd(51)} half ${String(r.halfMs).padStart(3)} ms  peak ${String(r.peakMs).padStart(3)} ms  click ${r.clickDb.toFixed(1)} dB`);
TAKES.forEach(([label, o], i) => {
  const x = renderNote(4.5, MIDI, { velocity: 0.83, ...o });
  const g = ref / Math.max(rms(x, Math.round(0.3 * FS), 9600), 1e-12);
  const at = (i + 1) * (len + gap);
  for (let k = 0; k < len; k++) out[at + k] = (x[k] ?? 0) * g;
  const q = onsetShape(x, FS);
  console.log(`  ${i + 2}. ${label.padEnd(58)} half ${String(q.halfMs).padStart(3)} ms  peak ${String(q.peakMs).padStart(3)} ms  click ${q.clickDb.toFixed(1)} dB`);
});
writeWav(`renders/board-${NAME.toLowerCase()}.wav`, out, FS);
console.log(`\nrenders/board-${NAME.toLowerCase()}.wav`);
