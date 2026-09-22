// Onset, tail and the fades that hide both cuts.
//
// Stripping the leading silence is not cosmetic. A sampler's job is that the
// note sounds when the key moves, and any silence baked into the file is
// latency that no buffer size can recover. Salamander's files carry between a
// few and a few hundred milliseconds of it, and the amount varies per file --
// so leaving it in makes the library's timing uneven as well as late.

/** One 2nd-order Butterworth section, run forwards and then backwards. */
function biquadZeroPhase(x, b0, b1, b2, a1, a2) {
  const n = x.length;
  const pass = (src, dst, rev) => {
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < n; i++) {
      const j = rev ? n - 1 - i : i;
      const v = src[j];
      const y = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = v; y2 = y1; y1 = y;
      dst[j] = y;
    }
  };
  const t = new Float32Array(n);
  pass(x, t, false);
  pass(t, x, true);
  return x;
}

/**
 * Subsonic high-pass, zero phase.
 *
 * Not for DC -- these recordings have essentially none. It is for the rumble
 * below the lowest string, which carries no signal, costs the encoder bits it
 * would rather spend at 3 kHz, and sums up across a pedalled chord into
 * something a subwoofer notices. Forwards-and-backwards because an attack
 * transient is a phase relationship and a minimum-phase filter would tilt it.
 */
export function subsonic(ch, fs, fc = 8) {
  const w0 = 2 * Math.PI * fc / fs, c = Math.cos(w0), s = Math.sin(w0);
  const alpha = s / Math.SQRT2;
  const a0 = 1 + alpha;
  const b0 = (1 + c) / 2 / a0, b1 = -(1 + c) / a0, b2 = b0;
  const a1 = -2 * c / a0, a2 = (1 - alpha) / a0;
  for (const x of ch) biquadZeroPhase(x, b0, b1, b2, a1, a2);
  return ch;
}

export const peakOf = (x) => { let p = 0; for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > p) p = a; } return p; };

/**
 * First sample that belongs to the note.
 *
 * Threshold is relative to the file's own peak, with an absolute floor so the
 * softest layers do not trigger on the room's noise. The 2 ms backed off in
 * front is there because the true start of a hammer strike is below any
 * threshold you can set -- cutting at the crossing itself audibly clips the
 * front off the knock.
 */
export function findOnset(x, fs, { relDb = -55, absFloor = 3e-5, backMs = 2 } = {}) {
  const thr = Math.max(peakOf(x) * Math.pow(10, relDb / 20), absFloor);
  let i = 0;
  while (i < x.length && Math.abs(x[i]) < thr) i++;
  if (i >= x.length) return 0;
  return Math.max(0, i - Math.round(backMs * fs / 1000));
}

/**
 * Last sample that still carries note, by 50 ms RMS.
 *
 * The floor is ABSOLUTE first and relative second, and that ordering is what
 * makes the library's size reasonable. A pianissimo layer peaks 18 dB below a
 * fortissimo one, so a purely relative floor keeps it ringing just as long --
 * eighteen decibels further below anything anyone will hear. -80 dBFS on the
 * library's own scale cuts a pp layer around 4 seconds earlier than a ff one,
 * which is both correct and about a quarter of the total bytes.
 */
export function findTail(x, fs, { relDb = -72, absFloor = 1e-4 } = {}) {
  const win = Math.round(0.05 * fs), hop = Math.round(0.01 * fs);
  const floor = Math.max(peakOf(x) * Math.pow(10, relDb / 20), absFloor);
  let last = 0;
  for (let c = 0; c + win <= x.length; c += hop) {
    let s = 0;
    for (let i = c; i < c + win; i++) s += x[i] * x[i];
    if (Math.sqrt(s / win) > floor) last = c + win;
  }
  return last || x.length;
}

/** Raised-cosine in, over `ms`. Kills the step the onset cut leaves behind. */
export function fadeIn(ch, fs, ms = 1) {
  const n = Math.max(1, Math.round(ms * fs / 1000));
  for (const x of ch) {
    const m = Math.min(n, x.length);
    for (let i = 0; i < m; i++) x[i] *= 0.5 - 0.5 * Math.cos(Math.PI * i / m);
  }
}

/** Raised-cosine out, over `ms`, ending at the last sample. */
export function fadeOut(ch, fs, ms = 150) {
  const n = Math.max(1, Math.round(ms * fs / 1000));
  for (const x of ch) {
    const m = Math.min(n, x.length);
    const s = x.length - m;
    for (let i = 0; i < m; i++) x[s + i] *= 0.5 + 0.5 * Math.cos(Math.PI * i / m);
  }
}

export const slice = (ch, from, to) => ch.map((x) => x.slice(from, to));
