// A four-band output EQ, on the master bus.
//
// Downstream of everything -- the strips, the room, the resonance -- because
// it is meant to be the last word on the instrument's tone rather than a way
// of fixing one note, which is what the per-key level trim is for.
//
// Shelves at the ends and two bells in the middle is the arrangement that
// covers what a piano actually needs adjusting: how much body, how much
// boxiness around 300 Hz, how much hammer around 3 kHz, how much air. The
// curve is drawn from the filters' own getFrequencyResponse rather than from
// a formula, so what is on screen is the response that is running.

export const BANDS = [
  { key: 'low', label: 'Low shelf', type: 'lowshelf', freq: 90, q: 0.7, gain: 0, fMin: 30, fMax: 400, hasQ: false },
  { key: 'body', label: 'Body', type: 'peaking', freq: 300, q: 0.9, gain: 0, fMin: 100, fMax: 1200, hasQ: true },
  { key: 'presence', label: 'Presence', type: 'peaking', freq: 3000, q: 0.9, gain: 0, fMin: 800, fMax: 8000, hasQ: true },
  { key: 'air', label: 'High shelf', type: 'highshelf', freq: 7000, q: 0.7, gain: 0, fMin: 2000, fMax: 16000, hasQ: false },
];

export class Eq {
  constructor(ctx) {
    this.ctx = ctx;
    this.in = ctx.createGain();
    this.out = ctx.createGain();
    this.enabled = true;
    this.filters = BANDS.map((b) => {
      const f = ctx.createBiquadFilter();
      f.type = b.type;
      f.frequency.value = b.freq;
      f.Q.value = b.q;
      f.gain.value = b.gain;
      return f;
    });
    this.wire();
  }

  wire() {
    this.in.disconnect();
    for (const f of this.filters) f.disconnect();
    if (this.enabled) {
      let node = this.in;
      for (const f of this.filters) { node.connect(f); node = f; }
      node.connect(this.out);
    } else {
      this.in.connect(this.out);          // a true bypass, not a flat curve
    }
  }

  setEnabled(on) { if (on !== this.enabled) { this.enabled = on; this.wire(); } }
  set(i, what, value) {
    const f = this.filters[i];
    const p = what === 'gain' ? f.gain : what === 'q' ? f.Q : f.frequency;
    p.setTargetAtTime(value, this.ctx.currentTime, 0.01);
    p.value = value;                      // so the drawn curve matches immediately
  }

  /** Total magnitude response, in dB, over a log frequency axis. */
  response(freqs) {
    const mag = new Float32Array(freqs.length), phase = new Float32Array(freqs.length);
    const out = new Float64Array(freqs.length);
    if (!this.enabled) return out;
    for (const f of this.filters) {
      f.getFrequencyResponse(freqs, mag, phase);
      for (let i = 0; i < out.length; i++) out[i] += 20 * Math.log10(Math.max(mag[i], 1e-6));
    }
    return out;
  }

  toJSON() { return { enabled: this.enabled, bands: this.filters.map((f) => [f.frequency.value, f.Q.value, f.gain.value]) }; }
  fromJSON(o) {
    if (!o) return;
    this.enabled = o.enabled !== false;
    (o.bands ?? []).forEach(([fr, q, g], i) => {
      if (!this.filters[i]) return;
      this.filters[i].frequency.value = fr;
      this.filters[i].Q.value = q;
      this.filters[i].gain.value = g;
    });
    this.wire();
  }
}
