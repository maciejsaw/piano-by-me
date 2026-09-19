// The felt hardness curve, solved from a target contact-duration curve.
//
// Contact duration decides how far up the partial ladder a strike reaches. It
// is not a free parameter and it is not flat: it falls several-fold from the
// bottom of the keyboard to the top, and measured against the string's own
// period it does the opposite, rising from a tenth of a period in the bass to
// a couple of periods at the top.
//
// Both ends have a characteristic sound when it is wrong. Too short in the
// bass is a sharp pulse on a long string, heard as a metallic zing. Too long
// in the treble leaves the felt lying on the string through round trip after
// round trip, damping what it just excited, heard as a hammer far too big for
// the note.
//
// `gamma` steepens the curve about C3: 1 is the literature curve, above 1
// lengthens the bass and shortens the treble together. It exists because the
// ear put C3 right while calling everything below it zingy and everything
// above it choked, which is a slope and not an offset.
import { contactMs } from '../../src/dsp/hammer.js';
import { DEFAULT_SCALE } from '../../src/dsp/scale.js';

const FS = 48000;
const PIVOT = 48;

// Measured contact durations, bass to treble. C4 at 2 ms is the one everybody
// reports (Chaigne & Askenfelt; Russell); the rest follows the usual curve.
export const TARGET = [[21, 4.5], [33, 3.4], [45, 2.6], [60, 2.0], [72, 1.4], [84, 1.0], [96, 0.7], [108, 0.5]];
export const ANCHORS = [21, 27, 33, 39, 45, 51, 57, 63, 69, 75, 81, 87, 93, 99, 105, 108];

export const lerpT = (t, x) => {
  if (x <= t[0][0]) return t[0][1];
  for (let i = 0; i < t.length - 1; i++) {
    if (x >= t[i][0] && x <= t[i + 1][0]) {
      const u = (x - t[i][0]) / (t[i + 1][0] - t[i][0]);
      return t[i][1] + (t[i + 1][1] - t[i][1]) * u;
    }
  }
  return t[t.length - 1][1];
};

export const hammerSpeed = (v) => 0.18 * Math.pow(v, 0.15) * Math.exp(3.5 * v * v);

export function targetMs(midi, gamma = 1) {
  const base = lerpT(TARGET, PIVOT);
  return base * Math.pow(lerpT(TARGET, midi) / base, gamma);
}

function contactFor(note, hardness, speed) {
  return contactMs(FS, {
    mass: lerpT(DEFAULT_SCALE.voicing.hammerMass, note.midi) * Math.pow(10, -0.35 * hardness),
    K: 1.8e9 * Math.pow(10, 2 * hardness),
    p: note.feltP,
    Z: note.Z * note.count,
    velocity: speed,
    strikeDelay: 8,
    eps: note.feltEps,
    tauUs: 2,
  });
}

/** Bisect hardness per anchor note until contact hits the target. */
export function solveHardness(model, gamma = 1, velocity = 0.75) {
  const speed = hammerSpeed(velocity);
  return ANCHORS.map((midi) => {
    const note = model.notes[midi - 21];
    const want = targetMs(midi, gamma);
    let lo = -1.8, hi = 2.6;                    // contact shortens as felt hardens
    for (let i = 0; i < 48; i++) {
      const mid = (lo + hi) / 2;
      if (contactFor(note, mid, speed) > want) lo = mid; else hi = mid;
    }
    return [midi, +((lo + hi) / 2).toFixed(3)];
  });
}

/** A scale with that hardness curve, for rendering without editing tables. */
export function scaleWithGamma(model, gamma, velocity = 0.75) {
  return { ...DEFAULT_SCALE, voicing: { ...DEFAULT_SCALE.voicing, hardness: solveHardness(model, gamma, velocity) } };
}
