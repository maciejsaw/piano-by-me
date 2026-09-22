// Middle C: the sample, the hammer as it was, and the hammer as fitted.
// `node tools/fit/hammer-ab.mjs`
//
// Rendered at velocity 0.9, because fitting the attack ladder against the
// v12 layer says that is where Salamander's v12 sits on our velocity curve --
// our 0.75 is a softer blow than theirs.
import { readWav } from './wavread.mjs';
import { renderNote } from './decay-report.mjs';
import { writeWav } from '../wav.mjs';

const FS = 48000, MIDI = 60, VEL = 0.7;
const s = readWav(`${process.env.SAMPLES ?? '/home/user/samples/salamander'}/C4v12.wav`);
const rms = (x, a, n) => { let v = 0; for (let i = a; i < a + n; i++) v += (x[i] ?? 0) ** 2; return Math.sqrt(v / n); };
const ref = rms(s.data, Math.round(0.3 * s.rate), 9600);

const takes = [
  ['real', null],
  ['strings struck together (the click)', { velocity: VEL, strikeOffsetScale: 0 }],
  ['strings struck 0.6 ms apart', { velocity: VEL }],
  ['same, softer blow', { velocity: 0.6 }],
];
const len = Math.round(5 * FS), gap = Math.round(0.6 * FS);
const out = new Float32Array(takes.length * (len + gap));
takes.forEach(([label, o], i) => {
  const x = o ? renderNote(6, MIDI, o) : s.data;
  const g = o ? ref / Math.max(rms(x, Math.round(0.3 * FS), 9600), 1e-12) : 1;
  for (let k = 0; k < len; k++) out[i * (len + gap) + k] = (x[k] ?? 0) * g;
  console.log(`  ${i + 1}. ${label}`);
});
writeWav('renders/c4-hammer-ab.wav', out, FS);
console.log('\nrenders/c4-hammer-ab.wav');
