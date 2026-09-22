// The hall: a long, late reverb, rendered once and convolved.
//
// This is the tail only. The early reflections -- the part that says how big
// the room is and where the piano sits in it -- are the other reverb's job
// (fdn-room.js), so nothing here is a discrete path off a wall. What is left
// is the part of a real hall's response that is a statistical object, and the
// three things that make one sound like a hall rather than like a noise burst
// are each built in directly:
//
//   decay by frequency   a hall does not have AN RT60, it has one per band:
//                        the bass rings on a little longer than the mids,
//                        the top dies much faster (the walls, the seats, the
//                        audience and the air all take it). A single decay
//                        with a lowpass on it is what makes a synthetic tail
//                        sound like a hiss that fades. Here every frequency
//                        gets its own exponential: the noise is taken through
//                        a short-time Fourier transform and each bin is
//                        scaled by its own decay at that frame's time.
//   echo density         the first tens of milliseconds of a real tail are
//                        not yet dense: separate arrivals thickening into a
//                        continuum. Starting at full density is the "wash
//                        switched on" sound. The excitation here is velvet
//                        noise -- sparse signed impulses -- whose density rises
//                        over the build-up time, then crossfades into dense
//                        Gaussian noise.
//   build-up             the diffuse field does not arrive at full level; it
//                        grows as energy spreads through the room, so the
//                        envelope rises over the same build-up time.
//
// Per-bin rather than an octave filterbank on purpose: a filterbank's bands
// overlap, and the slow-decaying low bands' skirts carry the treble on long
// after its own band has died -- measured, a 1.1 s target at 8 kHz came out
// at 1.6 s. A bin decays at exactly its own rate.
//
// Both channels get independent noise: a diffuse field IS uncorrelated at two
// ears a head apart, above the lowest octaves.

export const HALL_DEFAULTS = {
  rt60: 2.2,             // mid-band (500 Hz - 1 kHz) reverberation time, s
  bass: 1.25,            // RT at 125 Hz and below, as a multiple of the mid RT
  treble: 0.5,           // RT at 8 kHz, as a multiple of the mid RT
  predelayMs: 20,        // gap before the tail begins
  buildMs: 90,           // how long the tail takes to thicken and rise
};

/** RT multiple at frequency f: bass below 125 Hz, 1 through the mids, treble at 8 kHz, less above. */
function rtShape(f, o) {
  const l2 = Math.log2;
  if (f <= 125) return o.bass;
  if (f <= 500) return o.bass + (1 - o.bass) * (l2(f / 125) / 2);
  if (f <= 1000) return 1;
  if (f <= 8000) return 1 + (o.treble - 1) * (l2(f / 1000) / 3);
  return o.treble * (1 - 0.4 * Math.min(1, l2(f / 8000)));   // the air above 8 kHz
}

/** Deterministic noise, so moving a control changes the hall, not the dice. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** In-place iterative radix-2 complex FFT; `inv` for the inverse (unscaled). */
function fft(re, im, inv) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inv ? 2 : -2) * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

const FRAME = 1024;              // ~21 ms: short against any decay, fine enough in frequency
const HOP = FRAME / 4;

/**
 * Render the hall's stereo impulse response into an AudioBuffer.
 *
 * Levelled like the other rooms: by the energy of the first hall rendered
 * (`ref`), so a longer hall really is more reverb.
 */
export function renderHallIR(ctx, opts = {}, ref = null) {
  const o = { ...HALL_DEFAULTS, ...opts };
  const fs = ctx.sampleRate;
  const rt = Math.max(0.2, o.rt60);
  const rtMax = rt * Math.max(1, o.bass);
  const pre = Math.round((o.predelayMs / 1000) * fs);
  const build = Math.max(1, Math.round((o.buildMs / 1000) * fs));
  // Long enough for the longest-ringing band to fall 60 dB and most of the way to 90.
  const n = pre + Math.round(fs * Math.min(10, rtMax * 1.4 + 0.1));
  const buf = ctx.createBuffer(2, n, fs);

  // Per bin: the decay per HOP, and a gentle high-pass below 40 Hz -- under
  // the piano's lowest fundamental there is only rumble to reverberate.
  const bins = FRAME / 2 + 1;
  const hopDecay = new Float64Array(bins), gain = new Float64Array(bins);
  for (let k = 0; k < bins; k++) {
    const f = Math.max(1, (k * fs) / FRAME);
    const r = rt * rtShape(f, o);
    hopDecay[k] = Math.exp((-6.9078 * HOP) / (r * fs));
    gain[k] = f >= 40 ? 1 : Math.pow(f / 40, 2);
  }
  // sqrt-Hann analysis and synthesis: their product is Hann, which overlaps
  // to exactly 2 at a quarter-frame hop.
  const win = new Float64Array(FRAME);
  for (let i = 0; i < FRAME; i++) win[i] = Math.sqrt(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME));
  const len = n - pre;

  for (let ch = 0; ch < 2; ch++) {
    const out = buf.getChannelData(ch);
    const rand = mulberry32(0x51f15e ^ (ch * 0x9e3779b9) ^ Math.round(rt * 1000));
    const gauss = () => {                     // Box-Muller, one of the pair
      const u = Math.max(1e-12, rand()), v = rand();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };

    // --- excitation, in time: velvet noise thickening into Gaussian ---
    // One signed impulse in each grid cell, the cells shrinking as the
    // density rises from ~150/s to ~2500/s over the build-up; impulses are
    // scaled by sqrt(cell) so the energy per sample matches the dense noise
    // they hand over to across a second build-up.
    const x = new Float64Array(len + FRAME);
    const cellAt = (t) => Math.max(1, Math.round(fs / (150 * Math.pow(2500 / 150, Math.min(1, t / build)))));
    for (let start = 0; start < Math.min(len, 2 * build);) {
      const cell = cellAt(start);
      const at = start + Math.floor(rand() * cell);
      if (at < len) x[at] += (rand() < 0.5 ? -1 : 1) * Math.sqrt(cell);
      start += cell;
    }
    for (let i = 0; i < len; i++) {
      const u = Math.min(1, Math.max(0, (i - build) / build));
      x[i] = x[i] * Math.sqrt(1 - u) + (u > 0 ? gauss() * Math.sqrt(u) : 0);
      // The diffuse field growing into the room.
      if (i < build) { const s = Math.sin((0.5 * Math.PI * i) / build); x[i] *= s * s; }
    }

    // --- a time-varying filter: every bin under its own decay ---
    const y = new Float64Array(len + FRAME);
    const re = new Float64Array(FRAME), im = new Float64Array(FRAME);
    const env = new Float64Array(bins);
    // The first frame starts at -FRAME + HOP, so its centre is FRAME/2 - HOP
    // samples before t = 0: start the envelope that many hops early.
    for (let k = 0; k < bins; k++) env[k] = gain[k] / Math.pow(hopDecay[k], (FRAME / 2 - HOP) / HOP);
    for (let f0 = -FRAME + HOP; f0 < len; f0 += HOP) {
      for (let i = 0; i < FRAME; i++) { const j = f0 + i; re[i] = j >= 0 && j < len ? x[j] * win[i] : 0; im[i] = 0; }
      fft(re, im, false);
      for (let k = 0; k < bins; k++) {
        const g = env[k];
        re[k] *= g; im[k] *= g;
        if (k > 0 && k < FRAME / 2) { re[FRAME - k] *= g; im[FRAME - k] *= g; }
        env[k] *= hopDecay[k];
      }
      fft(re, im, true);
      for (let i = 0; i < FRAME; i++) {
        const j = f0 + i;
        if (j >= 0 && j < len) y[j] += (re[i] / FRAME) * win[i] * 0.5;
      }
    }
    for (let i = 0; i < len; i++) out[pre + i] = y[i];
  }

  // A few ms of fade at the end so the cut is never the one audible edge.
  const L = buf.getChannelData(0), R = buf.getChannelData(1);
  const fade = Math.min(n, Math.round(0.05 * fs));
  for (let i = 0; i < fade; i++) { const g = i / fade; L[n - 1 - i] *= g; R[n - 1 - i] *= g; }

  let e = 0;
  for (let i = 0; i < n; i++) e += L[i] * L[i] + R[i] * R[i];
  const g = 1 / Math.sqrt(Math.max(ref ?? e, 1e-12));
  for (let i = 0; i < n; i++) { L[i] *= g; R[i] *= g; }
  return { buf, energy: e };
}

/** Energy of a buffer, for levelling a loaded IR against the synthetic hall. */
export function energyOf(buf) {
  let e = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) e += d[i] * d[i];
  }
  // A mono IR feeds both ears; count it twice so it levels like a stereo one.
  return buf.numberOfChannels === 1 ? 2 * e : e;
}
