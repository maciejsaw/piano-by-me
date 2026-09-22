// A downward expander on the reverb send.
//
// What reaches the rooms is the same signal as the dry path, so quiet playing
// and the long low tail of every note excite the rooms exactly as much, in
// proportion, as the attacks do -- and a room fed a note's whole decay piles
// up into a wash under soft passages. Expanding the SEND, not the output,
// changes only what the rooms hear: below the threshold the send falls away
// `ratio` times faster than the signal does, so the peaks go into the room at
// full weight and the quiet parts go in much less. The dry sound is untouched.
//
//   level above threshold   unity
//   level below threshold   gain = (level - threshold) * (ratio - 1) dB
//
// Ratio 1 is no expansion at all, and the processor then just copies.
//
// The detector is stereo-linked peak with its own attack and release: a fast
// attack opens the send on a note's front, and a release of a hundred
// milliseconds or more closes it over the decay rather than chattering on
// each cycle of a bass string. Both are parameters.

const FLOOR_DB = -80;
const REPORT_EVERY = 2400;     // samples between gain-reduction reports (50 ms at 48 kHz)

class SendExpander extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'ratio', defaultValue: 1, minValue: 1, maxValue: 20, automationRate: 'k-rate' },
      { name: 'threshold', defaultValue: -30, minValue: -90, maxValue: 0, automationRate: 'k-rate' },
      { name: 'attack', defaultValue: 2, minValue: 0.1, maxValue: 200, automationRate: 'k-rate' },     // ms
      { name: 'release', defaultValue: 150, minValue: 5, maxValue: 3000, automationRate: 'k-rate' },  // ms
    ];
  }

  constructor() {
    super();
    this.env = 0;
    this.attMs = this.relMs = -1;   // coefficients recomputed when these change
    this.minDb = 0;            // deepest reduction since the last report
    this.count = 0;
  }

  process(inputs, outputs, params) {
    const input = inputs[0], output = outputs[0];
    const n = output[0].length;
    const inL = input[0], inR = input[1] ?? input[0];
    const outL = output[0], outR = output[1] ?? output[0];
    if (!inL) {                // nothing connected yet
      outL.fill(0); if (outR !== outL) outR.fill(0);
      return true;
    }
    const ratio = params.ratio[0], thr = params.threshold[0];
    const attMs = params.attack[0], relMs = params.release[0];
    if (attMs !== this.attMs) { this.attMs = attMs; this.att = 1 - Math.exp(-1000 / (sampleRate * attMs)); }
    if (relMs !== this.relMs) { this.relMs = relMs; this.rel = 1 - Math.exp(-1000 / (sampleRate * relMs)); }
    const slope = ratio - 1;
    let env = this.env, minDb = this.minDb;
    for (let i = 0; i < n; i++) {
      const l = inL[i], r = inR[i];
      const x = Math.max(Math.abs(l), Math.abs(r));
      env += (x > env ? this.att : this.rel) * (x - env);
      let g = 1;
      if (slope > 0) {
        const lev = 20 * Math.log10(env + 1e-9);
        if (lev < thr) {
          const db = Math.max(FLOOR_DB, (lev - thr) * slope);
          g = Math.pow(10, db / 20);
          if (db < minDb) minDb = db;
        }
      }
      outL[i] = l * g;
      if (outR !== outL) outR[i] = r * g;
    }
    this.env = env;
    this.count += n;
    if (this.count >= REPORT_EVERY) {
      this.port.postMessage({ reductionDb: minDb, levelDb: 20 * Math.log10(env + 1e-9) });
      this.count = 0;
      minDb = 0;
    }
    this.minDb = minDb;
    return true;
  }
}

registerProcessor('send-expander', SendExpander);
