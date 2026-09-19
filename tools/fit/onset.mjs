// The first 20 milliseconds.
//
// Everything else here measures the note. This measures the blow: the shape
// of the envelope while the hammer is still on the string and just after, on
// a 1 ms grid, with both signals aligned on their own onsets so the
// comparison is not thrown by a sample's leading silence.
//
// Two numbers carry most of the difference between a struck string and a
// plucked one:
//
//   riseMs   how long the envelope takes to reach half its early peak. A felt
//            hammer stays on the string for a millisecond or two and the
//            string keeps gathering amplitude for tens of milliseconds after.
//            A pluck, or a hammer modelled as an impulse, is there at once.
//   crest    peak over RMS in the first 5 ms. A sharp transient with nothing
//            behind it -- a click -- has a high crest factor.

/**
 * Where the hammer actually hits.
 *
 * Not the first audible sample: these samples were recorded from a real
 * action and carry its noise -- key, knuckle, jack -- for several
 * milliseconds before the felt reaches the string. Taking the first sample
 * above a floor puts the zero on that noise, and then the strike looks like a
 * slow ramp that takes ten milliseconds to arrive. It is not; there is a 17 dB
 * step at the moment of contact and this finds that step.
 *
 * So: walk a short RMS window and take the largest rise between neighbouring
 * windows, then back off to where that rise began.
 */
export function onsetIndex(x, fs = 48000, { winMs = 1, searchMs = 120 } = {}) {
  const win = Math.max(2, Math.round((winMs * fs) / 1000));
  const steps = Math.min(Math.floor((searchMs * fs) / 1000 / win), Math.floor(x.length / win) - 1);
  const env = new Float64Array(Math.max(steps, 1));
  for (let i = 0; i < steps; i++) {
    let s = 0;
    for (let k = i * win; k < (i + 1) * win; k++) s += x[k] * x[k];
    env[i] = Math.sqrt(s / win);
  }
  let best = 0, at = 0;
  for (let i = 1; i < steps; i++) {
    const rise = Math.log(env[i] + 1e-20) - Math.log(env[i - 1] + 1e-20);
    if (rise > best) { best = rise; at = i - 1; }
  }
  return at * win;
}

/** Envelope on a 1 ms grid from the onset, in dB relative to its own peak. */
export function onsetEnvelope(x, fs, { hopMs = 1, spanMs = 60, winMs = 2 } = {}) {
  const start = onsetIndex(x, fs);
  const hop = Math.max(1, Math.round((hopMs * fs) / 1000));
  const win = Math.max(2, Math.round((winMs * fs) / 1000));
  const steps = Math.floor((spanMs / hopMs));
  const env = [], tMs = [];
  for (let i = 0; i < steps; i++) {
    const at = start + i * hop;
    let s = 0, n = 0;
    for (let k = at; k < at + win && k < x.length; k++) { s += x[k] * x[k]; n++; }
    if (!n) break;
    env.push(Math.sqrt(s / n));
    tMs.push(i * hopMs);
  }
  const peak = Math.max(...env);
  return { start, tMs, lin: env, db: env.map((v) => 20 * Math.log10(v / (peak + 1e-30) + 1e-12)) };
}

export function onsetShape(x, fs, opts = {}) {
  const e = onsetEnvelope(x, fs, opts);
  const peak = Math.max(...e.lin);
  let half = e.tMs[e.tMs.length - 1];
  for (let i = 0; i < e.lin.length; i++) if (e.lin[i] >= peak * 0.5) { half = e.tMs[i]; break; }
  let peakAt = 0, best = 0;
  e.lin.forEach((v, i) => { if (v > best) { best = v; peakAt = e.tMs[i]; } });
  // Crest factor over the first 5 ms, straight from the samples.
  const n5 = Math.round(0.005 * fs);
  let pk = 0, sq = 0;
  for (let i = e.start; i < e.start + n5 && i < x.length; i++) { const a = Math.abs(x[i]); if (a > pk) pk = a; sq += x[i] * x[i]; }
  const crest = 20 * Math.log10(pk / (Math.sqrt(sq / n5) + 1e-30) + 1e-12);

  // Crest over a fixed window stops meaning anything once the rise time
  // changes: spreading energy out of the window lowers its RMS and so RAISES
  // the ratio, which reads as more click for less. What a click actually is
  // is a spike that overshoots what follows it, so measure that directly --
  // the loudest sample in the first 3 ms against the loudest in the first
  // 100 ms. A struck note is well below zero here; a click sits at zero.
  const nEarly = Math.round(0.003 * fs), nLate = Math.round(0.1 * fs);
  let pe = 0, pl = 0;
  for (let i = e.start; i < e.start + nLate && i < x.length; i++) {
    const a = Math.abs(x[i]);
    if (i < e.start + nEarly && a > pe) pe = a;
    if (a > pl) pl = a;
  }
  const clickDb = 20 * Math.log10(pe / (pl + 1e-30) + 1e-12);
  return { ...e, halfMs: half, peakMs: peakAt, crestDb: crest, clickDb };
}
