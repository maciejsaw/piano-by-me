import { readWav } from './wavread.mjs';
import { stageProfile, printProfile, BANDS, GROUPS } from './stages.mjs';
import { renderNote } from './decay-report.mjs';

const SAMPLE = process.env.SAMPLE ?? '/home/user/samples/salamander/C3v12.wav';
const MIDI = Number(process.env.MIDI ?? 48), F0 = 440 * Math.pow(2, (MIDI - 69) / 12);
const s = readWav(SAMPLE);
const real = stageProfile(s.data, s.rate, F0);
const ours = stageProfile(renderNote(8, MIDI), 48000, F0);
printProfile('REAL ', real);
printProfile('MODEL', ours);
console.log('\nMODEL - REAL  (positive = our partial holds on longer)');
console.log('  partials   ' + BANDS.map(([a, b]) => `${a}-${b}s`.padStart(8)).join(''));
GROUPS.forEach(([lo, hi], i) => console.log(`  ${String(lo + '-' + hi).padStart(8)}   ` +
  ours.rows[i].map((v, j) => (v - real.rows[i][j]).toFixed(1).padStart(8)).join('')));
