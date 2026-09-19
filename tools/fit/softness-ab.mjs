// A ladder of increasingly soft strikes, for picking by ear.
//
//   node tools/fit/softness-ab.mjs [note] [midi]
//
// One knob, `s`, from 0 to 1, moving everything that makes a blow gentler at
// once, because they are not independent to the ear:
//
//   arrival spread   how far apart the felt reaches the three strings
//   board ring-up    how much of the output goes through the soundboard's
//                    diffusion, which is what turns an instant arrival into
//                    one that blooms
//   velocity         how hard the blow is in the first place
//   transient damp   how fast the top of the note is taken off after the
//                    strike. This is the big one, and it was not obvious: the
//                    click is not the strike being loud, it is the strike
//                    being BRIGHT with nothing behind it. A real C4 is 3.5 dB
//                    brighter above 3 kHz at the strike than at 0.3 s; ours
//                    was 28 dB brighter, because the damping added to bend
//                    the partial decays also strips the note bare right after
//                    the attack and leaves the transient standing alone.
//
// Felt stiffness is deliberately NOT on the knob. Softening it sounds like it
// belongs here and measures the opposite: past about a third of its nominal
// value the contact outlasts half the string's period, the hammer is still on
// the string when its own reflection comes back, and the re-strike puts the
// spikes back. Crest went 7.9 -> 8.7 -> 10.3 dB as the felt got softer. It is
// held at the value that puts contact near the 2 ms measured on real C4s.
//
// Each take is level-matched at 0.3 s, so what changes between them is the
// character of the strike and not the volume.
import { readWav } from './wavread.mjs';
import { renderNote } from './decay-report.mjs';
import { onsetShape } from './onset.mjs';
import { writeWav } from '../wav.mjs';
import { onsetIndex } from './onset.mjs';
import { fft } from './comb.mjs';

/** How much brighter above 3 kHz the strike is than the note at 0.3 s. */
function burst(x, fs) {
  const st = onsetIndex(x, fs), N = 1024;
  const at = (o) => {
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) { const v = x[o + i] ?? 0; re[i] = v * 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1))); }
    fft(re, im);
    let hi = 0, lo = 0;
    for (let k = 1; k < N / 2; k++) { const p = re[k] * re[k] + im[k] * im[k]; if ((k * fs) / N > 3000) hi += p; else lo += p; }
    return 10 * Math.log10(hi / (lo + 1e-30));
  };
  return at(st) - at(st + Math.round(0.3 * fs));
}

const FS = 48000;
const NAME = process.argv[2] ?? 'C4';
const MIDI = Number(process.argv[3] ?? 60);
const s = readWav(`${process.env.SAMPLES ?? '/home/user/samples/salamander'}/${NAME}v12.wav`);

const lerp = (a, b, t) => a + (b - a) * t;
export const softness = (s) => ({
  velocity: lerp(0.7, 0.42, s),
  strikeOffsetScale: lerp(1, 3.2, s),
  feltKScale: 0.6,
  transientDepth: lerp(0.14, 0, s),
  body: { boardMix: lerp(0.4, 1.0, s), boardSpreadMs: lerp(24, 52, s), boardG: lerp(0.62, 0.72, s) },
});

const rms = (x, a, n) => { let v = 0; for (let i = a; i < a + n; i++) v += (x[i] ?? 0) ** 2; return Math.sqrt(v / n); };
const ref = rms(s.data, Math.round(0.3 * s.rate), 9600);
const STEPS = [0, 0.2, 0.4, 0.6, 0.8, 1.0];
const len = Math.round(4 * FS), gap = Math.round(0.6 * FS);
const out = new Float32Array((STEPS.length + 1) * (len + gap));

for (let i = 0; i < len; i++) out[i] = s.data[i] ?? 0;
console.log(`  1. real ${NAME}`);
const realShape = onsetShape(s.data, s.rate);
console.log(`     half ${realShape.halfMs} ms  peak ${realShape.peakMs} ms  hf burst ${burst(s.data, s.rate).toFixed(1)} dB\n`);

STEPS.forEach((sv, i) => {
  const o = softness(sv);
  const x = renderNote(5, MIDI, o);
  const g = ref / Math.max(rms(x, Math.round(0.3 * FS), 9600), 1e-12);
  const at = (i + 1) * (len + gap);
  for (let k = 0; k < len; k++) out[at + k] = (x[k] ?? 0) * g;
  const sh = onsetShape(x, FS);
  console.log(`  ${i + 2}. softness ${sv.toFixed(1)}  vel ${o.velocity.toFixed(2)}  offsets x${o.strikeOffsetScale.toFixed(1)}  board ${o.body.boardMix.toFixed(2)} / ${o.body.boardSpreadMs.toFixed(0)} ms`);
  console.log(`     half ${sh.halfMs} ms  peak ${sh.peakMs} ms  hf burst ${burst(x, FS).toFixed(1)} dB`);
});

writeWav(`renders/${NAME.toLowerCase()}-softness.wav`, out, FS);
console.log(`\nrenders/${NAME.toLowerCase()}-softness.wav`);
