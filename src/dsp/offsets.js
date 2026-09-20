// A layer of editable offsets over the voicing curves.
//
// Everything in scale.js is a curve through the keyboard, fitted or measured,
// and those curves are the model's opinion. This is where a person disagrees
// with it: per parameter, one global offset that moves the whole curve, and an
// optional per-key array that moves single notes. Nothing here replaces a
// curve -- an offset of zero is exactly the shipped value, so the fits stay
// the reference and an edit is always visible as a departure from them.
//
// Two shapes of offset, and the difference matters for which knob feels right:
//
//   mul   the offset is in OCTAVES of the value: v * 2^off. Right for
//         everything that is a rate, a level or a duration, where what the ear
//         tracks is the ratio. Doubling and halving are then symmetric about
//         the centre, which a linear knob on a decay time is not.
//   add   the offset is in the parameter's own units. Right for the few
//         things that are already logarithmic or already a fraction --
//         hardness is an exponent, strike position is a fraction of a string.
//
// `span` is how far the slider reaches at its ends. Precision in the UI is a
// zoom on this, not a different parameter, so the stored value never depends
// on what the display was set to when it was drawn.

export const LOW = 21, HIGH = 108, KEYS = HIGH - LOW + 1;

/**
 * The exposed parameters, in the order the editor shows them.
 *
 * `scope: 'note'` means the value is looked up per key, so a per-key curve is
 * meaningful. `scope: 'global'` means one value for the whole instrument --
 * the body, the room -- and only the slider applies.
 */
export const PARAMS = [
  // --- string ---
  { key: 't60Low', label: 'Decay, aftersound', group: 'String', mode: 'mul', span: 1.5, unit: 's' },
  { key: 't60High', label: 'Decay, top partials', group: 'String', mode: 'mul', span: 1.5, unit: 's' },
  { key: 't60Damped', label: 'Decay, damper down', group: 'String', mode: 'mul', span: 1.5, unit: 's' },
  { key: 'strikePos', label: 'Strike position', group: 'String', mode: 'add', span: 0.05, unit: 'of length' },
  { key: 'coupling', label: 'Bridge coupling', group: 'String', mode: 'mul', span: 1.5 },
  { key: 'gain', label: 'Note level', group: 'String', mode: 'mul', span: 1.5 },
  { key: 'detune', label: 'Unison detune', group: 'String', mode: 'mul', span: 2, unit: 'cents' },
  { key: 'lengthSpread', label: 'Unison length spread', group: 'String', mode: 'mul', span: 2 },
  { key: 'gaugeSpread', label: 'Unison gauge spread', group: 'String', mode: 'mul', span: 2 },
  { key: 'strikeSpread', label: 'Unison strike spread', group: 'String', mode: 'mul', span: 2 },
  { key: 'levelSpread', label: 'Unison level spread', group: 'String', mode: 'mul', span: 2 },

  // --- hammer ---
  { key: 'hardness', label: 'Felt hardness', group: 'Hammer', mode: 'add', span: 0.8 },
  { key: 'hammerMass', label: 'Hammer mass', group: 'Hammer', mode: 'mul', span: 1 , unit: 'kg' },
  { key: 'feltP', label: 'Felt exponent', group: 'Hammer', mode: 'add', span: 0.8 },
  { key: 'feltEps', label: 'Felt hysteresis', group: 'Hammer', mode: 'add', span: 0.3 },
  { key: 'hammerWidthMm', label: 'Contact width', group: 'Hammer', mode: 'mul', span: 1, unit: 'mm' },
  { key: 'strikeOffsetUs', label: 'Strike offsets', group: 'Hammer', mode: 'mul', span: 2, unit: 'us' },
  { key: 'hammerMassSpread', label: 'Mass spread', group: 'Hammer', mode: 'mul', span: 2 },
  { key: 'hammerForceSpread', label: 'Force spread', group: 'Hammer', mode: 'mul', span: 2 },

  // --- transient / swell ---
  { key: 'transientDepth', label: 'Transient depth', group: 'Onset', mode: 'mul', span: 2 },
  { key: 'transientRiseS', label: 'Transient rise', group: 'Onset', mode: 'mul', span: 2, unit: 's' },
  { key: 'transientTauS', label: 'Transient length', group: 'Onset', mode: 'mul', span: 2, unit: 's' },
  { key: 'transientSkew', label: 'Transient skew', group: 'Onset', mode: 'mul', span: 1.5 },
  { key: 'swellS', label: 'Board swell time', group: 'Onset', mode: 'mul', span: 2, unit: 's', scope: 'global', base: 0.020 },
  { key: 'swellFloor', label: 'Board swell floor', group: 'Onset', mode: 'add', span: 0.5, scope: 'global', base: 0.50 },
  { key: 'swellSkew', label: 'Board swell skew', group: 'Onset', mode: 'add', span: 1.5, scope: 'global', base: 1.4 },

  // --- knock ---
  { key: 'knockGain', label: 'Knock force', group: 'Knock', mode: 'mul', span: 2 },
  { key: 'knockNoise', label: 'Knock noise', group: 'Knock', mode: 'mul', span: 2 },
  { key: 'knockDecayS', label: 'Knock decay', group: 'Knock', mode: 'mul', span: 2, unit: 's' },
  { key: 'knockFc', label: 'Knock brightness', group: 'Knock', mode: 'mul', span: 1.5, unit: 'Hz' },
  { key: 'knockThumpHz', label: 'Knock thump pitch', group: 'Knock', mode: 'mul', span: 1, unit: 'Hz' },
  { key: 'knockThumpQ', label: 'Knock thump Q', group: 'Knock', mode: 'mul', span: 1.5 },
  { key: 'knockThumpMix', label: 'Knock thump level', group: 'Knock', mode: 'mul', span: 2 },

  // --- body ---
  { key: 'boardMix', label: 'Board diffusion', group: 'Body', mode: 'add', span: 1, scope: 'global', base: 1 },
  { key: 'boardSpreadMs', label: 'Board size', group: 'Body', mode: 'mul', span: 1.5, unit: 'ms', scope: 'global', base: 37 },
  { key: 'boardG', label: 'Board density', group: 'Body', mode: 'add', span: 0.3, scope: 'global', base: 0.665 },
  { key: 'cavityMix', label: 'Case cavity', group: 'Body', mode: 'mul', span: 2, scope: 'global', base: 0.18 },
  { key: 'lidGain', label: 'Lid reflection', group: 'Body', mode: 'mul', span: 2, scope: 'global', base: 0.28 },
  { key: 'masterGain', label: 'Master level', group: 'Body', mode: 'mul', span: 1.5, scope: 'global', base: 0.070 },
];

export const PARAM_BY_KEY = new Map(PARAMS.map((p) => [p.key, p]));

/** Global + per-key offsets, and the arithmetic that applies them. */
export class Offsets {
  constructor(state = null) {
    this.global = new Map();
    this.keys = new Map();
    if (state) this.load(state);
  }

  /** The offset in force at `midi`: the slider plus whatever was drawn. */
  at(key, midi) {
    const g = this.global.get(key) ?? 0;
    const arr = this.keys.get(key);
    return arr ? g + (arr[midi - LOW] ?? 0) : g;
  }

  /** Apply it to a value looked up from a voicing curve. */
  apply(key, midi, value) {
    const off = this.at(key, midi);
    if (off === 0) return value;
    const p = PARAM_BY_KEY.get(key);
    if (p && p.mode === 'add') return value + off;
    return value * Math.pow(2, off);
  }

  /** For the global-scope parameters, which have a base rather than a curve. */
  value(key) {
    const p = PARAM_BY_KEY.get(key);
    if (!p) return undefined;
    return this.apply(key, LOW, p.base);
  }

  setGlobal(key, v) { if (v) this.global.set(key, v); else this.global.delete(key); }

  setKey(key, midi, v) {
    let arr = this.keys.get(key);
    if (!arr) {
      if (!v) return;
      arr = new Float32Array(KEYS);
      this.keys.set(key, arr);
    }
    arr[midi - LOW] = v;
  }

  clear(key) { this.global.delete(key); this.keys.delete(key); }

  /** Is anything at all set? Lets callers skip a rebuild that would do nothing. */
  get empty() { return this.global.size === 0 && this.keys.size === 0; }

  toJSON() {
    const out = { global: {}, keys: {} };
    for (const [k, v] of this.global) if (v) out.global[k] = v;
    for (const [k, a] of this.keys) {
      if (a.some((v) => v !== 0)) out.keys[k] = Array.from(a, (v) => +v.toFixed(4));
    }
    return out;
  }

  load(state) {
    this.global.clear();
    this.keys.clear();
    for (const [k, v] of Object.entries(state?.global ?? {})) if (v) this.global.set(k, v);
    for (const [k, a] of Object.entries(state?.keys ?? {})) {
      if (Array.isArray(a) && a.length === KEYS) this.keys.set(k, Float32Array.from(a));
    }
    return this;
  }
}

export const NO_OFFSETS = new Offsets();
