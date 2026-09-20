// The colour of the knock, at a fixed level.
//
//   node tools/fit/knock-tone-ab.mjs [note] [midi]
//
// The amount is settled (12 dB under the note's peak, halved by ear to 18).
// What is left is what it sounds like, and the first version got that wrong in
// a way worth writing down: the noise was one-pole lowpassed, which rolls off
// at 6 dB an octave and so is still clearly present two decades up, and the
// radiation EQ then lifts 2-8 kHz by another 7 dB on the way out. The result
// hisses. A big heavy plate does not answer a tap with hiss; it answers with a
// low thud.
//
// So two knobs: how far up the noise reaches, and how much of the board's low
// resonance sits under it.
//
// EVERY take here is normalised to the same knock level, measured rather than
// assumed -- the knock is isolated by rendering twice and subtracting, and the
// scale is then solved in one step because it is linear. Without that,
// "darker" and "quieter" arrive together and cannot be told apart by ear,
// which is how a tone ladder turns into a level ladder without anybody
// noticing.
import { readWav } from './wavread.mjs';
import { renderNote } from './decay-report.mjs';
import { writeWav } from '../wav.mjs';

const FS = 48000;
const NAME = process.argv[2] ?? 'C2';
const MIDI = Number(process.argv[3] ?? 36);
const UNDER = Number(process.env.UNDER ?? 18);        // dB under the note's peak
const s = readWav(`${process.env.SAMPLES ?? '/home/user/samples/salamander'}/${NAME}v12.wav`);
const rms = (x, a, n) => { let v = 0; for (let i = a; i < a + n; i++) v += (x[i] ?? 0) ** 2; return Math.sqrt(v / n); };
const ref = rms(s.data, Math.round(0.3 * s.rate), 9600);
const span = Math.round(0.1 * FS);

const TAKES = [
  ['no knock', null],
  ['as shipped (1-pole, no thump)', { knockPoles: 1, knockThumpScale: 0 }],
  ['3-pole, no thump', { knockThumpScale: 0 }],
  ['3-pole + thump', {}],
  ['3-pole, darker (fc x0.6) + thump', { knockFcScale: 0.6 }],
  ['3-pole, darker + more thump', { knockFcScale: 0.6, knockThumpScale: 2 }],
];

const len = Math.round(3.5 * FS), gap = Math.round(0.45 * FS);
const out = new Float32Array((TAKES.length + 1) * (len + gap));
for (let k = 0; k < len; k++) out[k] = s.data[k] ?? 0;

const dry = renderNote(4.5, MIDI, { velocity: 0.83, knockScale: 0 });
let dryPk = 0;
for (let i = 0; i < span; i++) { const a = Math.abs(dry[i]); if (a > dryPk) dryPk = a; }
const want = Math.pow(10, -UNDER / 20);

console.log(`  1. real ${NAME}`);
TAKES.forEach(([label, o], i) => {
  let x = dry, scale = 0;
  if (o) {
    // One probe fixes the scale: the knock is linear in it, and so is every
    // stage between it and the output.
    const probe = renderNote(4.5, MIDI, { velocity: 0.83, knockScale: 1, ...o });
    let p = 0;
    for (let k = 0; k < span; k++) { const d = Math.abs(probe[k] - dry[k]); if (d > p) p = d; }
    scale = (want * dryPk) / (p + 1e-30);
    x = renderNote(4.5, MIDI, { velocity: 0.83, knockScale: scale, ...o });
  }
  const g = ref / Math.max(rms(x, Math.round(0.3 * FS), 9600), 1e-12);
  const at = (i + 1) * (len + gap);
  for (let k = 0; k < len; k++) out[at + k] = (x[k] ?? 0) * g;
  console.log(`  ${i + 2}. ${label.padEnd(34)} scale ${scale.toFixed(3)}`);
});
writeWav(`renders/knocktone-${NAME.toLowerCase()}.wav`, out, FS);
console.log(`\nrenders/knocktone-${NAME.toLowerCase()}.wav`);
