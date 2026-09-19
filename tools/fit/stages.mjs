// Decay rate in successive time bands, averaged over partial groups.
//
// A single early/late split is too blunt and too easily thrown by a beat
// inside the window. This reports dB/s in four bands, so the SHAPE of each
// partial group's decay is visible: a real piano's high partials fall fast
// at the start and then settle to about the same rate as the low ones,
// because the air has already taken what it is going to take.
import { partialDecay } from './decay.mjs';

export const BANDS = [[0.2, 0.7], [0.7, 1.5], [1.5, 3.0], [3.0, 6.0]];
export const GROUPS = [[1, 4], [5, 9], [10, 14]];

function slopeIn(tS, db, a, b) {
  let n = 0, st = 0, sy = 0, stt = 0, sty = 0;
  for (let i = 0; i < tS.length; i++) {
    if (tS[i] < a || tS[i] > b) continue;
    n++; st += tS[i]; sy += db[i]; stt += tS[i] * tS[i]; sty += tS[i] * db[i];
  }
  const d = n * stt - st * st;
  return n >= 3 && d ? (n * sty - st * sy) / d : NaN;
}

export function stageProfile(x, fs, f0) {
  const r = partialDecay(x, fs, f0, { spanS: 6.5, hopS: 0.05 });
  const rows = GROUPS.map(([lo, hi]) => {
    const ts = r.tracks.filter((t) => t.n >= lo && t.n <= hi);
    return BANDS.map(([a, b]) => {
      const v = ts.map((t) => slopeIn(t.tS, t.db, a, b)).filter(Number.isFinite);
      return v.length ? v.reduce((s, q) => s + q, 0) / v.length : NaN;
    });
  });
  return { f0: r.f0, B: r.B, rows, tracks: r.tracks };
}

export function printProfile(label, p) {
  console.log(`\n${label}   (dB/s)`);
  console.log('  partials   ' + BANDS.map(([a, b]) => `${a}-${b}s`.padStart(8)).join(''));
  GROUPS.forEach(([lo, hi], i) => {
    console.log(`  ${String(lo + '-' + hi).padStart(8)}   ` +
      p.rows[i].map((v) => (Number.isFinite(v) ? v.toFixed(1) : '--').padStart(8)).join(''));
  });
}
