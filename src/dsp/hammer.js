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
function contact(fs, { mass, K, p, Z, velocity, strikeDelay, maxMs = 12 }) {
  const dt = 1 / (fs * OS);
  const maxSteps = Math.round(fs * OS * maxMs * 1e-3);
  const out = [];

  // Ring buffer holding the outgoing wave, for the round trip to the agraffe.
  const rt = Math.max(1, Math.round(strikeDelay * OS));
  const ring = new Float64Array(rt);
  let rp = 0;

  let d = 0, vh = velocity, acc = 0, sub = 0, touched = false;
  for (let i = 0; i < maxSteps; i++) {
    const F = d > 0 ? K * Math.pow(d, p) : 0;
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
    if (++sub === OS) { out.push(acc / OS); acc = 0; sub = 0; }
    if (touched && d <= 0) break;            // felt lets go
  }
  if (sub > 0) out.push(acc / sub);
  while (out.length && out[out.length - 1] === 0) out.pop();
  return out;
}

/** Contact duration in ms, for checking a voicing against reality. */
export function contactMs(fs, params) {
  return (contact(fs, params).length / fs) * 1000;
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

  // MIDI velocity -> hammer speed. Real range is roughly 0.2 m/s (ppp) to
  // 6 m/s (fff), and the curve is strongly exponential.
  const v = 0.18 * Math.pow(velocity, 0.15) * Math.exp(3.5 * velocity);

  const force = contact(fs, { mass, K, p, Z: Zload, velocity: v, strikeDelay });
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
  return out;
}
