// What the player needs to know about a sample that it cannot hear for itself.
//
// Three of the engine's features are driven from measurements made here rather
// than from guesses made in the browser:
//
//   f0        the note's real pitch, so repitched notes can be landed on this
//             instrument's own stretch curve instead of on equal temperament
//   decay     a dB-against-time curve, which the resonance engine divides out
//             so that a sympathetic voice's level is set by how much energy
//             has been fed into it and not by how far into the sample it is
//   edr       how fast the note dies over its first 20 dB, which is the
//             time constant the resonance accumulator leaks with
import { measurePitch } from './pitch.mjs';

export const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

/**
 * The note's real pitch and inharmonicity. See pitch.mjs for how, and why not
 * simply looking for a peak near the fundamental.
 */
export function measureF0(x, fs, midi) {
  const r = measurePitch(x, fs, midiToHz(midi));
  return { hz: r.hz, cents: r.cents, B: r.B, confident: r.confident };
}

/**
 * The RMS envelope, in dB, at a fixed 20 ms hop.
 *
 * Fixed hop rather than the quadratic time grid this used to sample on. The
 * grid looked efficient and was not: on a seven-second sample it put only
 * three points inside the -3 to -20 dB span, and fitting a decay rate through
 * three points gave B3 and C4 -- which are the SAME recording, one semitone
 * apart -- rates that differed by a factor of three.
 */
function rmsEnvelope(x, fs) {
  const win = Math.round(0.04 * fs), hop = Math.round(0.02 * fs);
  const n = Math.max(1, Math.floor((x.length - win) / hop) + 1);
  const t = new Float64Array(n), db = new Float64Array(n);
  let ref = 1e-12;
  const lin = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const c = i * hop;
    let s = 0;
    for (let j = c; j < c + win; j++) s += x[j] * x[j];
    lin[i] = Math.sqrt(s / win);
    if (lin[i] > ref) ref = lin[i];
    t[i] = (c + win / 2) / fs;
  }
  for (let i = 0; i < n; i++) db[i] = 20 * Math.log10(Math.max(lin[i], 1e-9) / ref);
  return { t, db };
}

/**
 * Decay as dB against time, thinned onto a log grid for the manifest.
 *
 * Log spacing rather than linear because what reads this back -- the
 * resonance engine, dividing the sample's own decay out of a sympathetic
 * voice -- needs resolution where the curve bends, and on a piano that is all
 * in the first half second.
 */
export function decayCurve(x, fs, points = 28) {
  const env = rmsEnvelope(x, fs);
  const dur = Math.max(0.05, x.length / fs);
  const t = [], db = [];
  let prev = -1;
  for (let i = 0; i < points; i++) {
    const tt = 0.01 * Math.pow(dur / 0.01, i / (points - 1));
    let j = Math.round(tt / 0.02) - 1;
    j = Math.max(0, Math.min(env.t.length - 1, j));
    if (j === prev) continue;                   // the log grid is finer than the hop down here
    prev = j;
    t.push(+env.t[j].toFixed(4));
    db.push(+env.db[j].toFixed(2));
  }
  return { t, db, env };
}

/**
 * Early decay rate, in dB per second, by least squares over -3 to -20 dB.
 *
 * Not T60, and deliberately. A library sample is cut long before it has fallen
 * 60 dB, so fitting that far out means fitting a few points near the tail trim
 * and extrapolating -- which on C4 returned anything between 12 and 56 seconds
 * across sixteen layers of the same note. The first 20 dB is a straight line,
 * has plenty of points behind it, and is also the part that matters: it is how
 * fast a sympathetic ring dies away, which is the only thing downstream asks
 * this for.
 */
export function earlyDecayRate(curve) {
  const { t, db } = curve.env ?? curve;
  let n = 0, st = 0, sd = 0, stt = 0, std = 0;
  for (let i = 0; i < t.length; i++) {
    if (db[i] > -3 || db[i] < -20) continue;
    n++; st += t[i]; sd += db[i]; stt += t[i] * t[i]; std += t[i] * db[i];
  }
  if (n < 4) return null;
  const denom = n * stt - st * st;
  if (Math.abs(denom) < 1e-12) return null;
  const slope = (n * std - st * sd) / denom;
  if (slope >= -0.02) return null;
  return +(-slope).toFixed(3);
}

export const rmsOf = (x) => { let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, x.length)); };
