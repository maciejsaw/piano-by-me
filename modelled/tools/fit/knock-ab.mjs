// How loud the hammer's knock on the soundboard should be.
//
//   node tools/fit/knock-ab.mjs [note] [midi]
//
// A hammer arrives with momentum and the string is a light thing tied at both
// ends to a heavy one. Most of that momentum goes straight through to the
// bridge and shakes the board, which you hear as a low noisy knock under the
// partials -- somebody tapping the soundboard, because that is what it is.
// Until now a strike here could only ever be heard as tone.
//
// knockScale walks the whole per-note curve at once: it is loudest in the bass
// where the hammer is heaviest and nearly gone at the top, so one number moves
// all of it without flattening the shape.
//
// The click number from onsetShape is NOT used here, and that is deliberate:
// it anchors on a detected onset, and a knock is a broadband burst out of
// digital silence, so it moves the anchor and then reads 0 dB at settings that
// measure -22 dB from a fixed zero. Our renders start at the strike, so the
// window needs no detecting. The columns below are measured from sample 0:
//
//   early   loudest sample in the first 3 ms against the first 100 ms
//   knock   the knock ALONE against the note alone, which is exact -- renders
//           are bit-identical, so rendering twice and subtracting isolates it
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

const STEPS = (process.env.STEPS ?? '0,0.5,1,2,4').split(',').map(Number);
const len = Math.round(3.5 * FS), gap = Math.round(0.45 * FS);
const out = new Float32Array((STEPS.length + 1) * (len + gap));
for (let k = 0; k < len; k++) out[k] = s.data[k] ?? 0;
const FS3 = Math.round(0.003 * FS), FS100 = Math.round(0.1 * FS);
const pk = (x, from, to) => { let p = 0; for (let i = from; i < to && i < x.length; i++) { const a = Math.abs(x[i]); if (a > p) p = a; } return p; };
const dry = renderNote(4.5, MIDI, { velocity: 0.83, knockScale: 0 });
const dryPk = pk(dry, 0, FS100);

const r = onsetShape(s.data, s.rate);
// The sample needs its onset detected -- it carries several milliseconds of
// action noise before contact -- so its early figure is measured from there.
const rs = r.start;
const realEarly = 20 * Math.log10(pk(s.data, rs, rs + FS3) / (pk(s.data, rs, rs + FS100) + 1e-30) + 1e-12);
console.log(`  1. real ${NAME.padEnd(18)} half ${String(r.halfMs).padStart(3)} ms  peak ${String(r.peakMs).padStart(3)} ms  early ${realEarly.toFixed(1).padStart(6)} dB`);
STEPS.forEach((v, i) => {
  const x = renderNote(4.5, MIDI, { velocity: 0.83, knockScale: v });
  const g = ref / Math.max(rms(x, Math.round(0.3 * FS), 9600), 1e-12);
  const at = (i + 1) * (len + gap);
  for (let k = 0; k < len; k++) out[at + k] = (x[k] ?? 0) * g;
  const q = onsetShape(x, FS);
  let kp = 0;
  for (let k = 0; k < FS100; k++) { const d = Math.abs(x[k] - dry[k]); if (d > kp) kp = d; }
  const early = 20 * Math.log10(pk(x, 0, FS3) / (pk(x, 0, FS100) + 1e-30) + 1e-12);
  const knock = 20 * Math.log10(kp / (dryPk + 1e-30) + 1e-12);
  console.log(`  ${i + 2}. knock x${v.toFixed(2).padEnd(13)} half ${String(q.halfMs).padStart(3)} ms  peak ${String(q.peakMs).padStart(3)} ms` +
    `  early ${early.toFixed(1).padStart(6)} dB  knock ${(v > 0 ? knock.toFixed(1) : '  -inf').padStart(6)} dB`);
});
writeWav(`renders/knock-${NAME.toLowerCase()}.wav`, out, FS);
console.log(`\nrenders/knock-${NAME.toLowerCase()}.wav`);
