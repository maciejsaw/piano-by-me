// The modelled piano's room, rendered to an impulse response and convolved.
//
// This is the same Room the physical model runs sample by sample in its
// worklet (src/dsp/room.js): an image-source shoebox for the early
// reflections, stereo from the two ears' distances to every image, and an
// eight-line Hadamard feedback delay network for the tail, damped per loop so
// the top dies first. It is linear and time-invariant, so it HAS an impulse
// response -- tools/room-ir.mjs writes it out -- and running it once on a
// unit impulse and handing the result to a ConvolverNode gives exactly the
// same room for a fraction of the cost of running it live on the sampler's
// output.
//
// It is used for the EARLY part: its reflections are what place the piano
// in a room, and its own tail is held short (RT60 0.3 s) so that the long
// tail is left to the hall (hall.js).
import { Room } from '../../src/dsp/room.js';

export const FDN_DEFAULTS = {
  width: 6.5, depth: 8.5, height: 3.6,
  absorption: 0.28, predelayMs: 14, tailDampHz: 3200,
  // Kept short and fixed: this room is the early reflections, and the long
  // tail is the hall's job. What tail it has only knits the reflections together.
  rt60: 0.3,
  erLevel: 1, tailLevel: 1,
  distance: 0.72,              // where the listener stands, front (0) to back (1)
};

/**
 * Render the room's stereo impulse response into an AudioBuffer.
 *
 * Levelled the same way as renderIR in room.js: by the energy of the first
 * room rendered (`ref`), not each IR's own, so a harder or bigger room -- or
 * more tail -- really is more reverb.
 */
export function renderFdnIR(ctx, opts = {}, ref = null) {
  const o = { ...FDN_DEFAULTS, ...opts };
  const fs = ctx.sampleRate;
  const rt60 = Math.max(0.1, o.rt60);
  const room = new Room(fs, {
    mix: 1,                    // the response itself, not a blend
    width: o.width, depth: o.depth, height: o.height,
    absorption: o.absorption, rt60, predelayMs: o.predelayMs, tailDampHz: o.tailDampHz,
    erLevel: o.erLevel, tailLevel: o.tailLevel,
    source: { x: o.width * 0.42, y: o.depth * 0.30, z: 1.0 },
    listener: { x: o.width * 0.5, y: o.depth * o.distance, z: 1.2 },
  });

  const n = Math.round(fs * Math.min(6, rt60 * 1.5 + 0.3));
  const buf = ctx.createBuffer(2, n, fs);
  const L = buf.getChannelData(0), R = buf.getChannelData(1);
  for (let i = 0; i < n; i++) {
    const [l, r] = room.process(i === 0 ? 1 : 0);
    L[i] = l; R[i] = r;
  }
  // The network is still ringing where the buffer stops, ~-90 dB down; a
  // short fade makes sure the cut is not the one audible edge in the IR.
  const fade = Math.min(n, Math.round(0.05 * fs));
  for (let i = 0; i < fade; i++) {
    const g = i / fade;
    L[n - 1 - i] *= g; R[n - 1 - i] *= g;
  }

  let e = 0;
  for (let i = 0; i < n; i++) e += L[i] * L[i] + R[i] * R[i];
  const g = 1 / Math.sqrt(Math.max(ref ?? e, 1e-12));
  for (let i = 0; i < n; i++) { L[i] *= g; R[i] *= g; }
  return { buf, energy: e };
}
