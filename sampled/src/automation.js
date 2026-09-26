// An AudioParam's automation timeline in plain JS, for the voices that one
// worklet renders (voices.js on the main thread, stream-worklet.js on the
// audio thread). It follows the Web Audio spec's formulas, and Chrome where
// the spec leaves room, for the calls the engine makes on a voice's gains and
// a resonance chain's filter frequencies:
//
//   setValueAtTime, linearRampToValueAtTime, setTargetAtTime,
//   setValueCurveAtTime, cancelScheduledValues, and the `value` setter.
//
// Checked sample for sample against Chrome's own GainNode by
// sampled/tools/automation-test.mjs.
//
// As in Chrome:
//   - times in the past are clamped to `now` when the call is made;
//   - cancelScheduledValues(t) removes every event at or after t AND a value
//     curve still running at t -- so a ramp scheduled next starts from the
//     event before that curve (holdFade puts the rest of it back);
//   - a call that would land inside a value curve throws NotSupportedError.

const SET = 0, LIN = 1, TGT = 2, CURVE = 3;

// When a target has arrived, as Chrome decides it, at the start of each
// render quantum: within exp(-10) of it (relative), or 10 time constants on.
const ARRIVED = 4.539992976248485e-05;
const ARRIVE_TAUS = 10;
const f32 = Math.fround;

function notSupported(msg) {
  try { return new DOMException(msg, 'NotSupportedError'); } catch { return new Error(msg); }
}

export class Timeline {
  constructor(value = 0) {
    this.base = value;          // before the first event, and where it starts from
    this.baseT = 0;
    this.last = value;          // the last value fill() gave
    this.ev = [];               // sorted: SET/TGT/CURVE by start, LIN by end
    this.dirty = false;
  }

  /** Back to a bare param at `value`, for reuse. */
  reset(value) {
    this.base = value; this.baseT = 0; this.last = value;
    this.ev.length = 0; this.dirty = false; this.lastEv = null;
  }

  /** The event list as the spec orders it: by time, a later call after an earlier one at the same time. */
  insert(e) {
    const ev = this.ev;
    for (const c of ev) {
      if (c.type !== CURVE) continue;
      if (e.t > c.t && e.t < c.t + c.dur) throw notSupported('automation event inside a value curve');
      if (e.type === CURVE && c.t === e.t) throw notSupported('value curves at the same time');
    }
    if (e.type === CURVE) {
      for (const c of ev) if (c.t > e.t && c.t < e.t + e.dur) throw notSupported('value curve over an automation event');
    }
    let i = ev.length;
    while (i > 0 && ev[i - 1].t > e.t) i--;
    ev.splice(i, 0, e);
    this.dirty = true;
  }

  setValueAtTime(v, t, now = 0) { this.insert({ type: SET, t: Math.max(t, now), v }); }
  linearRampToValueAtTime(v, t, now = 0) { this.insert({ type: LIN, t: Math.max(t, now), v, made: now }); }
  setTargetAtTime(v, t, tau, now = 0) {
    if (!(tau > 0)) { this.setValueAtTime(v, t, now); return; }
    this.insert({ type: TGT, t: Math.max(t, now), v, tau });
  }
  setValueCurveAtTime(curve, t, dur, now = 0) {
    this.insert({ type: CURVE, t: Math.max(t, now), dur, curve: Float32Array.from(curve), v: curve[curve.length - 1] });
  }
  cancelScheduledValues(t, now = 0) {
    t = Math.max(t, now);
    const ev = this.ev;
    for (let i = 0; i < ev.length; i++) {
      const e = ev[i];
      if (e.t >= t || (e.type === CURVE && e.t + e.dur > t)) { ev.length = i; break; }
    }
    this.dirty = true;
  }

  /**
   * Where each event starts from: t0/v0 (for a ramp, the end of the event
   * before; for a target, the value just before it), and what the next event
   * starts from.
   */
  resolve() {
    this.dirty = false;
    const ev = this.ev;
    let pt = this.baseT, pv = this.base, prev = null;
    for (const e of ev) {
      if (e.type === LIN) {
        if (prev && prev.type === TGT) {
          // A ramp after a target starts where the target has got to when
          // the ramp is scheduled (the spec), or at the target's start.
          e.t0 = Math.min(e.t, Math.max(prev.t, e.made));
          e.v0 = valueOf(prev, e.t0);
        } else { e.t0 = pt; e.v0 = pv; }
        pt = e.t; pv = e.v;
      } else if (e.type === TGT) {
        e.t0 = e.t;
        e.v0 = prev && prev.type === TGT ? valueOf(prev, e.t) : pv;
        pt = e.t; pv = e.v0;
      } else if (e.type === CURVE) {
        e.t0 = e.t; e.v0 = e.curve[0];
        pt = e.t + e.dur; pv = e.v;
      } else {
        e.t0 = e.t; e.v0 = e.v;
        pt = e.t; pv = e.v;
      }
      prev = e;
    }
  }

  /** The event in force at `t`, or null before the first. */
  at(t) {
    if (this.dirty) this.resolve();
    const ev = this.ev;
    let i = ev.length - 1;
    while (i >= 0 && ev[i].t0 > t) i--;
    return i >= 0 ? ev[i] : null;
  }

  /** The same at frame `f`, as Chrome places an event: from the first frame at or after time x sampleRate. */
  atFrame(f, sr) {
    if (this.dirty) this.resolve();
    const ev = this.ev;
    let i = ev.length - 1;
    while (i >= 0 && ev[i].t0 * sr > f) i--;
    return i >= 0 ? ev[i] : null;
  }

  valueAt(t) {
    const e = this.at(t);
    return e ? valueOf(e, t) : this.base;
  }

  /**
   * Values for frames f0 .. f0+n-1 at `sr` -- one render quantum, read in
   * order. Returns the value if it is the same for all of them (`out`
   * untouched), else NaN with `out` filled. Drops the events that can no
   * longer matter.
   *
   * A target is computed the way Chrome computes it, a sample at a time in
   * single precision from the value before, and snapped to its target when
   * it has arrived; the rest are the spec's formulas, which Chrome follows.
   */
  fill(out, f0, n, sr) {
    const t0 = f0 / sr, f1 = f0 + n - 1;
    this.prune(f0, sr);
    const ev = this.ev;
    if (!ev.length) return (this.last = this.base);
    const e = this.atFrame(f0, sr);
    // A target that ran to the end of the last quantum and gives way right
    // at the start of this one is still entered here, for no frames -- which
    // moves Chrome's running value one step on for whatever starts next.
    const p = this.lastEv;
    if (p && p !== e && p.type === TGT && !p.done && p.dtc !== undefined) {
      this.last = f32(this.last + f32(f32(p.v - this.last) * p.dtc));
    }
    this.lastEv = this.atFrame(f0 + n - 1, sr);
    // Nothing starts within the block and what is in force is flat.
    let next = null;
    for (const x of ev) if (x.t0 * sr > f0) { next = x; break; }
    if (!next || next.t0 * sr > f1) {
      if (!e) return (this.last = this.base);
      if (e.type === TGT) this.arrive(e, f0, sr);
      const c = flatFrom(e, t0);
      if (c === c) return (this.last = c);
    }
    for (let i = 0; i < n;) {
      const f = f0 + i, t = f / sr;
      const x = this.atFrame(f, sr);
      if (!x || x.type !== TGT) {
        out[i] = x ? valueOf(x, t) : this.base;
        this.last = out[i++];
        continue;
      }
      let j = i + 1;
      while (j < n && this.atFrame(f0 + j, sr) === x) j++;
      this.target(x, out, i, j, f, sr);
      this.last = out[j - 1];
      i = j;
    }
    return NaN;
  }

  /**
   * out[i, j) of target `x`, the first at frame `f`: Chrome's SetTarget, as
   * it runs on x86 -- entered once per quantum, then four samples a step.
   */
  target(x, out, i, j, f, sr) {
    if (x.dtc === undefined) {
      const c0 = x.dtc = f32(1 - Math.exp(-1 / (sr * x.tau)));
      x.c1 = f32(c0 * f32(2 - c0));
      x.c2 = f32(c0 * f32(f32(f32(c0 - 3) * c0) + 3));
      x.c3 = f32(c0 * f32(f32(c0 * f32(f32(f32(4 - c0) * c0) - 6)) + 4));
    }
    const T = x.v, start = x.t * sr;
    // The value before: this target's own last one, or what came before it.
    let v = x.frame === f - 1 ? x.cur : this.last;
    // At its start frame, exactly from there; otherwise one step on.
    if (start <= f && f < start + 1) v = f32(T + (v - T) * Math.exp(-(f / sr - x.t) / x.tau));
    else v = f32(v + f32(f32(T - v) * x.dtc));
    x.cur = v;
    this.arrive(x, f, sr, true);
    if (x.done) { out.fill(T, i, j); x.frame = f + (j - i) - 1; return; }
    const { dtc, c1, c2, c3 } = x;
    let k = i;
    for (const e4 = i + (((j - i) >> 2) << 2); k < e4; k += 4) {
      const d = f32(T - v);
      out[k] = v; out[k + 1] = f32(v + f32(d * dtc)); out[k + 2] = f32(v + f32(d * c1)); out[k + 3] = f32(v + f32(d * c2));
      v = f32(v + f32(d * c3));
    }
    for (; k < j; k++) { out[k] = v; v = f32(v + f32(f32(T - v) * dtc)); }
    x.cur = out[j - 1];
    x.frame = f + (j - i) - 1;
  }

  /** Has target `e` arrived by frame `f` (the start of a quantum)? `known`: e.cur is its value there. */
  arrive(e, f, sr, known = false) {
    if (e.done) return;
    if (f / sr > e.t + ARRIVE_TAUS * e.tau) { e.done = true; return; }
    if (!known) return;
    if (e.v !== 0 && Math.abs(e.v - e.cur) < ARRIVED * Math.abs(e.cur)) e.done = true;
  }

  /**
   * Forget the events before the one in force at frame `f` -- all but one if that
   * is a value curve, since cancelling it brings back the event before. What
   * is kept starts where it was resolved to start.
   */
  prune(f, sr) {
    if (this.ev.length < 2) return;
    if (this.dirty) this.resolve();
    const ev = this.ev;
    let i = ev.length - 1;
    while (i > 0 && ev[i].t0 * sr > f) i--;
    if (ev[i].type === CURVE) i--;
    if (i <= 0) return;
    this.baseT = ev[i].t0; this.base = ev[i].v0;
    ev.splice(0, i);
  }
}

function valueOf(e, t) {
  switch (e.type) {
    case SET: return e.v;
    case LIN: {
      if (t >= e.t || e.t <= e.t0) return e.v;
      return e.v0 + (e.v - e.v0) * (t - e.t0) / (e.t - e.t0);
    }
    case TGT: return e.done ? e.v : e.v + (e.v0 - e.v) * Math.exp(-(t - e.t) / e.tau);
    default: {
      const c = e.curve, n = c.length;
      const u = (t - e.t) / e.dur;
      if (u >= 1) return c[n - 1];
      if (u <= 0) return c[0];
      const x = u * (n - 1), k = Math.floor(x);
      return c[k] + (c[Math.min(n - 1, k + 1)] - c[k]) * (x - k);
    }
  }
}

/** `e`'s value if it stays the same from `t0` on, else NaN. */
function flatFrom(e, t0) {
  switch (e.type) {
    case SET: return e.v;
    case LIN: return t0 >= e.t ? e.v : NaN;
    case TGT: return e.done ? e.v : NaN;
    default: return t0 >= e.t + e.dur ? e.v : NaN;
  }
}
