// Do the upper partials arrive with the fundamental, or build in behind it?
//
//   node tools/fit/arrival-order.mjs
//
// The idea worth testing: a hammer hits the string and you hear the
// fundamental first, with the inharmonic upper partials filling in later as
// other things start to move -- things the hammer never touched.
//
// Measuring it per partial does not work in the bass, and the reason is worth
// recording. Telling A0's partials apart needs a window of at least 1/27.5 s,
// about 145 ms, which is longer than the effect being timed. Any per-partial
// rise time down there is an artefact of the window. So this works in bands
// several partials wide, which needs only coarse frequency resolution and
// leaves the time resolution fine -- a 21 ms window on a 10 ms grid.
//
// The test: when does each band first come within 4 dB of its own best? A
// band that decays from the strike answers zero, by construction. A band that
// builds in answers with how long it took.
import { readWav } from './wavread.mjs';
import { onsetIndex } from './onset.mjs';
import { renderNote } from './decay-report.mjs';
import { fft } from './comb.mjs';
import { noteHz } from '../../src/dsp/physics.js';

const FS = 48000, N = 1024;
const BANDS = [[0.7, 3], [3, 8], [8, 20], [20, 60]];
const TIMES = [];
for (let t = 0; t <= 400; t += 10) TIMES.push(t);

function bandEnergy(x, fs, f0) {
  const st = onsetIndex(x, fs);
  return TIMES.map((ms) => {
    const at = st + Math.round((ms / 1000) * fs);
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const v = x[at + i] ?? 0;
      re[i] = v * 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
    }
    fft(re, im);
    return BANDS.map(([a, b]) => {
      let s = 0;
      for (let k = 1; k < N / 2; k++) {
        const f = (k * fs) / N;
        if (f >= a * f0 && f < b * f0) s += re[k] * re[k] + im[k] * im[k];
      }
      return 10 * Math.log10(s + 1e-30);
    });
  });
}

const rises = (curve) => BANDS.map((_, b) => {
  const col = curve.map((r) => r[b]);
  const pk = Math.max(...col);
  for (let i = 0; i < col.length; i++) if (col[i] >= pk - 4) return TIMES[i];
  return TIMES[TIMES.length - 1];
});

const NOTES = (process.env.NOTES ?? 'A0:21,C1:24,D#1:27,F#1:30,A1:33,C2:36')
  .split(',').map((s) => { const [n, m] = s.split(':'); return [n, Number(m)]; });
const R = BANDS.map(() => []), O = BANDS.map(() => []);
for (const [name, midi] of NOTES) {
  const s = readWav(`${process.env.SAMPLES ?? '/home/user/samples/salamander'}/${name}v12.wav`);
  const f0 = noteHz(midi);
  rises(bandEnergy(s.data, s.rate, f0)).forEach((v, i) => R[i].push(v));
  rises(bandEnergy(renderNote(1.5, midi, { velocity: 0.83 }), FS, f0)).forEach((v, i) => O[i].push(v));
}
const med = (a) => { const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
console.log(`median ms until the band is within 4 dB of its own peak (${NOTES.length} notes)`);
console.log('  band (x f0)      real     ours');
BANDS.forEach(([a, b], i) =>
  console.log(`  ${String(`${a}-${b}`).padStart(10)} ${String(med(R[i])).padStart(9)} ${String(med(O[i])).padStart(8)}`));
