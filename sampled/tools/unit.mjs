// The sampled piano's pure logic, checked in Node: no browser, no audio, no
// waiting. Everything here is arithmetic the engine does before any sound is
// made, so it is checked as arithmetic -- in milliseconds, on every run.
//
//   npm run sampled:unit
//
// What needs real audio is in smoke.mjs (fast) and browser-test.mjs (slow).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../src/engine.js';
import { Curves } from '../src/curves.js';
import { Envelopes } from '../src/envelopes.js';
import { Resonance, ResCurve, RES_FLOOR } from '../src/resonance.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const m = JSON.parse(readFileSync(join(HERE, '..', 'samples', 'manifest.json'), 'utf8'));
const checks = [];
const check = (name, ok, got = '') => checks.push([name, !!ok, got]);

// --- attack alignment -------------------------------------------------------
// Every recording's measured attack front has to land the same distance after
// the key goes down, whether the engine gets there by skipping into a late
// sample or by holding an early one back. startAt() only reads these fields.
const curves = new Curves();
const eng = { alignStarts: m.alignMs != null, alignMs: m.alignMs ?? 0, curves };
const startAt = (midi, p) => Engine.prototype.startAt.call(eng, midi, p);
const landings = (on) => {
  eng.alignStarts = on;
  const out = [];
  for (const midi of [21, 33, 45, 60, 72, 84, 96, 108]) {
    for (const layer of [1, 8, 16]) {
      const t0 = m.notes[midi]?.layers?.[layer]?.t0;
      if (t0 == null) continue;
      const at = startAt(midi, { t0, dur: 5 });
      out.push(t0 - at.offset * 1000 + at.delay * 1000);
    }
  }
  return out;
};
const spread = (v) => Math.max(...v) - Math.min(...v);
const aligned = spread(landings(true)), raw = spread(landings(false));
eng.alignStarts = m.alignMs != null;
check('aligned attacks land together', aligned < 0.5, `${aligned.toFixed(2)} ms of spread`);
check('...which the recordings do not do on their own', raw > 5, `${raw.toFixed(1)} ms`);

// Per-key Sample start, on top of the alignment, moving one key alone.
const startOf = (midi) => startAt(midi, { t0: m.notes[midi].layers[8].t0, dur: 5 }).offset * 1000;
const before = startOf(60), sibling = startOf(61);
curves.setKey('startTrim', 60, 20);
const moved = startOf(60) - before, neighbour = Math.abs(startOf(61) - sibling);
curves.setKey('startTrim', 60, 0);
check('per-key sample start moves one key', Math.abs(moved - 20) < 0.5 && neighbour < 0.01,
  `${moved.toFixed(2)} ms, neighbour ${neighbour.toFixed(2)} ms`);
// It must never skip so far in that the note is a fragment.
curves.setKey('startTrim', 60, 100000);
const clamped = startAt(60, { t0: 12, dur: 4 }).offset;
curves.setKey('startTrim', 60, 0);
check('...and cannot skip past half the recording', clamped <= 2 + 1e-9, `${clamped} s`);

// --- per-octave ranges ------------------------------------------------------
// A range raised with a fade must not leave a step at its edge, and must still
// reach its full value inside. Widening the fade has to keep reducing the
// step, every time: that is the property; any particular number is just where
// the raised cosine is steepest for that width.
const stepFor = (f) => { curves.setScope('trim', { lo: 84, hi: 108 }, 12, f); return curves.worstStep('trim').step; };
const hard = stepFor(0), feathered = stepFor(6);
curves.setScope('trim', { lo: 84, hi: 108 }, 12, 6);
const inside = curves.at('trim', 96) - curves.at('trim', 60);
const ladder = [0, 3, 6, 10, 14].map(stepFor);
curves.reset('trim');
check('a feathered range still reaches full value inside', Math.abs(inside - 12) < 0.1, `${inside.toFixed(2)} dB`);
check('...and a fade cuts the edge step fourfold', feathered <= hard / 4, `${feathered.toFixed(2)} vs ${hard.toFixed(2)} dB`);
check('...with a hard edge dropping it all at once', hard > 11, `${hard.toFixed(2)} dB`);
check('...and a wider fade always being gentler', ladder.every((v, i, a) => i === 0 || v < a[i - 1]),
  ladder.map((v) => v.toFixed(2)).join(' > '));
// A range edit moves its own keys and leaves the rest alone.
curves.setScope('trim', { lo: 57, hi: 62 }, -40, 0);
const inRange = curves.at('trim', 60), outRange = curves.at('trim', 72);
curves.setScope('trim', { lo: 57, hi: 62 }, 0, 0);
check('a range edit moves its own keys', inRange === -40, `${inRange} dB`);
check('...and leaves keys outside it alone', outRange === 0, `${outRange} dB`);
check('...and is undone by setting it back', curves.at('trim', 60) === 0, `${curves.at('trim', 60)} dB`);

// --- release level against hold time ----------------------------------------
const env = new Envelopes();
const short = env.holdLevel(0), long = env.holdLevel(env.hold.seconds), keyOff = env.holdLevel(env.hold.seconds, 0);
check('the hold law falls with hold time', long < short * 0.6, `${short.toFixed(3)} -> ${long.toFixed(3)}`);
check('key noise opts out of the hold law', Math.abs(keyOff - 1) < 1e-6, keyOff.toFixed(3));

// --- the per-key resonance level curve ---------------------------------------
// Drawn down over the top of the keyboard, the strings it covers must answer
// more quietly and the ones it does not must be untouched. strength() is where
// the curve enters every resonance voice's gain, so that is what is checked.
const res = { lo: 21, n: 88, curves: new Curves(), keyCurve: new ResCurve(21, 108), keyG: new Float64Array(88), voices: new Map() };
const refresh = () => Resonance.prototype.refreshKeyCurve.call(res);
const strength = (k) => Resonance.prototype.strength.call(res, k, 1, 100);
refresh();
const flat = [60, 72, 84, 96, 100, 108].map(strength);
res.keyCurve.fromJSON({ points: [{ k: 21, db: 0 }, { k: 84, db: 0 }, { k: 96, db: -18 }, { k: 108, db: -18 }] });
refresh();
const drawn = [60, 72, 84, 96, 100, 108].map(strength);
const ratioDb = (i) => 20 * Math.log10(drawn[i] / flat[i]);
check('the resonance curve quietens the keys it covers', [3, 4, 5].every((i) => Math.abs(ratioDb(i) + 18) < 1e-6),
  [3, 4, 5].map((i) => ratioDb(i).toFixed(1)).join(' / ') + ' dB');
check('...and leaves the keys it does not alone', [0, 1, 2].every((i) => drawn[i] === flat[i]),
  [0, 1, 2].map((i) => ratioDb(i).toFixed(1)).join(' / ') + ' dB');
res.keyCurve.fromJSON({ points: [{ k: 21, db: 0 }, { k: 96, db: 0 }, { k: 100, db: RES_FLOOR }, { k: 108, db: RES_FLOOR }] });
refresh();
check('...and turns a string off at its floor', strength(104) === 0 && strength(90) > 0,
  `${strength(104)} at the floor`);

// --- sympathetic resonance: what answers, how loud, and for how long --------
// The real engine on the real manifest, with a stand-in clock and a stand-in
// for start() that records the voice instead of making audio nodes. So this
// checks the decisions -- which strings, at what gain, kept or let go -- not
// the sound, which browser-test.mjs listens to.
const clock = { currentTime: 0 };
const lib = { m, layers: m.layers, note: (k) => m.notes[k] };
const mkRes = (opts = {}) => {
  const r = new Resonance(clock, lib, new Curves(), () => null, new Envelopes());
  Object.assign(r, { symAmount: 0.8, sbAmount: 0, selfAmount: 0, maxVoices: 32 }, opts);
  r.started = [];
  const param = { setTargetAtTime() {}, setValueCurveAtTime() {}, setValueAtTime() {}, linearRampToValueAtTime() {}, cancelScheduledValues() {} };
  r.start = function (kind, midi, g, when, fadeIn, k = 1) {
    const offset = this.startAt;
    const v = { kind, midi, key: `n${midi}`, gain: g, unit: 1, t0: when, offset, db0: this.decayDb(midi, offset),
      drivers: new Set(), k, lvl: { gain: param }, rel: { gain: param }, lp: { frequency: param }, hp: [{ frequency: param }],
      src: { stop() {}, resume() {} } };
    this.started.push(v);
    return v;
  };
  return r;
};
const sym = (r) => [...r.voices.values()].filter((v) => v.kind === 'sym');
const gainOf = (r, midi) => r.voices.get(`sym:${midi}`)?.gain ?? 0;

// Partial coincidence: from C3, a fifth and an octave answer, a tritone barely.
{
  const r = mkRes(), row = (48 - r.lo) * r.n, w = (k) => r.W[row + k - r.lo];
  check('resonance: a fifth couples more than a tritone', w(55) > 4 * w(54), `${w(55).toExponential(1)} vs ${w(54).toExponential(1)}`);
  check('resonance: so does an octave', w(60) > 4 * w(54), `${w(60).toExponential(1)} vs ${w(54).toExponential(1)}`);
}
// Only free strings answer, and never the struck one.
{
  const r = mkRes();
  r.setUndamped(new Set([48, 60, 64, 67]));
  r.excite(48, 110, 0);
  const got = sym(r).map((v) => v.midi).sort((a, b) => a - b);
  check('resonance: the undamped strings answer a strike', got.length > 0 && got.every((k) => [60, 64, 67].includes(k)), got.join(' ') || 'none');
  const none = mkRes(); none.setUndamped(new Set()); none.excite(48, 110, 0);
  check('...and with every damper down, nothing does', none.voices.size === 0, `${none.voices.size} voices`);
  const off = mkRes({ enabled: false }); off.setUndamped(new Set([60, 64, 67])); off.excite(48, 110, 0);
  check('...nor with resonance switched off', off.voices.size === 0, `${off.voices.size} voices`);
}
// Harder strikes drive the strings harder, by velocity^VEL_EXP (1.75).
{
  const a = mkRes(), b = mkRes();
  for (const r of [a, b]) r.setUndamped(new Set([67]));
  a.excite(48, 120, 0); b.excite(48, 40, 0);
  const ratio = gainOf(a, 67) / gainOf(b, 67);
  check('resonance: a harder strike drives a string harder', Math.abs(ratio - Math.pow(3, 1.75)) < 1e-9, `x${ratio.toFixed(2)}`);
}
// A string rings for as long as the note driving it sounds, then is let go.
{
  const r = mkRes();
  r.setUndamped(new Set([60, 64, 67]));
  r.excite(48, 110, 0);
  const n = r.voices.size;
  clock.currentTime = 1; r.tick(0.04, [{ midi: 48 }]);
  check('resonance: a string rings on while its driver sounds', r.voices.size === n && n > 0, `${r.voices.size} of ${n}`);
  clock.currentTime = 1.5; r.tick(0.04, []);
  check('...and is let go once it stops', r.voices.size === 0 && r.fading.size === n, `${r.voices.size} left, ${r.fading.size} fading`);
  clock.currentTime = 0;
}
// A damper landing on a ringing string stops that string alone.
{
  const r = mkRes();
  r.setUndamped(new Set([60, 67]));
  r.excite(48, 110, 0);
  r.setUndamped(new Set([67]));
  check('resonance: a damper landing stops its own string', !r.voices.has('sym:60') && r.voices.has('sym:67'),
    sym(r).map((v) => v.midi).join(' '));
}
// Struck again under the pedal, a ringing string is pushed harder, not restarted.
{
  const r = mkRes();
  r.setUndamped(new Set([67]));
  r.excite(48, 100, 0);
  const g1 = gainOf(r, 67), starts = r.started.length;
  r.excite(48, 100, 0.2);
  check('resonance: a second strike tops a string up', gainOf(r, 67) > g1 * 1.2 && r.started.length === starts,
    `x${(gainOf(r, 67) / g1).toFixed(2)}, ${r.started.length - starts} restarts`);
}
// Voices are capped, and the loudest candidates win the slots.
{
  const free = new Set(); for (let k = 49; k <= 96; k++) free.add(k);
  const all = mkRes(); all.setUndamped(free); all.excite(48, 110, 0);
  const capped = mkRes({ maxVoices: 3 }); capped.setUndamped(free); capped.excite(48, 110, 0);
  const loudest = sym(all).sort((a, b) => b.gain - a.gain).slice(0, 3).map((v) => v.midi).sort((a, b) => a - b);
  const kept = sym(capped).map((v) => v.midi).sort((a, b) => a - b);
  check('resonance: voices are capped at maxVoices', capped.voices.size === 3 && all.voices.size > 3, `${capped.voices.size} of ${all.voices.size}`);
  check('...keeping the loudest', kept.join() === loudest.join(), kept.join(' '));
}
// The soundboard carries to neighbours pedal or not, falling with distance.
{
  const r = mkRes({ symAmount: 0, sbAmount: 0.3 });
  r.setUndamped(new Set());
  r.excite(60, 110, 0);
  const near = r.voices.get('sb:61')?.gain ?? 0, far = r.voices.get('sb:72')?.gain ?? 0;
  check('resonance: the soundboard answers with the dampers down', r.voices.size > 0, `${r.voices.size} voices`);
  check('...more strongly near the key than far from it', near > far && far >= 0, `${near.toFixed(3)} vs ${far.toFixed(3)}`);
}

console.log('');
for (const [name, ok, got] of checks) console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name.padEnd(58)} ${got}`);
const ok = checks.every((c) => c[1]);
console.log(ok ? '\n  UNIT CHECK PASSED\n' : '\n  UNIT CHECK FAILED\n');
process.exit(ok ? 0 : 1);
