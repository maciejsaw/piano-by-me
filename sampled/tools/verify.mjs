// Check the built library -- by DECODING it, not by reading the manifest.
//
//   node sampled/tools/verify.mjs [--dir DIR] [--full]
//
// The manifest records what the builder believed. This decodes the Opus files
// the browser will actually be handed and measures them, so anything the codec
// did on the way -- overshoot past full scale, a pre-skip that put the silence
// back -- shows up here rather than under someone's fingers.
//
// What it deliberately does NOT do is re-measure pitch or inharmonicity from
// the decoded audio. There is no physics here to check: the recording already
// contains it, and a sampled instrument cannot get a partial wrong. The
// properties worth checking are the ones a BUILD can get wrong -- a missing
// file, a level that clips, silence left at the front, a level that jumps
// between neighbouring keys, a tuning table with a step in it -- and those are
// all either bytes or arithmetic.
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { findFfmpeg } from './lib/encode.mjs';
import { noteName } from './lib/plan.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const dir = argv.includes('--dir') ? argv[argv.indexOf('--dir') + 1] : join(REPO, 'sampled', 'samples');
const full = argv.includes('--full');
const ffmpeg = await findFfmpeg();

const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
const keys = Object.keys(m.notes).map(Number).sort((a, b) => a - b);
const fail = [];
const note = (ok, msg) => { if (!ok) fail.push(msg); return ok; };

/** Decode to mono float, through the same codec path the browser will use. */
function decode(file) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', join(dir, file),
    '-f', 'f32le', '-ac', '1', '-ar', '48000', 'pipe:1'], { maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`decode failed: ${file}`);
  return new Float32Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.length >> 2);
}

// ---- 1. completeness, from the manifest ----------------------------------
let files = 0, missing = 0, bytes = 0;
for (const k of keys) {
  const n = m.notes[k];
  for (const l of m.layers) {
    const e = n.layers[l];
    if (!e) { missing++; continue; }
    files++;
    if (!existsSync(join(dir, e.file))) { missing++; continue; }
    bytes += statSync(join(dir, e.file)).size;
  }
}
for (const f of readdirSync(dir)) if (f !== 'manifest.json') bytes = bytes;
note(keys.length === m.keys.hi - m.keys.lo + 1, `only ${keys.length} keys`);
note(missing === 0, `${missing} missing layer files`);

// ---- 2. level ordering across the velocity layers -------------------------
let worstInv = 0, worstInvAt = '';
for (const k of keys) {
  const g = m.layers.map((l) => m.notes[k].layers[l]?.gain).filter(Boolean);
  for (let i = 1; i < g.length; i++) {
    const d = 20 * Math.log10(g[i - 1] / g[i]);
    if (d > worstInv) { worstInv = d; worstInvAt = `${noteName(k)} v${m.layers[i]}`; }
  }
}

// ---- 3. no seam where one recording hands over to the next ---------------
// Neighbouring keys should not jump in level. A root and the key above it come
// from the same recording, so a jump there would mean the repitch changed the
// level -- which it must not.
let worstSeam = 0, seamAt = '';
const top = m.layers[m.layers.length - 1];
for (let i = 1; i < keys.length; i++) {
  const a = m.notes[keys[i - 1]].layers[top], b = m.notes[keys[i]].layers[top];
  if (!a || !b) continue;
  const d = Math.abs(20 * Math.log10(a.gain / b.gain));
  if (d > worstSeam) { worstSeam = d; seamAt = `${noteName(keys[i - 1])}->${noteName(keys[i])}`; }
}

// ---- 4. decode and measure -----------------------------------------------
const sample = [];
for (const k of keys) {
  const ls = full ? m.layers : [1, 8, m.layers[m.layers.length - 1]].filter((l) => m.notes[k].layers[l]);
  for (const l of ls) sample.push([k, l]);
}
let worstPeak = 0, peakAt = '', worstOnset = 0, onsetAt = '';
let checked = 0;
process.stdout.write(`  decoding ${sample.length} files`);
for (const [k, l] of sample) {
  const e = m.notes[k].layers[l];
  const x = decode(e.file);
  checked++;
  if (checked % 40 === 0) process.stdout.write('.');

  let peak = 0;
  for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > peak) peak = a; }
  if (peak > worstPeak) { worstPeak = peak; peakAt = `${noteName(k)} v${l}`; }

  // Silence at the front: where does it first cross -60 dB of its own peak?
  // Not -40: a bass note's peak arrives tens of milliseconds after the strike,
  // as the fundamental builds, so a -40 dB test measures the attack and calls
  // it silence.
  const thr = peak * 0.001;
  let i = 0;
  while (i < x.length && Math.abs(x[i]) < thr) i++;
  const ms = i / 48;
  if (ms > worstOnset) { worstOnset = ms; onsetAt = `${noteName(k)} v${l}`; }

}
process.stdout.write('\n');

// ---- 5. the tuning table should be smooth --------------------------------
// Arithmetic on what the build wrote, not a re-measurement. Not "close to
// equal temperament" -- a real piano is not -- but smooth, since a tuner's
// octaves are. A step means a key was placed off the wrong root, which is how
// the 60-cent jump between A#7 and B7 was found.
let worstKink = 0, kinkAt = '';
for (let i = 1; i < keys.length - 1; i++) {
  const a = m.notes[keys[i - 1]].cents, b = m.notes[keys[i]].cents, c = m.notes[keys[i + 1]].cents;
  if (a == null || b == null || c == null) continue;
  const bend = Math.abs(b - (a + c) / 2);
  if (bend > worstKink) { worstKink = bend; kinkAt = noteName(keys[i]); }
}

console.log(`\n  ${m.name}`);
console.log(`  built ${m.built}, ${m.format}${m.bitrate ? ' ' + m.bitrate : ''}, tuning "${m.tuning}", body correction ${m.bodyCorrection ? 'on' : 'off'}\n`);
console.log(`  keys                           : ${keys.length} (${noteName(keys[0])}..${noteName(keys[keys.length - 1])})`);
console.log(`  layer files                    : ${files}, ${missing} missing, ${(bytes / 1048576).toFixed(1)} MB`);
console.log(`  decoded and measured           : ${checked}`);
console.log(`  peak after the codec           : ${(20 * Math.log10(worstPeak)).toFixed(2)} dBFS  (${peakAt})`);
console.log(`  worst leading silence          : ${worstOnset.toFixed(1)} ms  (${onsetAt})`);
console.log(`  worst level inversion, layers  : ${worstInv.toFixed(1)} dB  (${worstInvAt})`);
console.log(`  worst level jump, neighbours   : ${worstSeam.toFixed(1)} dB  (${seamAt})`);
console.log(`  worst step in the tuning table : ${worstKink.toFixed(1)} cents  (${kinkAt})`);

const checks = [
  ['every key and layer present', missing === 0 && keys.length === m.keys.hi - m.keys.lo + 1],
  ['nothing clips after encoding', worstPeak < 1.0],
  ['silence is stripped', worstOnset < 5],
  ['layers rise with velocity', worstInv < 3.5],
  ['no seam between neighbours', worstSeam < 4],
  ['the tuning curve is smooth', worstKink < 12],
];
console.log('');
for (const [n, ok] of checks) console.log(`  ${ok ? 'pass' : 'FAIL'}  ${n}`);
if (fail.length) console.log('\n  ' + fail.join('\n  '));
const ok = checks.every((c) => c[1]) && !fail.length;
console.log(ok ? '\n  LIBRARY VERIFIED\n' : '\n  LIBRARY CHECK FAILED\n');
process.exit(ok ? 0 : 1);
