// Hammer–string contact.
//
// The force pulse is obtained by integrating the real nonlinear contact:
//
//     F = K * d^p                       (Hertzian felt compression)
//     m * dv_h/dt = -F                  (hammer decelerates)
//     v_s = F / (2Z)                    (string point yields at its wave impedance)
//     dd/dt = v_h - v_s                 (compression closes at the difference)
//
// The string is treated as semi-infinite during contact, i.e. waves reflected
// from the terminations are ignored while the hammer is touching. That is the
// one approximation here, and it is a mild one for a contact lasting ~1-2 ms.
// Everything that matters perceptually falls out on its own: contact time
// shortens as the blow gets harder, so loud notes are brighter as well as
// louder, and the felt's nonlinearity puts energy into high partials that a
// fixed pulse shape simply cannot produce.
//
// A smooth analytic pulse (a raised cosine, say) is much cheaper but its first
// spectral null sits around 800 Hz for a 1 ms contact, which buries every
// partial above the 4th and sounds like a felt mallet rather than a piano.

// The contact ODE is stiff: felt stiffness is enormous and the hammer can
// reverse within microseconds on a hard blow, so it needs heavy oversampling
// to stay accurate. It runs once per note-on, never in the audio loop.
const OS = 64;

/**
 * Integrate one hammer strike; returns the force pulse in newtons.
 *
 * The string is loaded at the strike point by its wave impedance Z, PLUS the
 * inverted wave returning from the near termination (the agraffe), which is only
 * `strikeDelay` samples away. That reflection is what actually throws the hammer
 * off the string: against a purely resistive load the hammer just sinks in and
 * decays asymptotically, giving contact times several times too long and a dull,
 * mallet-like tone. With the reflection included, contact ends crisply and the
 * spectrum reaches the high partials a piano actually has.
 */
function contact(fs, { mass, K, p, Z, velocity, strikeDelay, maxMs = 12, eps = 0, tauUs = 2 }) {
  const dt = 1 / (fs * OS);
  // Felt is not a spring. Measured force-compression curves of real hammers
  // are hysteresis loops: the felt pushes back harder going in than coming
  // out, because the wool fibres slip against each other and do not spring
  // back. Stulov's model puts this as a history-dependent stiffness,
  //
  //   F = F0 [ u^p  -  (eps/tau0) * exp(-t/tau0) (*) u^p ]
  //
  // and that convolution with a decaying exponential is exactly a one-pole
  // lowpass of u^p, which costs one multiply-add per step. eps is how much of
  // the felt's stiffness is hysteretic (real hammers sit near 1) and tau0 the
  // relaxation time, a couple of microseconds against a contact of one or two
  // milliseconds.
  //
  // At eps near 1 the bracket is a small difference of large numbers, so the
  // effective stiffness collapses; K is divided by (1 - eps) to compensate.
  // That keeps eps a knob for the SHAPE of the contact and not for how loud
  // the note is, which is what makes it fittable.
  const aH = Math.exp(-dt / Math.max(tauUs * 1e-6, dt));
  const Keff = K / Math.max(1 - eps, 1e-3);
  let hyst = 0;
  const maxSteps = Math.round(fs * OS * maxMs * 1e-3);
  const out = [], comp = [];

  // Ring buffer holding the outgoing wave, for the round trip to the agraffe.
  const rt = Math.max(1, Math.round(strikeDelay * OS));
  const ring = new Float64Array(rt);
  let rp = 0;

  let d = 0, vh = velocity, acc = 0, accD = 0, sub = 0, touched = false;
  for (let i = 0; i < maxSteps; i++) {
    const u = d > 0 ? Math.pow(d, p) : 0;
    hyst = u + (hyst - u) * aH;
    const F = Math.max(0, Keff * (u - eps * hyst));
    if (F > 0) touched = true;
    const outgoing = F / (2 * Z);
    const reflected = ring[rp];              // inverted on return from the agraffe
    ring[rp] = outgoing;
    rp = (rp + 1) % rt;

    const vs = outgoing - reflected;
    vh -= (F / mass) * (dt * 0.5);
    d += (vh - vs) * dt;
    vh -= (F / mass) * (dt * 0.5);

    acc += F;
    accD += d > 0 ? d : 0;
    if (++sub === OS) { out.push(acc / OS); comp.push(accD / OS); acc = 0; accD = 0; sub = 0; }
    if (touched && d <= 0) break;            // felt lets go
  }
  if (sub > 0) { out.push(acc / sub); comp.push(accD / sub); }
  while (out.length && out[out.length - 1] === 0) { out.pop(); comp.pop(); }
  return { force: out, comp };
}

/** Contact duration in ms, for checking a voicing against reality. */
export function contactMs(fs, params) {
  return (contact(fs, params).force.length / fs) * 1000;
}

/**
 * Build the excitation for one strike.
 * Returns a velocity-wave pulse, already comb-filtered for strike position.
 */
export function makeHammerPulse(fs, f0, velocity, opts = {}) {
  const Z = opts.Z ?? 2;
  // The hammer strikes every string of the unison at once, so its dynamics see
  // the COMBINED impedance while each individual string receives its own share.
  // Loading the hammer with a single string's impedance makes contact ~3x too
  // long, which alone is enough to make the whole instrument sound like felt.
  const Zload = Z * (opts.strings ?? 1);
  const mass = opts.mass ?? 0.005;
  const p = opts.p ?? 2.5;
  const K = opts.K ?? 1e9;
  const strikeDelay = opts.strikeDelay ?? 8;
  const gain = opts.gain ?? 1;
  const eps = opts.feltEps ?? 0;
  const tauUs = opts.feltTauUs ?? 2;
  // The hammer touches a patch of string, not a point. The patch is a few
  // millimetres wide and the wave crosses it in width / c seconds, so the
  // excitation is smeared over that long -- a lowpass whose corner sits near
  // c / (2 * width). In the treble c is high and the patch is small, so the
  // corner is far above hearing and this does nothing. In the bass c is a
  // third of that and the felt is wider, which puts the corner down among the
  // partials the note actually has.
  const smear = Math.max(0, opts.widthSamples ?? 0);

  // MIDI velocity -> hammer speed. Real range is roughly 0.2 m/s (ppp) to
  // 6 m/s (fff), and the curve is strongly exponential.
  //
  // Squared inside the exponential rather than raw, which was chosen by ear:
  // at a normal playing velocity the blow was landing too hard -- 2.38 m/s at
  // 0.75, where the note wanted about 1.23 -- and the fix has to leave the top
  // of the range alone, since fff is not too loud. Squaring does exactly that:
  // it is the identity at 1.0 and takes half a metre per second out of the
  // middle, which also spreads the dynamics rather than compressing them.
  const v = 0.18 * Math.pow(velocity, 0.15) * Math.exp(3.5 * velocity * velocity);

  const { force, comp } = contact(fs, { mass, K, p, Z: Zload, velocity: v, strikeDelay, eps, tauUs });
  const n = force.length;
  if (!n) return new Float64Array(0);

  // Force -> velocity wave injected into the string, then the strike-position
  // comb: the string is driven at one point, so every partial with a node there
  // is cancelled. This is why alpha ~ 1/8 notches out the 8th partial.
  const out = new Float64Array(n + strikeDelay);
  const scale = gain / (2 * Z);
  for (let i = 0; i < n; i++) {
    const s = force[i] * scale;
    out[i] += s;
    out[i + strikeDelay] -= s;
  }
  return smear > 0.25 ? spread(out, smear, comp, strikeDelay) : out;
}

/**
 * Smear the injection over the contact patch -- and let the patch GROW as the
 * felt sinks in.
 *
 * Felt does not meet the string on one flat face. It wraps: the deeper the
 * string presses in, the further round it the felt closes, so the area in
 * contact is smallest at first touch and largest at peak compression. Taking
 * the patch as fixed misses that, and misses it exactly where it matters,
 * because the widest patch coincides with the largest force.
 *
 * The half-width of contact between a cylinder and a compliant surface goes as
 * the square root of the indentation, so the kernel is scaled by
 * sqrt(d / dMax). The effect on the sound is to round off the top of the
 * pulse while leaving its edges alone, which is what takes the click out.
 */
function spread(x, samples, comp, offset) {
  const dMax = Math.max(...comp, 1e-12);
  const mMax = Math.max(1, Math.round(samples));
  const out = new Float64Array(x.length + mMax);
  const k = new Float64Array(mMax);
  for (let i = 0; i < x.length; i++) {
    // The pulse carries the force and, `offset` later, its own inversion from
    // the agraffe; both are the same blow, so both see the same patch.
    const d = comp[Math.min(i, comp.length - 1)] ?? 0;
    const dOff = comp[Math.min(Math.max(i - offset, 0), comp.length - 1)] ?? 0;
    const m = Math.max(1, Math.round(mMax * Math.sqrt(Math.max(d, dOff) / dMax)));
    let sum = 0;
    for (let j = 0; j < m; j++) { k[j] = 0.5 * (1 - Math.cos((2 * Math.PI * (j + 1)) / (m + 1))); sum += k[j]; }
    for (let j = 0; j < m; j++) out[i + j] += (x[i] * k[j]) / sum;
  }
  return out;
}

/**
 * The part of the blow that never becomes a note.
 *
 * A hammer does not only set a string ringing. It arrives with momentum, and
 * the string is a light thing tied at both ends to a heavy one: most of that
 * momentum passes straight through to the bridge and shakes the soundboard
 * directly. You hear it as a low, noisy knock under the partials, loudest in
 * the bass where the hammer is heaviest -- close to the sound of somebody
 * tapping the soundboard, which is exactly what it is. Without it a model has
 * nothing between the strike and the tone, and the tone has to account for the
 * whole of the attack on its own.
 *
 * Two parts, from the same blow:
 *
 *   force   the contact force itself, highpassed. A plate cannot radiate a
 *           steady push, so what reaches the air is the RATE the force
 *           changes -- take the DC out and a unipolar squash becomes a thud.
 *   noise   the felt crushing, the string sliding across it, the action
 *           arriving. Broadband, lowpassed, and gone in a few tens of
 *           milliseconds. Deterministic from `seed` so renders repeat.
 *
 * `pulse` is the string excitation, which is proportional to the contact
 * force, so the knock automatically tracks velocity, felt and contact time
 * instead of needing its own copy of them.
 */
export function makeKnock(fs, pulse, opts = {}) {
  const gain = opts.gain ?? 0;
  const noiseAmt = opts.noise ?? 0;
  const decayS = opts.decayS ?? 0.02;
  const fc = opts.fc ?? 800;
  const hpFc = opts.hpFc ?? 45;
  const thumpHz = opts.thumpHz ?? 110;
  const thumpQ = opts.thumpQ ?? 1.6;
  const thumpMix = opts.thumpMix ?? 0;
  const poles = Math.max(1, Math.min(3, Math.round(opts.poles ?? 3)));
  if (gain <= 0 && noiseAmt <= 0) return null;

  const tail = Math.ceil(decayS * 4 * fs);
  const n = pulse.length + tail;
  const out = new Float64Array(n);

  // One-pole highpass: y = a*(y + x - x1), a set by hpFc.
  const aHp = 1 / (1 + (2 * Math.PI * hpFc) / fs);
  let yH = 0, x1 = 0, peak = 0;
  for (let i = 0; i < n; i++) {
    const x = pulse[i] ?? 0;
    yH = aHp * (yH + x - x1);
    x1 = x;
    out[i] = gain * yH;
    if (Math.abs(x) > peak) peak = Math.abs(x);
  }

  if (noiseAmt > 0 && peak > 0) {
    // THREE poles, not one. A single pole rolls off at 6 dB an octave, which
    // leaves a clearly audible hiss two decades above the corner -- and the
    // radiation EQ then lifts 2-8 kHz by another 7 dB on the way out, so the
    // one part of the knock that should be nowhere near the top of the
    // spectrum arrives brightened. A heavy plate does not do that with a tap.
    const aLp = 1 - Math.exp((-2 * Math.PI * fc) / fs);
    const dec = Math.exp(-1 / Math.max(decayS * fs, 1));
    // Cascading costs amplitude as well as top, so put it back -- otherwise
    // "darker" and "quieter" arrive together and cannot be judged apart.
    const lpMakeup = Math.pow(2 - aLp, poles * 0.5);

    // The oomph: one low resonance, which is what a big plate answers a tap
    // with. Constant-peak-gain two-pole bandpass at thumpHz.
    const w0 = (2 * Math.PI * Math.min(thumpHz, 0.45 * fs)) / fs;
    const r = Math.exp(-w0 / (2 * thumpQ));
    const b1 = 2 * r * Math.cos(w0), b2 = -r * r;
    const bpGain = (1 - r) * Math.sqrt(1 - b1 + -b2 + 1e-12) || (1 - r);
    let z1 = 0, z2 = 0;

    let rng = (opts.seed ?? 1) >>> 0 || 1;
    let l1 = 0, l2 = 0, l3 = 0, env = 0;
    for (let i = 0; i < n; i++) {
      // The burst is driven by the force, so it starts when contact does and
      // does not outlive a quiet blow.
      const drive = Math.abs(pulse[i] ?? 0) / peak;
      env = Math.max(env * dec, drive);
      rng ^= rng << 13; rng ^= rng >>> 17; rng ^= rng << 5; rng >>>= 0;
      const w = rng / 2147483648 - 1;
      l1 += aLp * (w - l1);
      if (poles > 1) l2 += aLp * (l1 - l2); else l2 = l1;
      if (poles > 2) l3 += aLp * (l2 - l3); else l3 = l2;
      const src = env * l3 * lpMakeup;
      const bp = bpGain * src + b1 * z1 + b2 * z2;
      z2 = z1; z1 = bp;
      out[i] += noiseAmt * peak * (src + thumpMix * bp);
    }
  }
  return out;
}
