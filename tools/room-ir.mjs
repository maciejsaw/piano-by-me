// Write the room's stereo impulse response, and say what it is made of.
//
//   node tools/room-ir.mjs [out.wav] [seconds]
//
// The room is synthesised rather than convolved, so it HAS an impulse
// response rather than being one -- this writes it out, which is the honest
// way to check that the two halves are doing their jobs: the early part
// should be a countable set of arrivals, the tail should not be countable at
// all, and the join between them should not be visible as a gap or a lump.
import { Room } from '../src/dsp/room.js';
import { writeWav } from './wav.mjs';

const FS = 48000;
const OUT = process.argv[2] ?? 'renders/room-ir.wav';
const SECS = Number(process.argv[3] ?? 3);
const n = Math.round(SECS * FS);

const room = new Room(FS, { mix: 1 });     // the response itself, not a blend
const L = new Float64Array(n), R = new Float64Array(n);
for (let i = 0; i < n; i++) {
  const lr = room.process(i === 0 ? 1 : 0);
  L[i] = lr[0]; R[i] = lr[1];
}

// Interleave for a stereo file.
const inter = new Float32Array(n * 2);
let peak = 0;
for (let i = 0; i < n; i++) { peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i])); }
for (let i = 0; i < n; i++) { inter[2 * i] = L[i] / peak; inter[2 * i + 1] = R[i] / peak; }
writeWav(OUT, inter, FS, 2);

const taps = room.taps.filter((t) => t.side === 0).sort((a, b) => a.n - b.n);
console.log(`room ${room.room.width} x ${room.room.depth} x ${room.room.height} m, RT60 ${room.rt60} s`);
console.log(`${taps.length} early reflections per ear, first at ${(taps[0].n / FS * 1000).toFixed(1)} ms,` +
  ` last at ${(taps[taps.length - 1].n / FS * 1000).toFixed(1)} ms`);

// Energy decay, which is where an RT60 either is or is not what was asked for.
const win = Math.round(0.05 * FS);
let prev = null;
console.log('\n   ms     level');
for (let t = 0; t + win < n; t += Math.round(0.25 * FS)) {
  let e = 0;
  for (let i = t; i < t + win; i++) e += L[i] * L[i] + R[i] * R[i];
  const db = 10 * Math.log10(e / win + 1e-30);
  if (prev === null) prev = db;
  console.log(`${String(Math.round((t / FS) * 1000)).padStart(5)} ${db.toFixed(1).padStart(9)} dB`);
}
console.log(`\n${OUT}`);
