// Where is the hammer in each recording?
//
// The build trims each sample's head at a fixed level threshold (-55 dB under
// its own peak), which lines up the moment a recording stops being silence.
// That is NOT the same as lining up the moment it hits, and the difference is
// audible as inconsistent attack: on this library the gap between the head of
// the file and the top of the transient runs from about a millisecond to tens
// of them, key to key and layer to layer, because a soft blow on a long bass
// string rises far more slowly than a hard one on a short treble one.
//
// So: measure every shipped sample, record the time of its attack peak in the
// manifest (`t0`, milliseconds into the file), and let the engine line those
// up at playback time instead of re-cutting the files. Measuring rather than
// re-encoding means this is reversible, costs no quality, and can be re-run
// against a library that is already built and committed.
//
//   node sampled/tools/align.mjs            measure and write the manifest
//   node sampled/tools/align.mjs --dry      measure and report, write nothing
//
// The engine reads `t0` and `alignMs` (the target the keys are aligned to);
// with neither present it plays every sample from its own start, as before.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { cpus } from 'node:os';
import ffmpegPath from 'ffmpeg-static';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = join(REPO, 'sampled', 'samples');
const RATE = 48000;

const dry = process.argv.includes('--dry');

/** Decode one file to mono float32 at RATE, through ffmpeg. */
function decode(file) {
  return new Promise((res, rej) => {
    execFile(ffmpegPath,
      ['-v', 'error', '-i', join(DIR, file), '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-'],
      { encoding: 'buffer', maxBuffer: 1 << 28 },
      (err, stdout) => err ? rej(err) : res(new Float32Array(stdout.buffer, stdout.byteOffset, stdout.length >> 2)));
  });
}

// The attack peak, in ms.
//
// Taken off a short-window envelope rather than off the raw samples, because a
// single sample of the waveform is a phase accident: the loudest instantaneous
// value can sit a cycle either side of where the note is heard to land. A 2 ms
// window is long enough to be stable and short enough not to smear a transient.
//
// Searched over the first 300 ms only. A pianissimo bass note genuinely keeps
// rising for a tenth of a second as the partials come in, and its absolute
// maximum may be well past the attack; what is wanted here is the hammer.
const WIN = Math.round(0.002 * RATE);
const LOOK = Math.round(0.300 * RATE);

function attackPeak(x) {
  const n = Math.min(x.length, LOOK + WIN);
  let best = 0, at = 0, acc = 0;
  const env = new Float64Array(Math.max(0, n - WIN));
  for (let i = 0; i < n; i++) {
    acc += x[i] * x[i];
    if (i >= WIN) {
      acc -= x[i - WIN] * x[i - WIN];
      env[i - WIN] = acc;
      if (acc > best) { best = acc; at = i - (WIN >> 1); }
    }
  }
  // The ATTACK FRONT: the first moment the envelope climbs past a fixed level
  // under the peak of that same attack. This, not the peak, is what "when does
  // the note arrive" means -- a soft bass note goes on swelling for a tenth of
  // a second after it has plainly started, and lining its swell up with a
  // treble note's instant crack would mean cutting a fifth of a second off its
  // front. The front is measured at two depths because they answer different
  // questions: -20 dB is when it becomes audible, -6 dB is when it is properly
  // there.
  const cross = (db) => {
    const thr = best * Math.pow(10, db / 10);
    for (let i = 0; i < env.length; i++) if (env[i] >= thr) return (i + (WIN >> 1)) / RATE * 1000;
    return at / RATE * 1000;
  };
  return { peakMs: at / RATE * 1000, on20: cross(-20), on6: cross(-6) };
}

const m = JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8'));
const jobs = [];
for (const note of Object.values(m.notes)) {
  for (const [layer, e] of Object.entries(note.layers)) jobs.push({ note, layer: +layer, e });
}
console.log(`measuring ${jobs.length} samples with ${cpus().length} cores…`);

let done = 0;
const N = Math.max(1, Math.min(cpus().length, 8));
await Promise.all(Array.from({ length: N }, async (_, k) => {
  for (let i = k; i < jobs.length; i += N) {
    const j = jobs[i];
    const x = await decode(j.e.file);
    const r = attackPeak(x);
    j.peakMs = r.peakMs; j.on20 = r.on20; j.on6 = r.on6;
    if (++done % 200 === 0) process.stdout.write(`  ${done}/${jobs.length}\r`);
  }
}));

const stat = (f) => {
  const v = jobs.map(f).sort((a, b) => a - b);
  const pct = (p) => v[Math.min(v.length - 1, Math.round(p * (v.length - 1)))];
  return { min: v[0], p10: pct(0.1), med: pct(0.5), p90: pct(0.9), max: v[v.length - 1] };
};
const show = (name, st) => console.log(`    ${name.padEnd(22)}`,
  [st.min, st.p10, st.med, st.p90, st.max].map((v) => v.toFixed(1).padStart(6)).join(' '), 'ms');
console.log('\n  delay into the file        min    p10 median    p90    max');
show('attack front (-20 dB)', stat((j) => j.on20));
show('attack front (-6 dB)', stat((j) => j.on6));
show('peak of the attack', stat((j) => j.peakMs));
const median = stat((j) => j.on20).med;

// Per-octave, because the pattern people hear is "the bass feels late".
for (let oct = 0; oct < 9; oct++) {
  const v = jobs.filter((j) => Math.floor(j.note.midi / 12) - 1 === oct).map((j) => j.on20).sort((a, b) => a - b);
  if (!v.length) continue;
  console.log(`    octave ${oct}: n=${String(v.length).padStart(4)}  median ${v[v.length >> 1].toFixed(1)} ms`
    + `  range ${v[0].toFixed(1)}..${v[v.length - 1].toFixed(1)} ms`);
}

// The target every key is lined up to, and the quantity it is lined up ON:
// the -20 dB attack front. The MEDIAN, not the minimum: half the library is
// then nudged earlier and half later, so the alignment costs a few
// milliseconds of latency on the fastest samples instead of cutting the front
// off the slowest ones, and no key moves far.
const target = +median.toFixed(2);
for (const j of jobs) { j.e.t0 = +j.on20.toFixed(2); j.e.tp = +j.peakMs.toFixed(2); }
m.alignMs = target;

const shifts = jobs.map((j) => j.e.t0 - target);
const late = shifts.filter((v) => v > 0), early = shifts.filter((v) => v < 0);
console.log(`
  aligning to ${target.toFixed(1)} ms
    ${late.length} samples trimmed, worst ${Math.max(...late).toFixed(1)} ms
    ${early.length} samples delayed, worst ${(-Math.min(...early)).toFixed(1)} ms`);

if (dry) console.log('\n  --dry: manifest not written');
else {
  writeFileSync(join(DIR, 'manifest.json'), JSON.stringify(m));
  console.log(`\n  wrote ${join('sampled', 'samples', 'manifest.json')}`);
}
