// Formant-preserving repitch.
//
// Salamander samples every third semitone, so two notes in three have to be
// moved by a semitone. Plain resampling -- what an SFZ player does live --
// moves EVERYTHING by that semitone: the partials, which is correct, and also
// the soundboard resonances, the case air modes, the microphones and the room,
// which are not. Those are fixed in absolute frequency. Dragging them around
// with the pitch is what puts the audible seam in a sampled piano every third
// key, and it is worse in the bass, where the response has a 30 dB/octave
// flank around the case's lowest air mode.
//
// So: resample, then put the response back.
//
//     G(f) = Body(f) / Body(f / ratio)
//
// applied as a single zero-phase filter over the whole sample. Two things make
// that both cheap and exact, and they are worth stating because the obvious
// implementation -- a phase vocoder with per-frame envelope correction -- is
// neither:
//
//   the body is time invariant.  It is an LTI path from the bridge outwards
//     (see the argument in the main README). So the correction is one static
//     filter, not a per-frame one, and per-frame estimation would only be
//     adding variance to a quantity that does not vary.
//   the body is already measured.  fitted/salamander-body.json is the response
//     of everything downstream of the bridge, fitted from THIS library by the
//     physical model in the other half of this repo. That matters more than it
//     sounds: from a single note you cannot separate the body's spectrum from
//     the string's, because a spectral tilt can be attributed to either and
//     absorbed into the note's gain. The separation needs a string model to
//     hold one side of it still, and there is one here.
//
// Measured against a synthetic instrument with a known body, this halves the
// spectral error of the shifted note relative to plain resampling, at every
// point in the compass, and never does worse -- see tools/sampler/selftest.mjs.
// A per-frame true-envelope correction was tried first and was WORSE than
// doing nothing above C4: with partials 500 Hz apart there are too few of them
// to estimate an envelope from, and the estimator's own noise is larger than
// the 1 dB effect being corrected.
//
// What this deliberately does not do is preserve duration. Reading a sample
// faster shortens it by the same ratio, and a real string a semitone higher
// really does decay faster -- so a time-stretch, with all the transient
// smearing it costs, would be undoing something that is already right. And
// because the correction is a real, even-symmetric gain, it is zero phase: the
// hammer attack comes through with its phase relationships intact, which is
// the part a phase vocoder always damages.
//
// Known limit: inharmonicity does not transform. Resampling scales every
// partial by the same ratio, so B is unchanged, whereas a real string a
// semitone higher has a slightly larger one. Over one semitone that is a few
// percent of B, far below what the ear resolves -- over the three semitones an
// SFZ player stretches a sample across, it is not.
import { fft } from './fft.mjs';
import { resample } from './resample.mjs';

/** Log-frequency interpolation over the fitted body curve, in dB. */
export function bodyDb(curve, f) {
  if (f <= curve[0][0]) return curve[0][1];
  const last = curve.length - 1;
  if (f >= curve[last][0]) return curve[last][1];
  let lo = 0, hi = last;
  while (lo < hi - 1) { const m = (lo + hi) >> 1; if (curve[m][0] <= f) lo = m; else hi = m; }
  const [f0, d0] = curve[lo], [f1, d1] = curve[hi];
  const t = Math.log(f / f0) / Math.log(f1 / f0);
  return d0 + (d1 - d0) * t;
}

/**
 * The correction, as a function of frequency, for one pitch ratio.
 *
 * It needs no clamping: the fitted curve is flat below its first point and
 * above its last, so G goes to unity at both ends on its own -- no correction
 * at DC, and none above 13.5 kHz where the fit ran out of partials to measure.
 */
export const correctionAt = (curve, ratio) => (f) =>
  Math.pow(10, (bodyDb(curve, f) - bodyDb(curve, f / ratio)) / 20);

/**
 * Resample by `ratio`, then undo the body's share of the move.
 *
 * The filtering is a single transform of the whole sample rather than an
 * overlap-add, which costs less than a windowed scheme and has no window in it
 * to leak. The two channels ride one complex transform -- L in the real part,
 * R in the imaginary -- because a real, even-symmetric gain is a real filter,
 * and a real filter applied to l + j*r comes back out as (h*l) + j*(h*r) with
 * no cross-talk between them.
 */
export function repitch(ch, fs, ratio, tab, gainAt) {
  const out = ratio === 1 ? ch.map((x) => x.slice()) : ch.map((x) => resample(x, ratio, tab));
  if (!gainAt || ratio === 1) return out;

  const len = out[0].length;
  let n = 1;
  while (n < len + 4096) n <<= 1;          // pad so the convolution cannot wrap
  const re = new Float64Array(n), im = new Float64Array(n);
  re.set(out[0]);
  if (out.length > 1) im.set(out[1]);
  fft(re, im, false);

  const half = n >> 1;
  for (let k = 1; k < half; k++) {
    const g = gainAt(k * fs / n);
    re[k] *= g; im[k] *= g;
    re[n - k] *= g; im[n - k] *= g;        // the mirrored bin, so the gain stays even
  }
  { const g = gainAt(half * fs / n); re[half] *= g; im[half] *= g; }

  fft(re, im, true);
  for (let i = 0; i < len; i++) out[0][i] = re[i];
  if (out.length > 1) for (let i = 0; i < len; i++) out[1][i] = im[i];
  return out;
}

export { resample };
