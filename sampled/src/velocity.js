// Velocity response: how hard you hit and what comes out.
//
// A sampled piano has to answer two questions from one number, and the usual
// mistake is to answer them with one mechanism. They are:
//
//   how loud    a real grand runs 35-45 dB from pianissimo to fortissimo
//   how bright  which is not a filter, it is which recording gets played --
//               a hammer striking harder makes a different spectrum, not a
//               louder one
//
// Salamander's sixteen layers answer the second question perfectly and the
// first one only partly: measured across the library, the peak level of layer
// 1 is about 18 dB below layer 16, not 42. That is not a flaw in the
// recordings, it is how a piano works -- most of the dynamic range of a real
// instrument is in the spectrum, and the microphone's own range is narrower
// than the ear's impression of it. The SFZ covers the gap with a blanket
// amp_veltrack; this covers it per key, on a curve you can draw.
//
// So the two are separated:
//
//   layer  = which recording, from velocity through a per-key bias
//   gain   = the level the curve asked for, MINUS the level that recording
//            already has (measured, in the manifest)
//
// which means changing the curve never changes the timbre, and changing the
// layer bias never changes the level.

/** Level in dB relative to fortissimo, for velocity v on a curve (dyn, gamma). */
export function levelDb(v, dyn, gamma) {
  const u = Math.max(1, Math.min(127, v)) / 127;
  return dyn * (1 - Math.pow(u, gamma));
}

/**
 * Which of the recorded layers a velocity reaches for.
 *
 * Salamander's own velocity split is uneven -- layer 3 covers velocities 35
 * and 36 and nothing else -- because it was drawn against that instrument's
 * action. Following it exactly reproduces the library; `bias` is how you
 * disagree, in layers, and it is a per-key curve because one key being a
 * little too eager is a real thing that happens.
 */
export function pickLayer(v, hivel, layers, bias = 0) {
  let i = 0;
  while (i < hivel.length - 1 && v > hivel[i]) i++;
  const wanted = i + 1 + bias;
  let best = layers[0], bd = 1e9;
  for (const l of layers) { const d = Math.abs(l - wanted); if (d < bd) { bd = d; best = l; } }
  return best;
}

/**
 * Everything the engine needs for one note-on.
 *
 * `trimDb` from the library (for having had to settle for a neighbouring
 * layer) is folded in here rather than at the voice, so that a substitution
 * while a sample is still downloading is exactly level-matched and only the
 * timbre is approximate.
 */
export function plan(curves, lib, midi, vel, extraBias = 0) {
  const dyn = curves.at('dynamic', midi);
  const gamma = Math.max(0.15, curves.at('gamma', midi));
  const bias = Math.round(curves.at('layerBias', midi)) + extraBias;
  const want = pickLayer(vel, lib.m.hivel, lib.layers, bias);
  const got = lib.best(midi, want);
  if (!got) return null;

  const target = levelDb(vel, dyn, gamma) + curves.at('trim', midi);
  const already = lib.relDb[midi]?.[got.layer] ?? 0;
  return {
    buf: got.buf,
    layer: got.layer,
    exact: got.layer === want,
    // gain restores the recording's true level, then moves it to where the
    // curve asked for it
    gain: got.entry.gain * Math.pow(10, (target - already) / 20),
    targetDb: target,
  };
}
