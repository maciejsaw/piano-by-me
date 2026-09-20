// The last EQ: match our spectrum to the samples' across the whole keyboard.
//
//   node tools/fit/final-eq.mjs [--write] [--secs 1.0]
//
// Everything before this fits one mechanism at a time -- a decay, a contact
// time, a knock -- against one note or a handful. This asks a different and
// blunter question: play all thirty sampled notes, listen a second after the
// blow when the attack is long gone and only the instrument's own colour is
// left, and ask how the two differ overall.
//
// A second in is deliberate. At the strike the spectrum is dominated by the
// hammer and by whatever the transient stage is doing, both of which have been
// fitted separately and neither of which is what "the piano sounds dark"
// means. A second later what is left is the string losses and the body, and
// the body is the one thing here that can be corrected with a filter without
// lying about the physics.
//
// Each note is measured on its own and the notes are averaged IN DECIBELS
// rather than summed as audio. Summing would let the loudest few notes write
// the whole curve -- the bass is 20 dB louder a second in than the top two
// octaves -- and the top of the keyboard would then be fitted by the bottom.
// Averaging per note gives every key one vote. Bands where a note has nothing
// to say are skipped rather than averaged in as silence.
import { writeFileSync } from 'node:fs';
import { indexLibrary, loadNote } from './samples.mjs';
import { renderNote } from './decay-report.mjs';
import { fft } from './comb.mjs';
import { noteHz } from '../../src/dsp/physics.js';
import { FINAL_EQ, curveAt } from '../../src/dsp/body.js';

const FS = 48000;
const DIR = process.env.SAMPLES ?? '/home/user/samples/salamander';
const AT = Number((process.argv.find((a) => a.startsWith('--secs=')) ?? '--secs=1.0').split('=')[1]);
const WRITE = process.argv.includes('--write');
const N = 16384;                       // ~0.34 s at 48k: enough to resolve A0
const LIMIT_DB = 12;                   // how far the correction may reach
const FLOOR_DB = 60;
const MIN_NOTES = 8;                   // a band needs this many notes to count                   // how far under a note's own peak still counts

/** Average power spectrum of one note over a window starting `at` seconds in. */
function spectrum(x, fs, at, frames = 4) {
  const start = Math.round(at * fs);
  const hop = Math.round(N / 2);
  const mag = new Float64Array(N / 2);
  let used = 0;
  for (let f = 0; f < frames; f++) {
    const o = start + f * hop;
    if (o + N > x.length) break;
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = x[o + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
    fft(re, im);
    for (let k = 0; k < N / 2; k++) mag[k] += re[k] * re[k] + im[k] * im[k];
    used++;
  }
  if (!used) return null;
  for (let k = 0; k < N / 2; k++) mag[k] /= used;
  return mag;
}

/** Third-octave centres from 40 Hz up. */
const CENTRES = [];
for (let fc = 40; fc < 16000; fc *= Math.pow(2, 1 / 3)) CENTRES.push(fc);

function bands(mag, fs) {
  const binHz = fs / N;
  return CENTRES.map((fc) => {
    const lo = fc / Math.pow(2, 1 / 6), hi = fc * Math.pow(2, 1 / 6);
    let s = 0, n = 0;
    for (let k = Math.max(1, Math.floor(lo / binHz)); k <= Math.min(mag.length - 1, Math.ceil(hi / binHz)); k++) { s += mag[k]; n++; }
    return n ? 10 * Math.log10(s / n + 1e-30) : -300;
  });
}

const lib = indexLibrary(DIR).filter((e) => e.layer === 12);
console.log(`${lib.length} notes, measured ${AT.toFixed(2)} s after the strike\n`);

const sum = new Float64Array(CENTRES.length);
const count = new Float64Array(CENTRES.length);
console.log('note   bands used   mean error (dB)');
for (const entry of lib) {
  const s = loadNote(entry.path);
  const real = spectrum(s.data, s.rate, AT);
  const ours = spectrum(renderNote(AT + 2, entry.midi, { velocity: 0.83 }), FS, AT);
  if (!real || !ours) { console.log(`${entry.note.padEnd(5)}  too short`); continue; }
  const rb = bands(real, s.rate), ob = bands(ours, FS);
  // Level is not what is being fitted: align each note on its own mean before
  // comparing shapes, or a note that is simply louder tilts the whole curve.
  const f0 = noteHz(entry.midi);
  const peakR = Math.max(...rb), peakO = Math.max(...ob);
  let n = 0, err = 0;
  const diff = [];
  for (let i = 0; i < CENTRES.length; i++) {
    // Below the fundamental there is nothing to match, and either signal may
    // have run into its own floor higher up.
    const live = CENTRES[i] > f0 * 0.9 && rb[i] > peakR - FLOOR_DB && ob[i] > peakO - FLOOR_DB;
    diff.push(live ? rb[i] - ob[i] : null);
    if (live) { n++; }
  }
  const mean = diff.reduce((a, v) => a + (v ?? 0), 0) / Math.max(n, 1);
  for (let i = 0; i < CENTRES.length; i++) {
    if (diff[i] == null) continue;
    const d = diff[i] - mean;               // shape only, level removed
    sum[i] += d; count[i]++; err += Math.abs(d);
  }
  console.log(`${entry.note.padEnd(5)} ${String(n).padStart(9)}   ${(err / Math.max(n, 1)).toFixed(2).padStart(8)}`);
}

const curve = [];
console.log('\n   Hz     notes    correction');
for (let i = 0; i < CENTRES.length; i++) {
  // A band that only two or three notes reach is not a measurement of the
  // instrument, it is a measurement of those notes -- and the count MOVES as
  // the correction changes, because lifting a band brings more notes above
  // the floor there. Requiring a real quorum is what keeps a second pass from
  // chasing its own first pass into the top octaves.
  if (count[i] < MIN_NOTES) continue;
  const db = Math.max(-LIMIT_DB, Math.min(LIMIT_DB, sum[i] / count[i]));
  curve.push([Math.round(CENTRES[i]), +db.toFixed(2)]);
  console.log(`${String(Math.round(CENTRES[i])).padStart(6)} ${String(count[i]).padStart(7)}   ${db.toFixed(2).padStart(7)} dB`);
}

// The measurement is made with whatever correction is already in force, so
// what comes out is the RESIDUAL, not the curve. Composing rather than
// replacing is what makes a second pass mean anything -- and it converges:
// the first pass left +-8 to 12 dB, the second +-2 over most of the range.
const composed = curve.map(([f, db]) => [f, +Math.max(-LIMIT_DB, Math.min(LIMIT_DB, curveAt(FINAL_EQ, f) + db)).toFixed(2)]);

if (WRITE) {
  writeFileSync('fitted/final-eq.json', JSON.stringify({
    measuredAtS: AT, notes: lib.length, limitDb: LIMIT_DB, residual: curve, curve: composed,
  }, null, 2));
  console.log('\ncomposed with the correction already in force:');
  console.log('export const FINAL_EQ = ' + JSON.stringify(composed).replace(/\],\[/g, '], [') + ';');
  console.log('\nwrote fitted/final-eq.json');
} else {
  console.log('\n(dry run -- pass --write to save it)');
}
