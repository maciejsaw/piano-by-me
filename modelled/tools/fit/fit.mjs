// Fit the model to a real piano.
//
//   node tools/fit/fit.mjs <sampleDir> [velocityLayer] [outFile]
//
// Structure matters more than the optimiser here. A naive approach throws every
// parameter into one black-box search against a spectrogram distance, which is
// slow, badly conditioned, and gives parameters that mean nothing. Because this
// model is actually physical, most parameters are either measurable or
// invertible in closed form, and only a couple need searching:
//
//   tuning          measured directly (f0 per note)
//   inharmonicity   measured, then INVERTED to wire gauge and length
//   strike position measured from the comb notch in the attack spectrum
//   decay           measured per partial, then fitted (2-D) to the loss filter
//   hammer          the only genuine search, and it is 2-D per note
//
// Measured curves are smoothed with outlier rejection before use: a real library
// always has a few notes where partial tracking loses its footing, and one bad
// note must not become one bad string.

import { writeFileSync } from 'node:fs';
import { indexLibrary, loadNote } from './samples.mjs';
import { extractFeatures } from './features.mjs';
import { invertPlain, invertWound } from './invert.mjs';
import { designLoss, lossResponse } from '../../src/dsp/design.js';
import { noteHz, noteName } from '../../src/dsp/physics.js';
import { DEFAULT_SCALE } from '../../src/dsp/scale.js';
import { nelderMead } from './optim.mjs';

const dir = process.argv[2];
const layer = Number(process.argv[3] || 12);
const outFile = process.argv[4] || 'fitted-scale.json';
if (!dir) { console.error('usage: fit.mjs <sampleDir> [layer] [out]'); process.exit(1); }

// ---------------------------------------------------------------- measure ---
const lib = indexLibrary(dir).filter((f) => f.layer === layer);
console.log(`\n  measuring ${lib.length} notes from ${dir.split('/').pop()} (layer ${layer})`);

const measured = [];
for (const f of lib) {
  const { data, rate } = loadNote(f.path);
  const feat = extractFeatures(data, rate, noteHz(f.midi), {
    nMax: 24, decaySpanS: 3.0, attackDelayS: 0.05,
  });
  measured.push({ midi: f.midi, note: f.note, rate, feat });
}

// ------------------------------------------------------ robust smoothing ----
/** Local linear fit with iterative outlier rejection. */
function smooth(points, at, { bandwidth = 14, reject = 2.2, passes = 3 } = {}) {
  let keep = points.filter((p) => isFinite(p.y));
  for (let pass = 0; pass < passes; pass++) {
    const pred = (x) => {
      let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
      for (const p of keep) {
        const u = (p.x - x) / bandwidth;
        const w = Math.exp(-0.5 * u * u);
        if (w < 1e-4) continue;
        sw += w; sx += w * p.x; sy += w * p.y; sxx += w * p.x * p.x; sxy += w * p.x * p.y;
      }
      if (sw < 1e-9) return NaN;
      const den = sw * sxx - sx * sx;
      if (Math.abs(den) < 1e-12) return sy / sw;
      const b = (sw * sxy - sx * sy) / den;
      const a = (sy - b * sx) / sw;
      return a + b * x;
    };
    if (pass === passes - 1) return at.map(pred);
    const resid = keep.map((p) => Math.abs(p.y - pred(p.x)));
    const sorted = [...resid].sort((a, b) => a - b);
    const mad = sorted[Math.floor(sorted.length / 2)] || 1e-9;
    keep = keep.filter((p, i) => resid[i] < reject * mad * 1.4826 + 1e-9);
    if (keep.length < 5) break;
  }
  return at.map(() => NaN);
}

const ALL = [];
for (let m = 21; m <= 108; m++) ALL.push(m);

// --- tuning: cents off equal temperament ---
const tuningPts = measured.map((m) => ({
  x: m.midi, y: 1200 * Math.log2(m.feat.f0 / noteHz(m.midi)),
})).filter((p) => Math.abs(p.y) < 60);          // drop tracking failures
const tuningCurve = smooth(tuningPts, ALL, { bandwidth: 11 });

// --- inharmonicity: fit in log space, it spans two decades ---
const bPts = measured
  .filter((m) => m.feat.B > 1e-6 && m.feat.B < 0.2)
  .map((m) => ({ x: m.midi, y: Math.log(m.feat.B) }));
const bCurve = smooth(bPts, ALL, { bandwidth: 10 }).map(Math.exp);

// --- strike position ---
const aPts = measured
  .filter((m) => isFinite(m.feat.strikeAlpha) && m.feat.strikeAlpha > 0.09 && m.feat.strikeAlpha < 0.15)
  .map((m) => ({ x: m.midi, y: m.feat.strikeAlpha }));
const aCurve = smooth(aPts, ALL, { bandwidth: 20 });

console.log(`  usable: tuning ${tuningPts.length}/${measured.length}, ` +
            `B ${bPts.length}/${measured.length}, strike ${aPts.length}/${measured.length}`);

// --------------------------------------------------- decay -> loss filter ---
/**
 * Find the (t60Low, t60High) whose designed loss filter reproduces a measured
 * decay-rate-versus-frequency curve.
 *
 * The LATE decay is the target, not the early one: in a real piano the quick
 * initial fall is the in-phase unison mode dumping energy into the bridge, which
 * this model produces on its own from unison coupling. The slow aftersound is
 * the string's intrinsic loss, which is what t60 actually parameterises. Fitting
 * the early rate instead would double-count the coupling loss.
 */
function fitDecay(fs, f0, curve, kappa = 0.002) {
  const pts = curve.filter((c) => isFinite(c.rateLate) && c.rateLate > 0.2 && c.rateLate < 200);
  if (pts.length < 4) return null;
  const modelRate = (t60Low, t60High, f) => {
    const { g, b } = designLoss(fs, f0, t60Low, t60High, 5000, kappa);
    const w = 2 * Math.PI * Math.min(f, 0.45 * fs) / fs;
    const H = lossResponse(w, g, b);
    const mag = Math.hypot(H[0], H[1]) * (1 - kappa);
    return -20 * Math.log10(Math.max(mag, 1e-9)) * f0;
  };
  const obj = ([lo, hi]) => {
    const t60Low = Math.exp(lo), t60High = Math.exp(hi);
    if (t60High > t60Low) return 1e9;
    let e = 0;
    for (const c of pts) {
      const d = Math.log((modelRate(t60Low, t60High, c.f) + 1e-6) / (c.rateLate + 1e-6));
      e += d * d;
    }
    return e / pts.length;
  };
  const r = nelderMead(obj, [Math.log(10), Math.log(1.0)], {
    lo: [Math.log(0.3), Math.log(0.05)], hi: [Math.log(60), Math.log(12)],
    step: [0.4, 0.4], maxIter: 160,
  });
  return { t60Low: Math.exp(r.x[0]), t60High: Math.exp(r.x[1]), err: r.value, points: pts.length };
}

const decayFits = measured.map((m) => {
  const fit = fitDecay(m.rate, m.feat.f0, m.feat.decayCurve);
  return { midi: m.midi, fit };
});
const t60LoPts = decayFits.filter((d) => d.fit).map((d) => ({ x: d.midi, y: Math.log(d.fit.t60Low) }));
const t60HiPts = decayFits.filter((d) => d.fit).map((d) => ({ x: d.midi, y: Math.log(d.fit.t60High) }));
const t60LoCurve = smooth(t60LoPts, ALL, { bandwidth: 12 }).map(Math.exp);
const t60HiCurve = smooth(t60HiPts, ALL, { bandwidth: 12 }).map(Math.exp);
console.log(`  decay fits: ${t60LoPts.length}/${measured.length}`);

// ------------------------------------------- invert geometry per note -------
// Tension and bass length come from the instrument's scale design, which the
// samples cannot reveal; everything else is inverted from what was measured.
const tensionAt = (m) => 700 + 40 * Math.cos(((m - 21) / 87) * Math.PI);
const bassLengthAt = (m) => Math.min(1.35, 0.95 * Math.pow(2, (52 - m) / 22));
const WOUND_BELOW = 53;

const overrides = {};
for (let i = 0; i < ALL.length; i++) {
  const midi = ALL[i];
  const cents = tuningCurve[i];
  const f0 = noteHz(midi) * Math.pow(2, (isFinite(cents) ? cents : 0) / 1200);
  const B = bCurve[i];
  if (!isFinite(B) || B <= 0) continue;
  const T = tensionAt(midi);

  const spec = midi < WOUND_BELOW
    ? invertWound(B, T, f0, bassLengthAt(midi))
    : invertPlain(B, T, f0);

  const strings = {};
  if (isFinite(aCurve[i])) strings.strikePosition = aCurve[i];
  if (isFinite(t60LoCurve[i])) strings.t60Low = t60LoCurve[i];
  if (isFinite(t60HiCurve[i])) strings.t60High = t60HiCurve[i];

  overrides[midi] = { spec, strings };
}

const fitted = {
  ...DEFAULT_SCALE,
  name: `fitted from ${dir.split('/').filter(Boolean).pop()} (layer ${layer})`,
  tuningCents: ALL.map((m, i) => [m, +(tuningCurve[i] || 0).toFixed(2)]),
  overrides,
};
writeFileSync(outFile, JSON.stringify(fitted, null, 1));

console.log(`\n  wrote ${outFile}\n`);
console.log('  note   tuning    B measured   alpha   t60Low  t60High   d(mm)  L(mm)  T(N)  type');
for (const midi of [21, 33, 45, 53, 60, 69, 76, 84, 96]) {
  const i = midi - 21, o = overrides[midi];
  if (!o) continue;
  const mu = o.spec.wound ? NaN : 0;
  console.log(
    `  ${noteName(midi).padEnd(5)} ${(tuningCurve[i] >= 0 ? '+' : '') + tuningCurve[i].toFixed(1).padStart(5)}c  ` +
    `${bCurve[i].toExponential(2)}   ${(o.strings.strikePosition ?? NaN).toFixed(3)}  ` +
    `${(o.strings.t60Low ?? NaN).toFixed(1).padStart(6)} ${(o.strings.t60High ?? NaN).toFixed(2).padStart(7)}  ` +
    `${o.spec.coreDiameterMm.toFixed(3).padStart(6)} ${(o.spec.lengthM * 1000).toFixed(0).padStart(5)} ` +
    `${tensionAt(midi).toFixed(0).padStart(5)}  ${o.spec.wound ? 'wound ' + o.spec.wrapOuterDiameterMm.toFixed(2) : 'plain'}`);
}
console.log('');
