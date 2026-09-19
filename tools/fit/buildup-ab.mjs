// Let the string's vibration BUILD rather than arrive.
//
//   node tools/fit/buildup-ab.mjs [note] [midi]
//
// The suggestion was to model force transferring gradually from hammer to a
// stiff string, so the string does not ring fully at once. The machinery for
// that is already here -- the transient damping stage is a high-frequency loss
// that fades away after the strike, which is exactly a high end that fades IN.
// It was simply pointed the other way: `rise` was set to 40 ms so the damping
// arrives AFTER the strike, deliberately sparing it, which was right for C4
// and is precisely what lets the bass zing through.
//
// Turned around -- full damping at the moment of contact, releasing over the
// following tens of milliseconds -- the high partials are not there at the
// strike and grow in as the loss lets go. This varies how long that takes.
//
// The release is a smootherstep rather than an exponential. An exponential is
// a straight line in dB and sounds like one; easing in holds the damping
// through the strike and cuts more of the zing, and easing out means the
// build can be longer without the note seeming to fade up.
import { readWav } from './wavread.mjs';
import { renderNote } from './decay-report.mjs';
import { writeWav } from '../wav.mjs';

const FS = 48000;
const NAME = process.argv[2] ?? 'A0';
const MIDI = Number(process.argv[3] ?? 21);
const s = readWav(`${process.env.SAMPLES ?? '/home/user/samples/salamander'}/${NAME}v12.wav`);
const rms = (x, a, n) => { let v = 0; for (let i = a; i < a + n; i++) v += (x[i] ?? 0) ** 2; return Math.sqrt(v / n); };
const ref = rms(s.data, Math.round(0.3 * s.rate), 9600);

// depth, fall time. rise is ~0 throughout: the damping is there at contact.
// SKEWS pushes the release toward the end of the build: 1 is a symmetric S,
// higher holds the damping near full for most of it and then opens quickly.
const LEN = Number(process.env.LEN ?? 0.2);
const SKEWS = (process.env.SKEWS ?? '1,3,6,10').split(',').map(Number);
const TAKES = SKEWS.map((k) => [
  `build ${Math.round(LEN * 1000)} ms, skew ${k}`,
  { transientRiseS: 0.0005, transientDepth: 0.7, transientTauS: LEN, transientSkew: k },
]);

const len = Math.round(3.5 * FS), gap = Math.round(0.45 * FS);
const out = new Float32Array((TAKES.length + 1) * (len + gap));
for (let k = 0; k < len; k++) out[k] = s.data[k] ?? 0;
console.log(`  1. real ${NAME}`);
TAKES.forEach(([label, o], i) => {
  const x = renderNote(4.5, MIDI, { velocity: 0.83, ...o });
  const g = ref / Math.max(rms(x, Math.round(0.3 * FS), 9600), 1e-12);
  const at = (i + 1) * (len + gap);
  for (let k = 0; k < len; k++) out[at + k] = (x[k] ?? 0) * g;
  console.log(`  ${i + 2}. ${label}`);
});
writeWav(`renders/buildup-${NAME.toLowerCase()}.wav`, out, FS);
console.log(`\nrenders/buildup-${NAME.toLowerCase()}.wav`);
