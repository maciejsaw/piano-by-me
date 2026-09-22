import { Piano } from '../src/dsp/piano.js';
const FS = 48000;
const run = (label, setup, quality) => {
  const p = new Piano(FS, { quality });
  setup(p);
  const buf = new Float32Array(128);
  for (let i = 0; i < 200; i++) p.render(buf, 128);          // warm up
  const blocks = 1200;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < blocks; i++) p.render(buf, 128);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const audioMs = (blocks * 128 * 1000) / FS;
  console.log(`${label.padEnd(38)} q=${String(quality).padStart(2)}  strings=${String(p.active.length).padStart(3)}  ${(ms / audioMs * 100).toFixed(1)}% of one core`);
};
console.log(`\nAudioWorklet budget: 100% = real time on a single core.\n`);
for (const q of [16, 32, 48]) {
  run('1 note held', (p) => p.noteOn(60, 0.8), q);
  run('10-note chord held', (p) => { for (let i = 0; i < 10; i++) p.noteOn(48 + i * 2, 0.8); }, q);
  run('10 notes + sustain pedal (all 240)', (p) => { p.setSustain(true); for (let i = 0; i < 10; i++) p.noteOn(48 + i * 2, 0.8); }, q);
  console.log('');
}
