// The attack, sample against model. NOTE=C4 MIDI=60 node tools/fit/attack-report.mjs
import { readWav } from './wavread.mjs';
import { attackTracks, printAttack, ladderError } from './attack.mjs';
import { renderNote } from './decay-report.mjs';
import { noteHz } from '../../src/dsp/physics.js';

const NAME = process.env.NOTE ?? 'C4';
const MIDI = Number(process.env.MIDI ?? 60);
const f0 = noteHz(MIDI);
const s = readWav(`${process.env.SAMPLES ?? '/home/user/samples/salamander'}/${NAME}v12.wav`);
const real = attackTracks(s.data, s.rate, f0);
const ours = attackTracks(renderNote(2, MIDI), 48000, f0);
printAttack(`REAL  ${NAME}`, real);
printAttack(`MODEL ${NAME}`, ours);
console.log('\n  model - real (positive = we put too much there)');
console.log('    n     rel dB   rise ms');
for (let i = 0; i < Math.min(real.tracks.length, ours.tracks.length, 16); i++) {
  const a = ours.tracks[i], b = real.tracks[i];
  console.log(`   ${String(a.n).padStart(2)} ${(a.rel - b.rel).toFixed(1).padStart(9)} ${(a.riseMs - b.riseMs).toFixed(0).padStart(9)}`);
}
console.log(`\n  ladder error ${ladderError(ours, real).toFixed(2)} dB`);
