// Fit the transient-damping depth and the aftersound's high-frequency T60
// across the keyboard, against every sample the library has.
//
// C3 was fitted by hand and the rest of the range inherited its numbers,
// which is only right if a treble string gives up its high partials at the
// same rate a bass one does. It does not -- A0 came out 26 dB too bright,
// and rising through the note where the real one falls 27 dB.
//
// Scored on the brightness trace (high band over low band at a series of
// times), the measure that caught the over-damping on C3, with the bands
// following the note. The two knobs are close to separable -- the T60 scale
// sets the standing tilt, the depth sets the early bend -- so this is
// coordinate descent rather than a full grid, which is what makes a range
// wide enough for the bass affordable.
//
//   node tools/fit/fit-damping.mjs [outJson]
//   SHARD=0 SHARDS=4 node tools/fit/fit-damping.mjs out-0.json   (one core each)
import { writeFileSync } from 'node:fs';
import { readWav } from './wavread.mjs';
import { TIMES } from './brightness.mjs';
import { fitBands, bandRatioDb } from './bands.mjs';
import { indexLibrary } from './samples.mjs';
import { renderNote } from './decay-report.mjs';
import { DEFAULT_SCALE } from '../../src/dsp/scale.js';
import { noteHz } from '../../src/dsp/physics.js';

const DIR = process.env.SAMPLES ?? '/home/user/samples/salamander';
const OUT = process.argv[2] || 'fitted/transient-damping.json';
const SHARD = Number(process.env.SHARD ?? 0);
const SHARDS = Number(process.env.SHARDS ?? 1);
const KHI = [0.03, 0.08, 0.2, 0.5, 1, 2];
const DEPTHS = [0, 0.07, 0.14, 0.25, 0.4];
// Four seconds is enough to see the standing tilt and costs a third less
// render time than six. The tail past four is the aftersound's business.
const FIT_TIMES = TIMES.filter((t) => t <= 4);

const hiScaled = (k) => (k === 1 ? undefined : {
  ...DEFAULT_SCALE,
  voicing: {
    ...DEFAULT_SCALE.voicing,
    t60High: DEFAULT_SCALE.voicing.t60High.map(([m, v]) => [m, v * k]),
  },
});

const notes = indexLibrary(DIR)
  .filter((n) => n.layer === 12)
  .sort((a, b) => a.midi - b.midi)
  .filter((_, i) => i % SHARDS === SHARD);

const results = [];
for (const n of notes) {
  const s = readWav(n.path);
  const lenS = s.data.length / s.rate;
  const times = FIT_TIMES.filter((t) => t + 0.2 < lenS);
  if (times.length < 4) { console.log(`${n.note} too short (${lenS.toFixed(1)}s), skipped`); continue; }
  const f0 = noteHz(n.midi);
  // Bands come from the sample, not from a formula: see bands.mjs. Above
  // about A5 the v12 layer has no energy at 4 x f0 at all, so there is no
  // high band and nothing here can constrain those notes.
  const band = fitBands(s.data, s.rate, f0);
  if (!band.usable) {
    console.log(`${n.note.padEnd(4)} midi=${String(n.midi).padStart(3)}  no usable high band (fTop=${Math.round(band.fTop)} Hz, 4*f0=${Math.round(f0 * 4)} Hz), skipped`);
    continue;
  }
  const realB = times.map((t) => bandRatioDb(s.data, s.rate, t, band));
  const seconds = Math.min(8, Math.ceil(times[times.length - 1] + 1));
  const score = (depth, k) => {
    const x = renderNote(seconds, n.midi, { transientDepth: depth, scale: hiScaled(k) });
    const b = times.map((t) => bandRatioDb(x, 48000, t, { lo: band.lo, hi: band.hi }));
    return b.reduce((a, v, i) => a + Math.abs(v - realB[i]), 0) / times.length;
  };
  let depth = 0.14, k = 1, err = Infinity;
  for (let pass = 0; pass < 2; pass++) {
    for (const kk of KHI) { const e = score(depth, kk); if (e < err) { err = e; k = kk; } }
    for (const dd of DEPTHS) { const e = score(dd, k); if (e < err) { err = e; depth = dd; } }
  }
  results.push({
    midi: n.midi, note: n.note, depth, t60HighScale: k, errDb: +err.toFixed(2),
    fTop: Math.round(band.fTop), hi: band.hi.map((v) => Math.round(v)),
  });
  console.log(`${n.note.padEnd(4)} midi=${String(n.midi).padStart(3)}  depth=${String(depth).padEnd(5)} t60HighScale=${String(k).padEnd(5)} err=${err.toFixed(1)} dB`);
  writeFileSync(OUT, JSON.stringify({ khi: KHI, depths: DEPTHS, results }, null, 2));
}
console.log(`\nwrote ${OUT}`);
