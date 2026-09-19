// The first 20 ms, sample against model. NOTE=C4 MIDI=60 node tools/fit/onset-report.mjs
import { readWav } from './wavread.mjs';
import { onsetShape } from './onset.mjs';
import { renderNote } from './decay-report.mjs';
const NAME = process.env.NOTE ?? 'C4', MIDI = Number(process.env.MIDI ?? 60);
const VEL = Number(process.env.VEL ?? 0.9);
const s = readWav(`${process.env.SAMPLES ?? '/home/user/samples/salamander'}/${NAME}v12.wav`);
const real = onsetShape(s.data, s.rate);
const ours = onsetShape(renderNote(1, MIDI, { velocity: VEL }), 48000);
console.log(`${NAME}  envelope, dB relative to each one's own early peak\n`);
console.log('  ms ' + real.tMs.slice(0, 21).map((t) => String(t).padStart(6)).join(''));
console.log('real ' + real.db.slice(0, 21).map((v) => v.toFixed(0).padStart(6)).join(''));
console.log('ours ' + ours.db.slice(0, 21).map((v) => v.toFixed(0).padStart(6)).join(''));
console.log(`\n            half-peak   peak at   crest (first 5 ms)`);
console.log(`real   ${real.halfMs.toFixed(0).padStart(10)} ms ${real.peakMs.toFixed(0).padStart(8)} ms ${real.crestDb.toFixed(1).padStart(10)} dB`);
console.log(`ours   ${ours.halfMs.toFixed(0).padStart(10)} ms ${ours.peakMs.toFixed(0).padStart(8)} ms ${ours.crestDb.toFixed(1).padStart(10)} dB`);
