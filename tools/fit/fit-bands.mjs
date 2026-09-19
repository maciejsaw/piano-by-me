// Measure the measurement: derive per-key brightness bands from the samples
// and write them out, so every later comparison uses bands that actually
// contain the note. `node tools/fit/fit-bands.mjs [outJson]`
import { writeFileSync } from 'node:fs';
import { readWav } from './wavread.mjs';
import { fitBands } from './bands.mjs';
import { indexLibrary } from './samples.mjs';
import { noteHz } from '../../src/dsp/physics.js';

const DIR = process.env.SAMPLES ?? '/home/user/samples/salamander';
const OUT = process.argv[2] || 'fitted/measure-bands.json';

const notes = indexLibrary(DIR).filter((n) => n.layer === 12).sort((a, b) => a.midi - b.midi);
const out = [];
console.log('note  midi     f0    fTop  fTop/f0   low band      high band     usable');
for (const n of notes) {
  const s = readWav(n.path);
  const f0 = noteHz(n.midi);
  const b = fitBands(s.data, s.rate, f0);
  out.push({
    midi: n.midi, note: n.note, f0: +f0.toFixed(2), fTop: Math.round(b.fTop),
    partialsUsable: +(b.fTop / f0).toFixed(1),
    lo: b.lo.map((v) => +v.toFixed(1)), hi: b.hi.map((v) => +v.toFixed(1)), usable: b.usable,
  });
  console.log(
    `${n.note.padEnd(5)} ${String(n.midi).padStart(3)} ${f0.toFixed(1).padStart(7)} ${String(Math.round(b.fTop)).padStart(7)}` +
    ` ${(b.fTop / f0).toFixed(1).padStart(8)}   ${b.lo.map((v) => Math.round(v)).join('-').padEnd(12)}  ${b.hi.map((v) => Math.round(v)).join('-').padEnd(13)} ${b.usable ? 'yes' : 'NO'}`,
  );
}
writeFileSync(OUT, JSON.stringify({ notes: out }, null, 2));
console.log(`\nwrote ${OUT}`);
