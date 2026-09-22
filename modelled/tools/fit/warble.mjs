// Measure audible beating -- the "flanger" artefact.
//
// Every partial of a struck unison wobbles, in the model and on a real piano
// alike, so a plain modulation figure says nothing. Two things separate a piano
// from a flanger:
//
//   RATE   a double decay is monotonic curvature, essentially DC. Flanging is
//          periodic, a few Hz. So the envelope is band-limited before measuring,
//          and slow curvature is discarded rather than counted as wobble.
//   WEIGHT a 7 dB swing on a partial 40 dB down is inaudible; the same swing on
//          the loudest partial is the whole character of the note. Each partial
//          is therefore weighted by its own energy share.
//
// Reported as warble: loudness-weighted RMS of the 0.5-10 Hz envelope
// modulation, in dB.

import { envelope } from '../analyze.mjs';
import { extractFeatures } from './features.mjs';

/** RMS of a dB envelope's modulation within a rate band, after detrending. */
export function warbleOf(x, fs, f, { spanS = 3.5, winMs = 25, loHz = 0.5, hiHz = 10 } = {}) {
  const env = envelope(x, fs, f, winMs, spanS);
  const v = env.values.filter((a) => a > 0);
  if (v.length < 40) return NaN;
  const db = v.map((a) => 20 * Math.log10(a));
  const N = db.length, fsEnv = 1 / env.hopS;
  // Remove the decay trend; what is left is modulation about it.
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < N; i++) { sx += i; sy += db[i]; sxx += i * i; sxy += i * db[i]; }
  const sl = (N * sxy - sx * sy) / (N * sxx - sx * sx), mu = sy / N;
  const d = db.map((a, i) => (a - (mu + sl * (i - sx / N))) * 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1))));
  // Parseval over the rate band only, so double-decay curvature is excluded.
  let e = 0;
  const df = fsEnv / N;
  for (let k = Math.max(1, Math.ceil(loHz / df)); k <= Math.min(N >> 1, Math.floor(hiHz / df)); k++) {
    let re = 0, im = 0;
    for (let i = 0; i < N; i++) { const a = (2 * Math.PI * k * i) / N; re += d[i] * Math.cos(a); im -= d[i] * Math.sin(a); }
    e += 2 * (re * re + im * im) / (N * N);
  }
  return Math.sqrt(e) * Math.SQRT2 / 0.6;   // undo the Hann amplitude loss
}

/** Loudness-weighted warble of a note, plus the per-partial breakdown. */
export function warble(x, fs, f0Hint, opts = {}) {
  const f = extractFeatures(x, fs, f0Hint, { nMax: opts.nMax ?? 24, decaySpanS: 3.0 });
  const rows = f.partials
    .filter((p) => p.reliable && p.relDb > (opts.floorDb ?? -45))
    .map((p) => ({ n: p.n, f: p.f, relDb: p.relDb, w: Math.pow(10, p.relDb / 10), warble: warbleOf(x, fs, p.f, opts) }))
    .filter((r) => isFinite(r.warble));
  const W = rows.reduce((s, r) => s + r.w, 0) || 1;
  return { weighted: rows.reduce((s, r) => s + r.w * r.warble, 0) / W, rows, features: f };
}
