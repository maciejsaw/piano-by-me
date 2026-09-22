// Which source file becomes which key, and at what ratio.
//
// Salamander records A0 and then every third semitone to C8: thirty notes for
// eighty-eight keys. So each recording serves three keys -- itself, the one
// below and the one above -- and the shift is never more than a semitone.
// That bound is the whole reason the repitch can afford to be careful.

export const LOW = 21, HIGH = 108;
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const noteName = (m) => NAMES[m % 12] + (Math.floor(m / 12) - 1);

/** The thirty recorded roots: A0, then every third semitone. */
export const ROOTS = (() => { const r = []; for (let m = LOW; m <= HIGH; m += 3) r.push(m); return r; })();

/** The damper-release ("harm") recordings stop at D#6; above that there are no dampers. */
export const HARM_ROOTS = ROOTS.filter((m) => m <= 87);

export const nearestRoot = (midi, roots) =>
  roots.reduce((b, r) => (Math.abs(r - midi) < Math.abs(b - midi) ? r : b), roots[0]);

/**
 * Pitch ratio from source to target.
 *
 * `cents` is the instrument's own stretch -- the Railsback curve fitted from
 * this library in modelled/fitted/salamander-scale.json, -22 cents at A0 rising to +21
 * at C8. Taking the DIFFERENCE of the curve at the two keys, rather than
 * forcing the target onto it absolutely, is what keeps a repitched key in tune
 * with the recording it came from: the root samples are never touched, so any
 * absolute retuning would make them disagree with their own neighbours by
 * whatever the fit's error is. What the curve supplies here is only how much
 * wider than 100 cents this particular piano's semitone is at this point in
 * the compass -- which near the ends is a real quarter of a cent per semitone.
 */
export function ratioFor(src, target, cents) {
  if (src === target) return 1;
  const c = cents ? (m) => (cents[m] ?? 0) / 100 : () => 0;
  return Math.pow(2, ((target + c(target)) - (src + c(src))) / 12);
}

/** midi -> cents lookup from a fitted scale file. */
export function centsTable(scale) {
  if (!scale?.tuningCents) return null;
  const t = {};
  for (const [m, c] of scale.tuningCents) t[m] = c;
  return t;
}

/** Group the work by source recording, so one read serves all three keys. */
export function planNotes(roots, cents, keys = { lo: LOW, hi: HIGH }) {
  const byRoot = new Map(roots.map((r) => [r, []]));
  for (let m = keys.lo; m <= keys.hi; m++) {
    const r = nearestRoot(m, roots);
    byRoot.get(r).push({ midi: m, shift: m - r, ratio: ratioFor(r, m, cents) });
  }
  return byRoot;
}

/**
 * How long a key is allowed to ring in the library.
 *
 * Not an artistic choice -- the tail trim already cuts at the noise floor and
 * usually gets there first. This is the backstop that keeps a bass fortissimo
 * from spending four megabytes on its last 20 dB.
 */
export function maxSeconds(midi) {
  const pts = [[21, 30], [36, 26], [48, 20], [60, 14], [72, 9], [84, 6], [96, 4], [108, 3]];
  if (midi <= pts[0][0]) return pts[0][1];
  for (let i = 0; i < pts.length - 1; i++) {
    const [a, av] = pts[i], [b, bv] = pts[i + 1];
    if (midi <= b) return av + (bv - av) * (midi - a) / (b - a);
  }
  return pts[pts.length - 1][1];
}
