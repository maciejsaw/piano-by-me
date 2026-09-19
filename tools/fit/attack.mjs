// What does the hammer put into each partial, and when?
//
// Everything else in this repo measures decay -- how a partial falls once it
// is ringing. None of it constrains what the strike puts there in the first
// place, which is the hammer's job and is set within the first few tens of
// milliseconds. So this tracks each partial through the attack on a 5 ms grid
// and reports two things per partial:
//
//   level    its level at the moment the note is loudest, relative to the
//            fundamental. This is the hammer's spectral signature: contact
//            time sets how far up the ladder the energy reaches, and the
//            felt's nonlinearity sets how much of it is up there at all.
//   riseMs   how long it takes to get there. A high partial arrives while the
//            hammer is still on the string and a low one takes longer, so the
//            spread of rise times is a direct read on contact duration.
//
// Windowing is the awkward part: 5 ms of a 131 Hz note is not enough to tell
// its partials apart. So the hop is 5 ms but the window is longer, sized from
// the note -- four periods, floored at 15 ms -- which resolves adjacent
// partials while still being short enough that the attack is not smeared.
import { goertzel } from '../analyze.mjs';
import { estimateHarmonics } from './decay.mjs';

export function attackTracks(x, fs, f0Nominal, opts = {}) {
  const { hopS = 0.005, spanS = 0.15, nPartials = 20, startS = 0 } = opts;
  const h = estimateHarmonics(x, fs, f0Nominal, { nPartials: Math.min(nPartials, 16) });
  const winS = opts.winS ?? Math.max(0.015, 4 / h.f0);
  const win = Math.round(winS * fs);
  const hop = Math.round(hopS * fs);
  const steps = Math.floor((spanS * fs) / hop);

  const tracks = [];
  for (let n = 1; n <= nPartials; n++) {
    const f = n * h.f0 * Math.sqrt(1 + h.B * n * n);
    if (f > fs / 2.2) break;
    const db = [], tMs = [];
    for (let i = 0; i < steps; i++) {
      const at = Math.round(startS * fs) + i * hop;
      if (at + win > x.length) break;
      db.push(20 * Math.log10(goertzel(x, fs, f, at, win) + 1e-18));
      tMs.push((at / fs) * 1000);
    }
    if (!db.length) break;
    let peak = -Infinity, peakAt = 0;
    db.forEach((v, i) => { if (v > peak) { peak = v; peakAt = tMs[i]; } });
    tracks.push({ n, f, db, tMs, peak, riseMs: peakAt });
  }
  // Levels are relative to the fundamental's peak: a hammer comparison must
  // not be a loudness comparison.
  const ref = tracks.length ? tracks[0].peak : 0;
  for (const t of tracks) t.rel = t.peak - ref;
  return { f0: h.f0, B: h.B, winS, tracks };
}

/** Mean absolute difference in the relative partial ladder, in dB. */
export function ladderError(a, b, nMax = 16) {
  let s = 0, n = 0;
  for (let i = 0; i < Math.min(a.tracks.length, b.tracks.length, nMax); i++) {
    s += Math.abs(a.tracks[i].rel - b.tracks[i].rel); n++;
  }
  return n ? s / n : Infinity;
}

export function printAttack(label, r, nMax = 16) {
  console.log(`\n${label}   f0=${r.f0.toFixed(2)} Hz  window=${(r.winS * 1000).toFixed(0)} ms`);
  console.log('    n      f Hz    rel dB   rise ms');
  for (const t of r.tracks.slice(0, nMax)) {
    console.log(`   ${String(t.n).padStart(2)} ${t.f.toFixed(1).padStart(9)} ${t.rel.toFixed(1).padStart(9)} ${t.riseMs.toFixed(0).padStart(9)}`);
  }
}
