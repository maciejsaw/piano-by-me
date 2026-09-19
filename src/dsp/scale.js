// Scale design: a handful of breakpoints across the compass, interpolated into
// per-string specs for all 88 notes. Hand-editing 264 strings is not viable;
// this is the authoring layer, with per-string overrides on top.
//
// Design inputs are TENSION and WIRE GAUGE; speaking length is derived from
// L = sqrt(T/mu) / (2 f0). That is how real scaling works and it keeps tensions
// physical by construction. Where the derived length exceeds the case size, the
// wrap is made heavier instead -- exactly what piano makers do in the bass.

import { MATERIALS, noteHz, noteName, derive, linearDensity } from './physics.js';

export const DEFAULT_SCALE = {
  name: 'Model X — medium grand',
  a4: 440,
  // Stretch tuning, cents on top of equal temperament. Real pianos are tuned to
  // their own inharmonicity, not to a calculator: octaves are widened so upper
  // partials of the lower note line up with the higher note, which pulls the
  // bass flat and the treble sharp (the Railsback curve). Empty = dead equal.
  tuningCents: [],
  maxLengthM: 1.95,                 // longest string the case allows
  breakpoints: [
    // midi, core wire (mm), wound?, wrap outer (mm), target tension (N), strings
    { midi: 21,  core: 1.35, wound: true,  wrap: 3.20, tension: 700, strings: 1 },
    { midi: 27,  core: 1.30, wound: true,  wrap: 2.70, tension: 720, strings: 2 },
    { midi: 33,  core: 1.22, wound: true,  wrap: 2.15, tension: 740, strings: 2 },
    { midi: 39,  core: 1.15, wound: true,  wrap: 1.72, tension: 750, strings: 3 },
    { midi: 46,  core: 1.10, wound: true,  wrap: 1.40, tension: 750, strings: 3 },
    { midi: 52,  core: 1.08, wound: true,  wrap: 1.22, tension: 740, strings: 3 },
    { midi: 53,  core: 1.05, wound: false, wrap: 0,    tension: 735, strings: 3 },  // wound -> plain
    { midi: 60,  core: 1.00, wound: false, wrap: 0,    tension: 720, strings: 3 },
    { midi: 72,  core: 0.95, wound: false, wrap: 0,    tension: 710, strings: 3 },
    { midi: 84,  core: 0.90, wound: false, wrap: 0,    tension: 700, strings: 3 },
    { midi: 96,  core: 0.85, wound: false, wrap: 0,    tension: 690, strings: 3 },
    { midi: 108, core: 0.80, wound: false, wrap: 0,    tension: 670, strings: 3 },
  ],
  // Voicing curves, interpolated the same way (midi -> value).
  voicing: {
    t60Low:   [[21, 38], [36, 26], [48, 16], [60, 11], [72, 6.0], [84, 2.6], [96, 1.4], [108, 0.9]],
    t60High:  [[21, 2.2], [36, 1.8], [48, 1.3], [60, 0.95], [72, 0.6], [84, 0.35], [96, 0.22], [108, 0.16]],
    t60Damped:[[21, 0.30], [48, 0.18], [72, 0.10], [108, 0.06]],
    strikePos:[[21, 0.125], [36, 0.122], [60, 0.115], [84, 0.10], [108, 0.085]],
    // Felt hardness, calibrated so hammer contact times match measured pianos
    // (~4.6 ms at A0 down to ~0.55 ms at C8). Contact time is what sets
    // brightness, so this curve matters more to the sound than almost anything
    // else here. The dip in the low bass follows the bass/treble bridge break.
    hardness: [[21, 0.215], [30, 0.027], [39, 0.000], [48, 0.049], [57, 0.064],
               [66, 0.117], [75, 0.240], [84, 0.334], [93, 0.395], [102, 0.354],
               [108, 0.453]],
    // Base hammer mass, kg (scaled down by hardness below). ~10 g bass, ~3 g top.
    hammerMass: [[21, 0.0120], [36, 0.0098], [48, 0.0085], [60, 0.0072],
                 [72, 0.0062], [84, 0.0053], [96, 0.0045], [108, 0.0039]],
    // How strongly each string is tied to the bridge, relative to the global
    // coupling setting. Bass strings drive the board hardest.
    coupling: [[21, 0.9], [36, 1.0], [60, 1.0], [84, 0.75], [108, 0.5]],
    // Measured calibration: flattens peak output across the compass to ~7% at a
    // fixed velocity. Voice from here; it is a baseline, not a target.
    gain:     [[21, 3.22], [27, 1.13], [33, 1.74], [39, 1.08], [46, 0.91], [53, 0.81],
               [60, 0.82], [67, 1.09], [74, 1.27], [81, 1.77], [88, 2.62], [95, 1.83],
               [102, 1.49], [108, 1.25]],
    // Unison spread in cents; the outer strings sit either side of the centre one.
    detune:   [[21, 0.0], [30, 0.6], [48, 1.0], [72, 1.6], [108, 2.6]],
  },
  // Lowest notes on a grand have no dampers at all.
  lowestDamped: 29,
};

const lerpTable = (table, midi) => {
  if (midi <= table[0][0]) return table[0][1];
  const last = table[table.length - 1];
  if (midi >= last[0]) return last[1];
  for (let i = 0; i < table.length - 1; i++) {
    const [m0, v0] = table[i], [m1, v1] = table[i + 1];
    if (midi >= m0 && midi <= m1) return v0 + (v1 - v0) * ((midi - m0) / (m1 - m0));
  }
  return last[1];
};

function interpBreakpoints(bps, midi) {
  if (midi <= bps[0].midi) return { ...bps[0] };
  const last = bps[bps.length - 1];
  if (midi >= last.midi) return { ...last };
  for (let i = 0; i < bps.length - 1; i++) {
    const a = bps[i], b = bps[i + 1];
    if (midi >= a.midi && midi <= b.midi) {
      const t = (midi - a.midi) / (b.midi - a.midi);
      const mix = (x, y) => x + (y - x) * t;
      // Wound-ness and string count step rather than blend.
      const wound = t < 1 ? a.wound : b.wound;
      return {
        midi,
        core: mix(a.core, b.core),
        wound,
        wrap: wound ? mix(a.wrap || b.wrap, b.wrap || a.wrap) : 0,
        tension: mix(a.tension, b.tension),
        strings: t < 1 ? a.strings : b.strings,
      };
    }
  }
  return { ...last };
}

/** Solve the wrap outer diameter that yields a required linear density. */
function wrapForDensity(muWanted, coreMm) {
  const core = MATERIALS.steel, wrap = MATERIALS.copper;
  const rc = coreMm * 1e-3 / 2;
  const muCore = core.rho * Math.PI * rc * rc;
  const need = muWanted - muCore;
  if (need <= 0) return 0;
  // need = rho_w * pi * (ro^2 - rc^2) * packing
  const ro2 = need / (wrap.rho * Math.PI * 0.80) + rc * rc;
  return 2 * Math.sqrt(ro2) * 1e3;
}

/** Build the full instrument spec: 88 notes, each with 1-3 string specs. */
export function buildScale(scale = DEFAULT_SCALE) {
  const notes = [];
  for (let midi = 21; midi <= 108; midi++) {
    const bp = interpBreakpoints(scale.breakpoints, midi);
    const stretch = scale.tuningCents && scale.tuningCents.length
      ? lerpTable(scale.tuningCents, midi) : 0;
    const f0 = noteHz(midi, scale.a4) * Math.pow(2, stretch / 1200);

    let spec = {
      lengthM: 0,
      coreDiameterMm: bp.core,
      wound: bp.wound,
      wrapOuterDiameterMm: bp.wrap,
      coreMaterial: 'steel',
      wrapMaterial: 'copper',
    };
    let mu = linearDensity(spec);
    let L = Math.sqrt(bp.tension / mu) / (2 * f0);

    if (L > scale.maxLengthM) {
      // Case is too short: add winding mass until the target tension fits.
      L = scale.maxLengthM;
      const muNeeded = bp.tension / Math.pow(2 * L * f0, 2);
      spec.wound = true;
      spec.wrapOuterDiameterMm = wrapForDensity(muNeeded, bp.core);
      mu = linearDensity(spec);
    }
    spec.lengthM = L;

    const phys = { ...derive(spec, f0) };
    const detune = lerpTable(scale.voicing.detune, midi);
    const count = bp.strings;

    // Unison spread: centre string at nominal, outers either side.
    const offsets = count === 1 ? [0] : count === 2 ? [-detune / 2, detune / 2]
                                                    : [-detune, 0, detune];
    const strings = offsets.map((cents, i) => ({
      index: i,
      detuneCents: cents,
      t60Low: lerpTable(scale.voicing.t60Low, midi) * (1 + 0.03 * (i - 1)),
      t60High: lerpTable(scale.voicing.t60High, midi) * (1 + 0.05 * (i - 1)),
      t60Damped: lerpTable(scale.voicing.t60Damped, midi),
      strikePosition: lerpTable(scale.voicing.strikePos, midi),
      coupling: lerpTable(scale.voicing.coupling, midi),
      // Hammer never hits three strings at the same instant.
      contactOffsetUs: [0, 35, 70][i] ?? 0,
    }));

    // A fitted scale supplies explicit per-note geometry and voicing, measured
    // from a real instrument, which replaces the interpolated breakpoint values.
    const ov = scale.overrides && scale.overrides[midi];
    if (ov) {
      if (ov.spec) Object.assign(spec, ov.spec);
      Object.assign(phys, derive(spec, f0));
      if (ov.strings) {
        for (let i = 0; i < strings.length; i++) Object.assign(strings[i], ov.strings);
      }
    }

    notes.push({
      midi, name: noteName(midi), f0,
      spec, phys,
      count, strings,
      hardness: (ov && ov.hardness != null) ? ov.hardness : lerpTable(scale.voicing.hardness, midi),
      hammerMass: lerpTable(scale.voicing.hammerMass, midi)
                  * Math.pow(10, -0.35 * lerpTable(scale.voicing.hardness, midi)),
      feltK: 3e9 * Math.pow(10, 2 * lerpTable(scale.voicing.hardness, midi)),
      feltP: 2.5,
      // String wave impedance: what the hammer actually pushes against.
      Z: Math.sqrt(phys.T * phys.mu),
      gain: lerpTable(scale.voicing.gain, midi),
      hasDamper: midi >= scale.lowestDamped,
    });
  }
  return { scale, notes };
}
