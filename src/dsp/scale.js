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
    // Aftersound T60, lengthened by 1.8x once transient damping went in. The
    // fast stage now takes the energy the static loss used to take, and with
    // the old figures the note carried on falling at the early rate for the
    // whole six seconds: measured against the Salamander C3, we were 11 dB
    // low at 6 s. These land it within 1 dB from 1 s to 6 s.
    t60Low:   [[21, 68], [36, 47], [48, 29], [60, 20], [72, 11], [84, 4.7], [96, 2.5], [108, 1.6]],
    t60High:  [[21, 4.0], [36, 3.2], [48, 2.3], [60, 1.7], [72, 1.1], [84, 0.63], [96, 0.40], [108, 0.29]],
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
    // Prompt (common-mode) T60. Measured on a Yamaha C5: C4's fundamental falls
    // at roughly 2 s while the aftersound runs on for tens of seconds.
    t60Prompt: [[21, 4.0], [36, 3.0], [48, 2.4], [60, 2.1], [72, 1.6], [84, 1.0], [108, 0.5]],
    // Unison spread in cents; the outer strings sit either side of the centre one.
    // A tuner sets a unison far tighter than this used to assume: measured
    // against a real C3, 1.0 cent here put every partial into an audible sweep.
    // Detuning sets the COHERENT part of the wobble, and only that. Partial n
    // of two strings df apart beats at n*df, so a detune wide enough to keep
    // the note alive drags the upper partials up into the rate the ear hears
    // as phasing: at 1 cent, C3's partial 7 beat at 1.02 Hz against a real
    // 0.42 Hz. Narrow enough and every partial goes still instead.
    //
    // Neither is what a piano does, because on a real instrument most of the
    // movement is not beating at all -- see tensionDrift in piano.js. With the
    // drift carrying the broadband part, detune only has to supply the slow
    // coherent layer underneath it.
    detune:   [[21, 0.0], [30, 0.14], [48, 0.23], [72, 0.37], [108, 0.60]],
    // Fractional difference in speaking length between the outer strings of a
    // unison and the centre one, from the offset of the bridge pins. Small, but
    // it is what gives each string its own inharmonicity.
    lengthSpread: [[21, 0.0015], [48, 0.0030], [108, 0.0050]],
    // Fractional spread in wire gauge across a unison: drawing tolerance.
    gaugeSpread:  [[21, 0.004], [48, 0.008], [108, 0.010]],
    // Fractional spread in where the hammer meets each string, from the strings
    // being neither parallel nor level with one another.
    strikeSpread: [[21, 0.04], [48, 0.06], [108, 0.08]],
    // Fractional difference in how hard the hammer drives each string.
    levelSpread:  [[21, 0.03], [48, 0.06], [108, 0.08]],
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
  // A fitted scale is written by the fitting pipeline and carries only the
  // curves that run measured. Any voicing curve added since it was written is
  // missing, so fall back to the defaults key by key rather than requiring
  // every stored scale to be rewritten whenever the model gains a parameter.
  if (scale !== DEFAULT_SCALE) {
    scale = { ...scale, voicing: { ...DEFAULT_SCALE.voicing, ...(scale.voicing ?? {}) } };
  }
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
    const shape = count === 1 ? [0] : count === 2 ? [-0.5, 0.5] : [-1, 0, 1];
    // Each imperfection gets its OWN pattern across the unison, because in a
    // real instrument they are unrelated: the wire is not mis-drawn by the same
    // proportion that the bridge pin is offset. Keying them all to one pattern
    // makes the three strings differ by a single scalar, which leaves their
    // partial ladders parallel -- and parallel ladders beat as one object, at
    // one rate, across the whole spectrum. That is a sweep, not a unison.
    // Zero-mean, so none of them shifts the note as a whole.
    const gShape = count === 3 ? [0.8, -1, 0.2] : shape;
    const sShape = count === 3 ? [-0.4, 1, -0.6] : shape;
    const offsets = shape.map((k) => k * detune);
    // The three strings of one note are NOT identical wire at identical length.
    // The bridge pins are offset, so their speaking lengths differ by a fraction
    // of a percent. Holding f0 and the wire fixed, a different length means a
    // different tension, hence a different inharmonicity -- and that is what
    // stops a unison sounding like a flanger. A pure cents detune alone makes
    // partial n of the three strings differ by n*df, so every partial beats at a
    // rate proportional to its own index: a spectrum swept by rising, evenly
    // spaced notches, which is exactly what a flanger is. Differing B adds an
    // n^3 term, so the partials diverge irregularly and the beating scatters
    // instead of sweeping.
    const lenSpread = lerpTable(scale.voicing.lengthSpread, midi);
    const lvlSpread = lerpTable(scale.voicing.levelSpread, midi);
    const gaugeSpread = lerpTable(scale.voicing.gaugeSpread, midi);
    const strikeSpread = lerpTable(scale.voicing.strikeSpread, midi);
    const strings = offsets.map((cents, i) => ({
      index: i,
      shape: shape[i],
      detuneCents: cents,
      // Per-string geometry, and the physics that follows from it. Drawn wire
      // holds its gauge to about a percent, and a string a percent thicker is
      // heavier, so it needs more tension for the same pitch and is stiffer
      // besides -- B goes as d^4 over T. Length and gauge therefore move the
      // partial ladder in DIFFERENT proportions, which is the point: three
      // strings that differ only by a scalar keep parallel ladders and beat as
      // one object, and that is heard as a sweep rather than as a piano.
      spec: {
        ...spec,
        lengthM: spec.lengthM * (1 + lenSpread * shape[i]),
        coreDiameterMm: spec.coreDiameterMm * (1 + gaugeSpread * gShape[i]),
      },
      // Hammers do not strike three strings equally hard, even after voicing.
      // Equal drive makes the three contributions cancel almost completely at a
      // beat null, which deepens the swing far past anything a piano does.
      drive: 1 + lvlSpread * shape[i],
      t60Low: lerpTable(scale.voicing.t60Low, midi) * (1 + 0.03 * shape[i]),
      t60High: lerpTable(scale.voicing.t60High, midi) * (1 + 0.05 * shape[i]),
      t60Damped: lerpTable(scale.voicing.t60Damped, midi),
      // Prompt decay: how fast the common (bridge-driving) mode dies.
      t60Prompt: lerpTable(scale.voicing.t60Prompt, midi),
      // The three strings of a unison are not parallel and do not sit at one
      // height, so one hammer face meets each at a slightly different fraction
      // of its speaking length. Strike position sets where the comb notch
      // falls, so each string gets its own notch and their partial amplitudes
      // stop rising and falling together.
      strikePosition: lerpTable(scale.voicing.strikePos, midi) * (1 + strikeSpread * sShape[i]),
      coupling: lerpTable(scale.voicing.coupling, midi),
      // Hammer never hits three strings at the same instant.
      contactOffsetUs: [0, 35, 70][i] ?? 0,
    }));
    // Derive at the note's nominal pitch, NOT the string's detuned one:
    // compileString applies detuneCents itself, so doing it here too doubled
    // every unison spread in the instrument.
    for (const st of strings) st.phys = derive(st.spec, f0);

    // A fitted scale supplies explicit per-note geometry and voicing, measured
    // from a real instrument, which replaces the interpolated breakpoint values.
    const ov = scale.overrides && scale.overrides[midi];
    if (ov) {
      if (ov.spec) Object.assign(spec, ov.spec);
      Object.assign(phys, derive(spec, f0));
      if (ov.strings) {
        // Fitted values are per NOTE, so they must not overwrite the per-STRING
        // spread that makes a unison a unison. Assigning them wholesale would
        // give all three strings one t60 and one length, collapsing the note to
        // a single string.
        for (const st of strings) {
          if (ov.strings.strikePosition != null) st.strikePosition = ov.strings.strikePosition;
          const k = shape[st.index];
          if (ov.strings.t60Low != null) st.t60Low = ov.strings.t60Low * (1 + 0.03 * k);
          if (ov.strings.t60High != null) st.t60High = ov.strings.t60High * (1 + 0.05 * k);
          st.spec = { ...spec, lengthM: spec.lengthM * (1 + lenSpread * k) };
          st.phys = derive(st.spec, f0);
        }
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
