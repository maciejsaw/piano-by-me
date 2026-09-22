// The room, rendered once and convolved.
//
// Now used only for the soundboard's long, dark impulse (engine.js). The
// reverbs you hear as a room are fdn-room.js (early reflections) and hall.js
// (the late tail).
//
// A reverb has two jobs the ear treats separately, and this renders each the
// way that job actually wants to be rendered, then hands the whole impulse
// response to a ConvolverNode so the convolution runs in native code.
//
//   early reflections  the first few dozen arrivals, each a real path off a
//                      real surface. These tell the ear the size and shape of
//                      the room and where the instrument sits in it, and they
//                      have to be DISCRETE -- a wash here gives a piano the
//                      distant, plate-like sound. So they are an image-source
//                      model of a shoebox: mirror the source in each wall,
//                      take arrival time from the path length and level from
//                      its inverse, with the two ears at different distances
//                      from every image, which is where the stereo comes from.
//   late tail          everything after, by which point the reflections are
//                      far too dense to count. A real diffuse field IS dense
//                      random reflection with an exponential decay, so that is
//                      what it is built from: decorrelated noise under a decay
//                      envelope, with the top of the spectrum decaying faster
//                      than the bottom the way a real room's does.
//
// The tail is deliberately NOT a feedback delay network. A handful of short
// delay lines with no diffusion has an impulse response full of periodic
// echoes -- the metallic, sproingy "spring reverb" ring -- and rendering that
// to an IR just freezes the ring in. Noise has no period, so it cannot ring.
//
// Geometry is what a captured IR library cannot give back: moving the listener
// in an IR library means finding another IR; here it is a redraw that costs a
// few milliseconds, after which the convolution's cost does not depend on how
// complicated the room was.
import { imageSources } from '../../modelled/src/dsp/room.js';

const C_AIR = 343;

export const DEFAULTS = {
  width: 7.2, depth: 9.5, height: 3.8,
  rt60: 1.35, absorption: 0.26, predelayMs: 14,
  distance: 0.72,              // where the listener stands, front (0) to back (1)
  tailDampHz: 3200,
};

/** Deterministic noise, so tweaking a control changes the room, not the dice. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Render the impulse response of a room into an AudioBuffer.
 *
 * `ref` is the energy of the FIRST room rendered in this session. Passing it
 * back in is what makes the controls behave physically: the level is set by
 * 1/sqrt(ref), a constant, so opening the room up or making the surfaces
 * harder gives you MORE reverb, the way it does in a real room. Normalising
 * each IR to its own energy -- which is what ConvolverNode.normalize does --
 * would take that straight back out and leave the geometry controls affecting
 * only the colour.
 *
 * Returns the buffer and the energy, so the caller can keep the reference.
 */
export function renderIR(ctx, opts = {}, ref = null) {
  const o = { ...DEFAULTS, ...opts };
  const fs = ctx.sampleRate;
  const rt60 = Math.max(0.1, o.rt60);
  const absorb = Math.max(0, Math.min(0.95, o.absorption));

  const room = { width: o.width, depth: o.depth, height: o.height, headM: 0.18 };
  const src = { x: o.width * 0.42, y: o.depth * 0.30, z: 1.0 };
  const listener = { x: o.width * 0.5, y: o.depth * o.distance, z: 1.2 };
  const direct = Math.hypot(src.x - listener.x, src.y - listener.y, src.z - listener.z);

  const n = Math.round(fs * Math.min(6, rt60 * 1.5 + 0.3));
  const buf = ctx.createBuffer(2, n, fs);
  const L = buf.getChannelData(0), R = buf.getChannelData(1);

  const pre = Math.round((o.predelayMs / 1000) * fs);

  // --- early reflections: discrete image-source taps, two ears ---
  const images = imageSources(room, src, listener, { order: 3 });
  const place = (chan, dist, order) => {
    const idx = pre + Math.round(((dist - direct) / C_AIR) * fs);
    if (idx < 0 || idx >= n) return;
    // Softened over two samples so a reflection is not a bare click; the air
    // and soft surfaces have already taken the very top off by the time it
    // arrives anyway.
    const g = Math.pow(1 - absorb, order) * (direct / dist);
    chan[idx] += g * 0.7;
    if (idx + 1 < n) chan[idx + 1] += g * 0.3;
  };
  for (const im of images) {
    place(L, im.dL, im.order);
    place(R, im.dR, im.order);
  }

  // --- late tail: decorrelated, frequency-damped, exponential noise ---
  // Two bands per channel so the top decays faster than the bottom: a one-pole
  // lowpass splits each noise stream into low and high, each under its own
  // decay. The tail fades IN over the first ~30 ms so the diffuse field builds
  // up behind the early reflections instead of switching on under them.
  const rand = mulberry32(0x9e3779b1 ^ Math.round(rt60 * 1000) ^ (n << 3));
  const aLp = 1 - Math.exp((-2 * Math.PI * Math.max(400, o.tailDampHz)) / fs);
  const kLow = 6.9078 / rt60;                 // ln(1000): -60 dB over rt60
  const kHigh = 6.9078 / (rt60 * 0.45);       // highs die roughly twice as fast
  const buildLen = Math.max(1, Math.round(0.03 * fs));
  const TAIL = 0.55;                          // balance of diffuse tail to early part
  for (const chan of [L, R]) {
    let lp = 0;
    for (let i = pre; i < n; i++) {
      const t = (i - pre) / fs;
      const white = rand() * 2 - 1;
      lp += aLp * (white - lp);
      const high = white - lp;
      let s = lp * Math.exp(-kLow * t) + high * Math.exp(-kHigh * t);
      const rise = i - pre < buildLen ? (i - pre) / buildLen : 1;
      chan[i] += TAIL * rise * rise * s;
    }
  }

  // Energy, not peak: peak normalisation would make a small dry room -- whose
  // impulse response is one big early reflection -- come out quieter than a
  // hall, which is backwards.
  let e = 0;
  for (let i = 0; i < n; i++) e += L[i] * L[i] + R[i] * R[i];
  const g = 1 / Math.sqrt(Math.max(ref ?? e, 1e-12));
  for (let i = 0; i < n; i++) { L[i] *= g; R[i] *= g; }
  return { buf, energy: e };
}
