// The room: what happens to the sound after it leaves the instrument.
//
// Deliberately in two parts, because the ear uses them for different things.
//
//   early reflections  the first few dozen arrivals, each a real path off a
//                      real surface. These are what tell you the size and
//                      shape of the room and where you are standing in it,
//                      and they are the part that must NOT be a blur -- a
//                      reverb that starts with a wash gives a piano the
//                      distant, characterless sound of a plate.
//   late tail          everything after, by which point the reflections are
//                      too dense to count. That part carries decay time and
//                      warmth, and has no business being a list of paths.
//
// So the early part is an image-source model of a shoebox: mirror the source
// in each wall, work out the distance to each ear, and take arrival time from
// the distance, level from the inverse of it, and absorption from how many
// surfaces the path has touched. It is stereo from the geometry rather than
// from a width control -- the two ears are at different distances from every
// image, which is where the time and level differences come from.
//
// The tail is a feedback delay network: eight lines with mutually prime
// lengths, mixed by a Hadamard matrix so that every line feeds every other
// one, with a lowpass in each loop so the top decays faster than the bottom
// the way a real room's does. Its decay is set from an RT60 rather than from
// a feedback gain, since RT60 is a thing a room HAS and feedback gain is a
// thing a filter has.

const C_AIR = 343;

/** Odd, mutually prime enough, ascending: the FDN's line lengths. */
const FDN_RATIOS = [1, 1.13, 1.31, 1.47, 1.63, 1.81, 1.93, 2.11];

class Delay {
  constructor(n) { this.buf = new Float64Array(Math.max(2, n)); this.pos = 0; }
  push(x) { this.buf[this.pos] = x; this.pos = (this.pos + 1) % this.buf.length; }
  /** `back` samples ago, where 0 is the sample just pushed. */
  tap(back) {
    let i = this.pos - 1 - back;
    while (i < 0) i += this.buf.length;
    return this.buf[i];
  }
}

/**
 * Image sources of a shoebox, to first and second order.
 *
 * Only the axial images are taken. Higher-order and oblique images arrive
 * later and closer together, which is precisely the region the tail already
 * covers -- listing them would be spending arithmetic to reproduce something
 * a feedback network does better.
 */
export function imageSources(room, src, listener, { order = 2 } = {}) {
  const dims = [room.width, room.depth, room.height];
  const s0 = [src.x, src.y, src.z];
  const out = [];
  for (let axis = 0; axis < 3; axis++) {
    const L = dims[axis], s = s0[axis];
    // Mirroring a shoebox in one axis puts the images at 2kL +- s. The '+'
    // family has bounced an even number of times, the '-' family an odd
    // number, which is where each image's absorption count comes from.
    for (let k = -1; k <= 1; k++) {
      for (const sign of [1, -1]) {
        if (k === 0 && sign === 1) continue;                 // that is the source
        const ord = sign === 1 ? Math.abs(2 * k) : Math.abs(2 * k - 1);
        if (ord < 1 || ord > order) continue;
        const p = s0.slice();
        p[axis] = 2 * k * L + sign * s;
        out.push({ p, order: ord, axis });
      }
    }
  }
  return out.map((im) => {
    const ear = (dx) => Math.hypot(im.p[0] - (listener.x + dx), im.p[1] - listener.y, im.p[2] - listener.z);
    return { ...im, dL: ear(-room.headM / 2), dR: ear(room.headM / 2) };
  });
}

export class Room {
  constructor(fs, opts = {}) {
    this.fs = fs;
    this.enabled = opts.enabled !== false;
    this.mix = opts.mix ?? 0.26;            // how much of the output is the room
    this.erLevel = opts.erLevel ?? 1;
    this.tailLevel = opts.tailLevel ?? 1;

    const room = {
      width: opts.width ?? 6.5,             // m, left to right
      depth: opts.depth ?? 8.5,             // m, front to back
      height: opts.height ?? 3.6,
      headM: opts.headM ?? 0.18,            // ear spacing
    };
    this.room = room;
    const src = opts.source ?? { x: room.width * 0.42, y: room.depth * 0.30, z: 1.0 };
    const listener = opts.listener ?? { x: room.width * 0.5, y: room.depth * 0.72, z: 1.2 };
    const absorb = opts.absorption ?? 0.28; // fraction lost per surface

    // --- early reflections ---
    const direct = Math.hypot(src.x - listener.x, src.y - listener.y, src.z - listener.z);
    const images = imageSources(room, src, listener, { order: opts.erOrder ?? 2 });
    const maxD = Math.max(...images.map((i) => Math.max(i.dL, i.dR)));
    this.erDelay = new Delay(Math.ceil((maxD / C_AIR) * fs) + 8);
    this.taps = [];
    for (const im of images) {
      const g = Math.pow(1 - absorb, im.order);
      // Inverse distance, referenced to the direct path, so moving the
      // listener changes the balance the way moving actually does.
      for (const [d, side] of [[im.dL, 0], [im.dR, 1]]) {
        this.taps.push({
          n: Math.round(((d - direct) / C_AIR) * fs),
          g: (g * direct) / d,
          side,
          // Air and soft surfaces take the top off, more so the longer the
          // path. One pole per tap, coefficient from the extra distance.
          a: 1 - Math.exp((-2 * Math.PI * Math.max(1200, 9000 - 700 * (d - direct))) / fs),
          z: 0,
        });
      }
    }
    this.taps = this.taps.filter((t) => t.n > 0);

    // --- late tail ---
    const rt60 = opts.rt60 ?? 1.25;
    const meanFree = (4 * room.width * room.depth * room.height)
      / (2 * (room.width * room.depth + room.width * room.height + room.depth * room.height));
    const base = Math.max(0.013, meanFree / C_AIR);   // seconds, the first line
    this.lines = FDN_RATIOS.map((r) => {
      let n = Math.round(base * r * fs);
      if (n % 2 === 0) n += 1;
      return { d: new Delay(n + 2), n, g: Math.pow(10, (-3 * (n / fs)) / rt60), z: 0 };
    });
    // One pole per line, so the tail darkens as it decays rather than all at
    // once at the input.
    this.damp = 1 - Math.exp((-2 * Math.PI * (opts.tailDampHz ?? 3200)) / fs);
    this.preN = Math.round(((opts.predelayMs ?? 14) * fs) / 1000);
    this.pre = new Delay(this.preN + 2);
    this.tmp = new Float64Array(8);
    this.rt60 = rt60;
  }

  /** One sample in, a stereo pair out. */
  process(x) {
    if (!this.enabled) return [x, x];
    this.erDelay.push(x);
    let eL = 0, eR = 0;
    for (let i = 0; i < this.taps.length; i++) {
      const t = this.taps[i];
      t.z += t.a * (this.erDelay.tap(t.n) - t.z);
      if (t.side === 0) eL += t.g * t.z; else eR += t.g * t.z;
    }
    eL *= this.erLevel; eR *= this.erLevel;

    this.pre.push(x);
    const drive = this.pre.tap(this.preN);
    const v = this.tmp;
    for (let i = 0; i < 8; i++) v[i] = this.lines[i].d.tap(this.lines[i].n);

    // Hadamard by butterflies: eight lines fully mixed in three passes rather
    // than sixty-four multiplies.
    for (let span = 1; span < 8; span <<= 1) {
      for (let i = 0; i < 8; i += span << 1) {
        for (let j = i; j < i + span; j++) {
          const a = v[j], b = v[j + span];
          v[j] = a + b; v[j + span] = a - b;
        }
      }
    }
    const norm = 1 / Math.sqrt(8);
    for (let i = 0; i < 8; i++) {
      const l = this.lines[i];
      l.z += this.damp * (v[i] * norm - l.z);
      l.d.push(drive + l.g * l.z);
    }
    // Two different halves of the network for the two channels: the tail is
    // decorrelated because the lines are, not because it was widened.
    const tL = (this.lines[0].z + this.lines[2].z + this.lines[4].z + this.lines[6].z) * 0.5 * this.tailLevel;
    const tR = (this.lines[1].z + this.lines[3].z + this.lines[5].z + this.lines[7].z) * 0.5 * this.tailLevel;

    const m = this.mix, dry = 1 - m;
    return [dry * x + m * (eL + tL), dry * x + m * (eR + tR)];
  }

  reset() {
    this.taps.forEach((t) => { t.z = 0; });
    this.erDelay.buf.fill(0);
    this.pre.buf.fill(0);
    this.lines.forEach((l) => { l.d.buf.fill(0); l.z = 0; });
  }
}
