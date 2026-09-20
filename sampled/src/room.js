// The room, rendered once and convolved.
//
// This does not invent a reverb: it runs the SAME room the physically
// modelled variant uses -- src/dsp/room.js, an image-source model of a shoebox
// for the early reflections and an eight-line feedback delay network for the
// tail -- for a couple of seconds against an impulse, and hands the result to
// a ConvolverNode.
//
// That is the right division of labour in a browser. The room's parameters are
// geometry (how big, how absorbent, where you are standing), and geometry is
// exactly what a captured impulse response cannot give you back: moving the
// listener in an IR library means finding another IR. Here it means a redraw
// that costs a few milliseconds, after which the convolution itself runs in
// native code at a cost that does not depend on how complicated the room is.
//
// The early part is worth the trouble. A reverb that starts with a wash gives
// a piano the distant, characterless sound of a plate; the first few dozen
// arrivals are what tell the ear the size and shape of the room and where the
// instrument is in it, and those come from real path lengths off real
// surfaces, with the two ears at different distances from every one of them.
import { Room } from '../../src/dsp/room.js';

export const DEFAULTS = {
  width: 7.2, depth: 9.5, height: 3.8,
  rt60: 1.35, absorption: 0.26, predelayMs: 14,
  distance: 0.72,              // where the listener stands, front (0) to back (1)
  tailDampHz: 3200,
};

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
  const room = new Room(fs, {
    width: o.width, depth: o.depth, height: o.height,
    rt60: o.rt60, absorption: o.absorption, predelayMs: o.predelayMs,
    tailDampHz: o.tailDampHz,
    source: { x: o.width * 0.42, y: o.depth * 0.30, z: 1.0 },
    listener: { x: o.width * 0.5, y: o.depth * o.distance, z: 1.2 },
    mix: 1,                    // wet only: the dry path is the sampler's own
  });

  const n = Math.round(fs * Math.min(6, o.rt60 * 1.4 + 0.25));
  const buf = ctx.createBuffer(2, n, fs);
  const L = buf.getChannelData(0), R = buf.getChannelData(1);
  for (let i = 0; i < n; i++) {
    const [l, r] = room.process(i === 0 ? 1 : 0);
    L[i] = l; R[i] = r;
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
