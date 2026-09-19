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
  const v = 0.18 * Math.pow(velocity, 0.15) * Math.exp(3.5 * velocity);

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
