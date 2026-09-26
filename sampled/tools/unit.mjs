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

console.log('');
for (const [name, ok, got] of checks) console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name.padEnd(50)} ${got}`);
const ok = checks.every((c) => c[1]);
console.log(ok ? '\n  UNIT CHECK PASSED\n' : '\n  UNIT CHECK FAILED\n');
process.exit(ok ? 0 : 1);
