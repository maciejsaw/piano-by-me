// Scale design: a handful of breakpoints across the compass, interpolated into
// per-string specs for all 88 notes. Hand-editing 264 strings is not viable;
// this is the authoring layer, with per-string overrides on top.
//
// Design inputs are TENSION and WIRE GAUGE; speaking length is derived from
// L = sqrt(T/mu) / (2 f0). That is how real scaling works and it keeps tensions
// physical by construction. Where the derived length exceeds the case size, the
// wrap is made heavier instead -- exactly what piano makers do in the bass.

import { MATERIALS, noteHz, noteName, derive, linearDensity } from './physics.js';
import { NO_OFFSETS } from './offsets.js';

export const DEFAULT_SCALE = {
  name: 'Medium grand',
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
    // Hand-voiced: x2^-0.2295 on the fitted figures (0.30 / 0.18 / 0.10 / 0.06).
    t60Damped:[[21, 0.2559], [48, 0.1535], [72, 0.0853], [108, 0.0512]],
    strikePos:[[21, 0.125], [36, 0.122], [60, 0.115], [84, 0.10], [108, 0.085]],
    // Felt hardness, solved per note so contact duration lands on the curve
    // real hammers measure -- 4.5 ms at A0 falling to 0.5 ms at C8, with C4
    // at the 2 ms everybody reports. Contact duration is what decides how far
    // up the ladder a strike reaches, so this matters more to the sound than
    // almost anything else here.
    //
    // It is solved rather than set by hand (tools/fit/fit-hardness.mjs),
    // because it has to be re-solved whenever the felt stiffness or the
    // velocity curve moves. Both moved, and the hand-set curve went with
    // them: contact flattened to 1.5-2.7 ms across the whole keyboard, three
    // times too SHORT at A0 -- a sharp pulse on a long string, heard as a
    // metallic zing -- and eleven times the string's period at C8, where the
    // felt then lies on the string through eleven round trips damping what it
    // just excited, heard as a hammer far too big for the note.
    //
    // Against the period it now runs from a tenth at A0 to about two at C8,
    // which is the shape a real action has.
    hardness: [[21, -0.746], [27, -0.654], [33, -0.514], [39, -0.418], [45, -0.288],
               [51, -0.196], [57, -0.080], [63, 0.075], [69, 0.295], [75, 0.525],
               [81, 0.761], [87, 1.010], [93, 1.288], [99, 1.583], [105, 1.872],
               [108, 2.024]],
    // Felt nonlinearity exponent. Measured hammers run about 2.3 in the bass
    // to 3.0 and above in the treble, where the covering is thinner
    // (Chaigne & Askenfelt give C2 2.3, C4 2.5, C7 3.0). It was fixed at 2.5
    // keyboard-wide, which makes the bass hammer too nonlinear and the treble
    // not nonlinear enough.
    feltP: [[21, 2.3], [36, 2.4], [60, 2.5], [84, 2.8], [96, 3.0], [108, 3.2]],
    // How much of the felt's stiffness is hysteretic rather than elastic.
    // Fitted on C4's attack ladder against the sample; real hammers measure
    // near 1, and 0.97 is what the fit asks for.
    feltEps: [[21, 0.97], [60, 0.97], [108, 0.97]],
    // Width of the contact patch, mm. Sets a lowpass at about c/(2*width),
    // which lands among the partials in the bass and above hearing on top.
    hammerWidthMm: [[21, 14], [36, 11], [60, 7], [84, 5], [108, 3.5]],
    // Arrival spread across the strings of one unison, microseconds. The
    // strings are not perfectly level with the hammer face, so the felt
    // reaches them a fraction of a millisecond apart.
    //
    // Measured, not guessed: the first 5 ms of a real C4 has a crest factor of
    // 7.3 dB and ours had 10.0, which is the click. Three strings landing
    // together make one sharp edge; three landing a little apart make a
    // strike. Widened again, to about 1.2 ms at C4, at the point on the
    // softness ladder chosen by ear.
    strikeOffsetUs: [[21, 2390], [48, 1550], [72, 955], [108, 540]],
    // How the string's high end BUILDS after the strike, per note.
    //
    // The transient-damping stage is a high-frequency loss that fades after
    // the strike, which is the same thing as a high end that fades in. Which
    // way it should point depends on the string. On a thick wound bass string
    // the top should not be there at contact at all and should grow in as the
    // winding lets go; from about C2 up the strike should keep its top and
    // the damping arrive behind it.
    //
    // Measured at A0, in the 2-6 kHz band that the zing lives in, against the
    // fundamental region: the real note sits at -29 to -35 dB and holds
    // there, and ours sat at -17 to -21, ten to thirteen decibels too bright
    // at every instant. Damping at contact, releasing over 80 ms, takes it to
    // -24 to -30. The same setting at C2 takes that note from -26, which is
    // right, to -43, which is not -- so it has to be a curve, not a constant.
    //
    // transientTauS is now the WHOLE length of the build, not an exponential
    // time constant, since the release became a smootherstep. At A0 a 200 ms
    // build tracks the real note within a few dB at every instant measured;
    // longer over-damps the tail badly (-45 dB at 200 ms against a real -31).
    transientDepth: [[21, 0.95], [27, 0.60], [33, 0.20], [36, 0.090], [108, 0.090]],
    transientRiseS: [[21, 0.0005], [33, 0.020], [36, 0.040], [108, 0.040]],
    transientTauS:  [[21, 0.070], [36, 0.150], [108, 0.150]],
    // How far the release is pushed toward the end of the build. At 1 it is a
    // symmetric S; at 6 the damping is still 99 per cent of full halfway
    // through and most of the release happens in the last tenth, so the note
    // holds dark and then opens rather than opening steadily.
    //
    // The skew does NOT cut the start, and that is worth knowing before
    // reaching for it: at phase zero the damping is at full depth whatever
    // the shape, so only transientDepth reaches the first milliseconds.
    // Skewing changes the middle and the end, and it stretches the effective
    // length about threefold, which is why transientTauS came down with it.
    transientSkew:  [[21, 6], [108, 6]],
    // The knock: how much of the blow goes round the string to the board.
    //
    // A heavy bass hammer shakes the bridge hard and a 3 g treble hammer
    // barely at all, so this falls steeply. The noise half is the felt
    // crushing and the action arriving; it is lowpassed, because what a big
    // plate does with a tap is low.
    // SOLVED, not set -- tools/fit/fit-knock.mjs, at 18 dB under each note's
    // own peak (12 was the first fit; the ear halved it). Re-solved after the
    // tone changed, because cutting the top of the noise also cuts its level. Hand-scaling this fixed C4 and left A0 forty decibels out,
    // because how loud a knock sounds against its note is not proportional to
    // the blow: the transient stage takes nearly all of the bass string's
    // first milliseconds away, so the same knock stands right out at A0 and
    // hides under C4. The curve is bumpy in the treble for that reason. It is
    // compensation for the note, not a property of the hammer, and smoothing
    // it would put the unevenness back into what you hear.
    //
    // knockNoise carries the same fitted scale as knockGain; the ratio
    // between them is the voicing, the common factor is the level.
    knockGain:  [[21, 0.0392], [27, 0.0278], [33, 0.0216], [39, 0.0209], [45, 0.0272], [51, 0.0236], [57, 0.00917], [63, 0.0125], [69, 0.00941], [75, 0.0124], [81, 0.0139], [87, 0.0153], [93, 0.0356], [99, 0.0655], [105, 0.0383], [108, 0.016]],
    knockNoise: [[21, 0.0498], [27, 0.0384], [33, 0.033], [39, 0.0353], [45, 0.0506], [51, 0.0488], [57, 0.0214], [63, 0.0329], [69, 0.0281], [75, 0.0415], [81, 0.0524], [87, 0.0626], [93, 0.153], [99, 0.294], [105, 0.184], [108, 0.0797]],
    knockDecayS: [[21, 0.035], [48, 0.024], [72, 0.014], [108, 0.008]],
    // Corner of the noise lowpass, which is three poles deep. Far lower than
    // it looks it should be, for three reasons that stack: three poles reach
    // a long way down from their corner, the radiation EQ lifts 2-8 kHz on
    // the way out, and the ear picked the darkest take on offer at every note
    // when the takes were level-matched so that darker could not win by being
    // quieter. 156 Hz at the bottom of the keyboard is not a typo.
    knockFc:     [[21, 156], [48, 252], [72, 420], [108, 720]],
    // The oomph. One low resonance, because that is what a big heavy plate
    // answers a tap with. It belongs to the BOARD, not to the note, so it
    // barely moves across the keyboard -- what little it does is the strike
    // being nearer the stiffer treble end of the bridge. The mix is high: at
    // 3 the resonance is most of what the noise half contributes, which is
    // the point, since a knock that is broadband is a hiss.
    knockThumpHz:  [[21, 85], [60, 110], [108, 150]],
    knockThumpQ:   [[21, 1.8], [108, 1.4]],
    knockThumpMix: [[21, 3.0], [108, 3.0]],
    // Spread of hammer mass and of delivered force across the unison.
    hammerMassSpread: [[21, 0.02], [108, 0.04]],
    hammerForceSpread: [[21, 0.03], [108, 0.06]],
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
    // Hand-voiced: x2^0.368 on 0.0015 / 0.0030 / 0.0050.
    lengthSpread: [[21, 0.001936], [48, 0.003872], [108, 0.006453]],
    // Fractional spread in wire gauge across a unison: drawing tolerance.
    gaugeSpread:  [[21, 0.004], [48, 0.008], [108, 0.010]],
    // Fractional spread in where the hammer meets each string, from the strings
    // being neither parallel nor level with one another.
    strikeSpread: [[21, 0.04], [48, 0.06], [108, 0.08]],
    // Fractional difference in how hard the hammer drives each string.
    levelSpread:  [[21, 0.03], [48, 0.06], [108, 0.08]],
  },
  // Every bass note on a grand is damped; it is the top of the compass --
  // above E6 on the C5, where the strings die on their own within a couple of
  // seconds -- that has no dampers. (This used to be read the other way round,
  // which left everything below F1 ringing for as long as its T60 allowed.)
  lowestDamped: 21,
  highestDamped: 88,
};

export const lerpTable = (table, midi) => {
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
export function buildScale(scale = DEFAULT_SCALE, edits = NO_OFFSETS) {
  // A fitted scale is written by the fitting pipeline and carries only the
  // curves that run measured. Any voicing curve added since it was written is
  // missing, so fall back to the defaults key by key rather than requiring
  // every stored scale to be rewritten whenever the model gains a parameter.
  if (scale !== DEFAULT_SCALE) {
    scale = { ...scale, voicing: { ...DEFAULT_SCALE.voicing, ...(scale.voicing ?? {}) } };
  }
  const notes = [];
  for (let midi = 21; midi <= 108; midi++) {
    // Every voicing lookup goes through here, so an editor offset reaches all
    // of them without each one having to know it exists. Zero is exactly the
    // shipped curve -- see offsets.js.
    const V = (name) => edits.apply(name, midi, lerpTable(scale.voicing[name], midi));
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
    const detune = V('detune');
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
    const lenSpread = V('lengthSpread');
    const lvlSpread = V('levelSpread');
    const gaugeSpread = V('gaugeSpread');
    const strikeSpread = V('strikeSpread');
    // Clamped to a fraction of the period: an offset approaching a whole
    // period is not a misaligned string any more, it is a second strike.
    const offsetUs = Math.min(V('strikeOffsetUs'), 0.2 * 1e6 / f0) / 2.2;
    const massSpread = V('hammerMassSpread');
    const forceSpread = V('hammerForceSpread');
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
      t60Low: V('t60Low') * (1 + 0.03 * shape[i]),
      t60High: V('t60High') * (1 + 0.05 * shape[i]),
      t60Damped: V('t60Damped'),
      // Prompt decay: how fast the common (bridge-driving) mode dies.
      t60Prompt: V('t60Prompt'),
      // The three strings of a unison are not parallel and do not sit at one
      // height, so one hammer face meets each at a slightly different fraction
      // of its speaking length. Strike position sets where the comb notch
      // falls, so each string gets its own notch and their partial amplitudes
      // stop rising and falling together.
      strikePosition: V('strikePos') * (1 + strikeSpread * sShape[i]),
      coupling: V('coupling'),
      // Hammer never hits three strings at the same instant.
      contactOffsetUs: offsetUs * [0, 1, 2.2][i] ?? 0,
      hammerMassScale: 1 + massSpread * gShape[i],
      hammerForceScale: 1 + forceSpread * sShape[i],
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
      hardness: (ov && ov.hardness != null) ? ov.hardness : V('hardness'),
      hammerMass: V('hammerMass')
                  * Math.pow(10, -0.35 * V('hardness')),
      feltK: 1.8e9 * Math.pow(10, 2 * V('hardness')),
      feltP: V('feltP'),
      feltEps: V('feltEps'),
      transientDepth: V('transientDepth'),
      transientRiseS: V('transientRiseS'),
      transientTauS: V('transientTauS'),
      transientSkew: V('transientSkew'),
      hammerWidthM: V('hammerWidthMm') * 1e-3,
      knockGain: V('knockGain'),
      knockNoise: V('knockNoise'),
      knockDecayS: V('knockDecayS'),
      knockFc: V('knockFc'),
      knockThumpHz: V('knockThumpHz'),
      knockThumpQ: V('knockThumpQ'),
      knockThumpMix: V('knockThumpMix'),
      // String wave impedance: what the hammer actually pushes against.
      Z: Math.sqrt(phys.T * phys.mu),
      gain: V('gain'),
      hasDamper: midi >= scale.lowestDamped && midi <= (scale.highestDamped ?? 108),
    });
  }
  return { scale, notes };
}
