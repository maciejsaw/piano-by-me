// How steep, and how deep, the soundboard swell should be.
//
//   node tools/fit/slope-ab.mjs [note] [midi]
//
// The balance question is settled: all board (see board-ab.mjs), with the
// radiated level swelling up from a floor rather than arriving whole. What is
// left is the shape of that swell, and it has two separate knobs that are easy
// to confuse by ear:
//
//   swellFloor  how quiet the note starts. Deeper is a softer arrival, and
//               too deep is a note that fades in.
//   swellSkew   how much of the swell is spent down at the bottom. 1 is a
//               plain smootherstep; above 1 the phase is bent so the level
//               crawls for most of the swell and then goes. This is the knob
//               that reads as "curved".
//
// Take 2 here is the one the ear picked out of the balance ladder. The rest
// walk 20% of the way back towards no swell at all and take some curve out of
// the slope, which is what it asked for next.
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
  ['30 ms from 0.25, skew 2.0 (first pick)', { swellS: 0.030, swellFloor: 0.25, swellSkew: 2.0 }],
  ['24 ms from 0.40, skew 1.6', { swellS: 0.024, swellFloor: 0.40, swellSkew: 1.6 }],
  ['24 ms from 0.40, skew 1.3 (straighter)', { swellS: 0.024, swellFloor: 0.40, swellSkew: 1.3 }],
  ['24 ms from 0.40, skew 2.0 (curve kept)', { swellS: 0.024, swellFloor: 0.40, swellSkew: 2.0 }],
  ['default: 20 ms from 0.50, skew 1.4', {}],
];

const len = Math.round(3.5 * FS), gap = Math.round(0.45 * FS);
const out = new Float32Array((TAKES.length + 1) * (len + gap));
for (let k = 0; k < len; k++) out[k] = s.data[k] ?? 0;
const r = onsetShape(s.data, s.rate);
console.log(`  1. real ${NAME}${''.padEnd(35)} half ${String(r.halfMs).padStart(3)} ms  peak ${String(r.peakMs).padStart(3)} ms  click ${r.clickDb.toFixed(1)} dB`);
TAKES.forEach(([label, o], i) => {
  const x = renderNote(4.5, MIDI, { velocity: 0.83, ...o });
  const g = ref / Math.max(rms(x, Math.round(0.3 * FS), 9600), 1e-12);
  const at = (i + 1) * (len + gap);
  for (let k = 0; k < len; k++) out[at + k] = (x[k] ?? 0) * g;
  const q = onsetShape(x, FS);
  console.log(`  ${i + 2}. ${label.padEnd(42)} half ${String(q.halfMs).padStart(3)} ms  peak ${String(q.peakMs).padStart(3)} ms  click ${q.clickDb.toFixed(1)} dB`);
});
writeWav(`renders/slope-${NAME.toLowerCase()}.wav`, out, FS);
console.log(`\nrenders/slope-${NAME.toLowerCase()}.wav`);
