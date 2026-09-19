// Solve the knock level per note, instead of guessing it.
//
//   node tools/fit/fit-knock.mjs [dB under the note]
//
// The first guess at this was ten times too loud, and hand-scaling it fixed
// C4 while leaving A0 forty decibels out -- because how loud a knock sounds
// against its note is not proportional to the blow. The string's own output in
// the first milliseconds is shaped by the transient stage, which in the bass
// takes almost all of it away, so the same knock stands right out at A0 and
// hides under C4. Nothing about the hammer predicts that; it has to be
// measured against the rendered note.
//
// So: bisect a per-note gain until the knock alone peaks a fixed number of
// decibels under the note's own peak. The knock is isolated exactly, by
// rendering the note twice and subtracting -- renders are bit-identical, so
// the difference is the knock and nothing else.
import { renderNote } from './decay-report.mjs';
import { DEFAULT_SCALE, buildScale } from '../../src/dsp/scale.js';

const lerpTable = (t, x) => {
  if (x <= t[0][0]) return t[0][1];
  for (let i = 0; i < t.length - 1; i++) {
    if (x >= t[i][0] && x <= t[i + 1][0]) {
      const u = (x - t[i][0]) / (t[i + 1][0] - t[i][0]);
      return t[i][1] + (t[i + 1][1] - t[i][1]) * u;
    }
  }
  return t[t.length - 1][1];
};

const FS = 48000;
const UNDER = Number(process.argv[2] ?? 12);         // dB below the note's peak
const ANCHORS = [21, 27, 33, 39, 45, 51, 57, 63, 69, 75, 81, 87, 93, 99, 105, 108];
const span = Math.round(0.1 * FS);
const peak = (x, n) => { let p = 0; for (let i = 0; i < n && i < x.length; i++) { const a = Math.abs(x[i]); if (a > p) p = a; } return p; };
const model = buildScale(DEFAULT_SCALE);

const want = Math.pow(10, -UNDER / 20);
const gains = [], noises = [];
console.log(`knock solved to ${UNDER} dB under the note's own peak\n`);
console.log('note    scale    gain     noise    check dB');
for (const midi of ANCHORS) {
  const dry = renderNote(0.3, midi, { velocity: 0.83, knockScale: 0 });
  const ref = peak(dry, span);
  const ratio = (k) => {
    const wet = renderNote(0.3, midi, { velocity: 0.83, knockScale: k });
    let p = 0;
    for (let i = 0; i < span && i < wet.length; i++) { const a = Math.abs(wet[i] - dry[i]); if (a > p) p = a; }
    return p / (ref + 1e-30);
  };
  // The knock is linear in the scale -- gain and noise both scale with it and
  // everything between it and the output is linear -- so one probe gives the
  // whole curve. Bisecting it was 22 renders a note for an answer that is a
  // division. (Verified against a direct render at the solved value below.)
  const k = want / Math.max(ratio(1), 1e-12);
  const g = lerpTable(DEFAULT_SCALE.voicing.knockGain, midi) * k;
  const nz = lerpTable(DEFAULT_SCALE.voicing.knockNoise, midi) * k;
  gains.push([midi, +g.toPrecision(3)]);
  noises.push([midi, +nz.toPrecision(3)]);
  const check = 20 * Math.log10(ratio(k) + 1e-30);
  console.log(`${model.notes[midi - 21].name.padEnd(5)} ${k.toFixed(3).padStart(8)} ${g.toPrecision(3).padStart(9)} ${nz.toPrecision(3).padStart(9)} ${check.toFixed(2).padStart(9)}`);
}
const fmt = (t) => JSON.stringify(t).replace(/\],\[/g, '], [');
console.log('\n    knockGain:  ' + fmt(gains) + ',');
console.log('    knockNoise: ' + fmt(noises) + ',');
