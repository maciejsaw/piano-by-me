// Regression suite: does the rendered audio exhibit the physics the parameters
// asked for? Run with `node tools/verify.mjs`.

import { Piano } from '../src/dsp/piano.js';
import { noteHz } from '../src/dsp/physics.js';
import { measureB, measureT60, envelope, beatRate, findPeak, peak, rms } from './analyze.mjs';

const FS = 48000;
const render = (p, seconds, script = []) => {
  const N = Math.round(FS * seconds);
  const x = new Float64Array(N);
  const buf = new Float32Array(256);
  let ev = 0;
  for (let i = 0; i < N; i += 256) {
    while (ev < script.length && script[ev].at * FS <= i) { script[ev].run(p); ev++; }
    p.render(buf, 256);
    for (let k = 0; k < 256 && i + k < N; k++) x[i + k] = buf[k];
  }
  return x;
};

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  (ok ? pass++ : fail++);
  console.log(`${ok ? ' PASS' : ' FAIL'}  ${name.padEnd(46)} ${detail}`);
};

console.log('\n=== 1. Inharmonicity: does B come out as specified? ===');
for (const midi of [33, 48, 60, 72]) {
  const p = new Piano(FS, { quality: 48, coupling: 0.0008 });
  const note = p.notes[midi - 21];
  const spec0 = note.phys.B;
  const x = render(p, 3, [{ at: 0, run: (q) => q.noteOn(midi, 0.75) }]);
  const m = measureB(x, FS, note.f0, 12, Math.round(0.15 * FS), 1 << 16, spec0);
  const spec = note.phys.B;
  const ratio = m.B / spec;
  check(`${note.name} inharmonicity`, ratio > 0.7 && ratio < 1.4,
    `spec B=${spec.toExponential(2)}  measured=${m.B.toExponential(2)}  (${ratio.toFixed(2)}x, ${m.used} partials)`);
}

console.log('\n=== 2. Decay: does T60 track the parameter? ===');
// T60 is defined as a SINGLE string's decay, so the unisons are decoupled here.
// With them coupled the composite decays in two stages (see test 2b), which is
// correct piano behaviour but is not what this parameter promises.
for (const t60 of [3, 8, 16]) {
  const p = new Piano(FS, { quality: 32, unisonCoupling: 0.02, bridgeCoupling: 0.02 });
  const note = p.notes[60 - 21];
  // Zero the detune too: a slow unison beat looks like extra decay over a short
  // measurement window, which is a measurement artefact, not a modelling one.
  for (const s of note.voices)
    p.recompileString(s, { ...s.tuning, t60Low: t60, t60High: t60 * 0.09, detuneCents: 0 });
  const x = render(p, Math.min(t60 * 0.9, 12), [{ at: 0, run: (q) => q.noteOn(60, 0.7) }]);
  // Skip the attack: energy is still moving between strings during it.
  const m = measureT60(x.slice(Math.round(0.25 * FS)), FS, note.f0, 200, Math.min(t60 * 0.6, 9));
  const ratio = m.t60 / t60;
  check(`C4 T60 = ${t60}s`, ratio > 0.75 && ratio < 1.3,
    `spec=${t60}s  measured=${m.t60.toFixed(2)}s  (${ratio.toFixed(2)}x)`);
}

{
  // Coupled unisons must show the two-stage decay a real piano has: a quick
  // initial fall while the strings are in phase, then a long aftersound.
  const p = new Piano(FS, { quality: 32 });
  const note = p.notes[60 - 21];
  const x = render(p, 8, [{ at: 0, run: (q) => q.noteOn(60, 0.8) }]);
  const early = measureT60(x, FS, note.f0, 120, 1.2).t60;
  const late = measureT60(x.slice(Math.round(2.5 * FS)), FS, note.f0, 250, 5).t60;
  check('2b. coupled unisons give two-stage decay', late > early * 1.25,
    `early T60 ${early.toFixed(1)}s -> aftersound T60 ${late.toFixed(1)}s`);
}

console.log('\n=== 3. Unison beating: does detuning produce the right beat rate? ===');
for (const cents of [0.8, 2.0, 4.0]) {
  // Near-zero coupling, so this measures detuning alone. `coupling` was not a
  // real option, so this had silently been running at full coupling.
  // Near-zero coupling AND no entrainment, so this measures detuning alone.
  // `coupling` was not a real option, so this had silently been running at full
  // coupling; and with the unison lock on, the strings are pulled together and
  // there is no beat left to measure.
  const p = new Piano(FS, { quality: 24, unisonCoupling: 0.0004, bridgeCoupling: 0.0004, unisonLock: 0 });
  const note = p.notes[60 - 21];
  const offs = [-cents, 0, cents];
  note.voices.forEach((s, i) => p.recompileString(s, { ...s.tuning, detuneCents: offs[i] }));
  const x = render(p, 5, [{ at: 0, run: (q) => q.noteOn(60, 0.7) }]);
  const env = envelope(x, FS, note.f0, 15, 4.5);
  const rate = beatRate(env);
  // Three strings at -c, 0, +c beat at both c and 2c spacings.
  const adj = note.f0 * (Math.pow(2, cents / 1200) - 1);
  const outer = note.f0 * (Math.pow(2, (2 * cents) / 1200) - 1);
  const near = (t) => rate > t * 0.7 && rate < t * 1.4;
  check(`C4 unison spread ${cents}c`, near(adj) || near(outer),
    `expect ${adj.toFixed(2)} or ${outer.toFixed(2)} Hz  measured=${rate.toFixed(2)}Hz`);
}

console.log('\n=== 4. Sympathetic resonance (the real test) ===');
{
  // Silently depress C4 (dampers up, never struck), then strike C3 staccato.
  // C4's strings should pick up energy through the bridge and keep ringing
  // after C3 is released.
  const target = 60, driver = 48;
  const f0 = noteHz(target);
  const withSymp = new Piano(FS, { quality: 32 });
  const silent = (q) => { for (const s of q.notes[target - 21].voices) s.setDamper(false); q.refreshActive(); };
  const xs = render(withSymp, 4, [
    { at: 0.0, run: silent },
    { at: 0.1, run: (q) => q.noteOn(driver, 0.95) },
    { at: 0.7, run: (q) => q.noteOff(driver) },
  ]);
  // Control: identical, but C4's dampers stay DOWN.
  const noSymp = new Piano(FS, { quality: 32 });
  const xn = render(noSymp, 4, [
    { at: 0.1, run: (q) => q.noteOn(driver, 0.95) },
    { at: 0.7, run: (q) => q.noteOff(driver) },
  ]);
  const start = Math.round(1.6 * FS), len = Math.round(2.0 * FS);
  const a = findPeak(xs, FS, f0, 0.01, start, len).mag;
  const b = findPeak(xn, FS, f0, 0.01, start, len).mag;
  const db = 20 * Math.log10(a / (b + 1e-18));
  check('C4 rings sympathetically from C3', db > 12,
    `undamped is ${db.toFixed(1)} dB above damped at C4's f0`);
}

console.log('\n=== 5. Sustain pedal lifts all dampers ===');
{
  const f0 = noteHz(67);
  const p = new Piano(FS, { quality: 24 });
  const x = render(p, 4, [
    { at: 0.0, run: (q) => q.setSustain(true) },
    { at: 0.1, run: (q) => q.noteOn(55, 0.95) },
    { at: 0.6, run: (q) => q.noteOff(55) },
  ]);
  const q2 = new Piano(FS, { quality: 24 });
  const y = render(q2, 4, [
    { at: 0.1, run: (q) => q.noteOn(55, 0.95) },
    { at: 0.6, run: (q) => q.noteOff(55) },
  ]);
  const start = Math.round(1.5 * FS), len = Math.round(2 * FS);
  const db = 20 * Math.log10(rms(x, start, len) / (rms(y, start, len) + 1e-18));
  check('pedal down sustains after note-off', db > 15, `pedal adds ${db.toFixed(1)} dB of tail`);
}

console.log('\n=== 6. Sympathetic halo is loud enough to hear ===');
{
  const run = (pedal) => {
    const p = new Piano(FS, { quality: 24 });
    const x = render(p, 5, [
      { at: 0, run: (q) => pedal && q.setSustain(true) },
      { at: 0.05, run: (q) => { q.noteOn(48, 1); q.noteOn(52, 1); q.noteOn(55, 1); } },
      { at: 0.35, run: (q) => { q.noteOff(48); q.noteOff(52); q.noteOff(55); } },
    ]);
    return { pk: peak(x), halo: rms(x, Math.round(2.5 * FS), Math.round(2 * FS)) };
  };
  const on = run(true), off = run(false);
  const db = 20 * Math.log10(on.halo / on.pk);
  const offDb = 20 * Math.log10(off.halo / off.pk);
  check('pedal-down halo is audible', db > -40 && db < -8,
    `halo is ${db.toFixed(1)} dB below the strike peak`);
  check('halo needs the pedal', db - offDb > 40,
    `pedal down ${db.toFixed(1)} dB vs pedal up ${offDb.toFixed(1)} dB`);
}

console.log('\n=== 7. Body: does the case change the sound, and only downstream? ===');
{
  const spec = (x, lo, hi) => {
    let s = 0;
    for (let f = lo; f < hi; f *= 1.06) s += Math.pow(findPeak(x, FS, f, 0.001, Math.round(0.05 * FS), 1 << 14).mag, 2);
    return 10 * Math.log10(s + 1e-18);
  };
  const run = (body) => {
    const p = new Piano(FS, { quality: 20, body, gain: 1 });
    return render(p, 2, [{ at: 0, run: (q) => q.noteOn(60, 0.75) }]);
  };
  const off = run({ enabled: false }), on = run({});
  const tiltOff = spec(off, 2000, 8000) - spec(off, 100, 400);
  const tiltOn = spec(on, 2000, 8000) - spec(on, 100, 400);
  check('body tilts the spectrum toward treble', tiltOn - tiltOff > 3,
    `high-minus-low tilt ${tiltOff.toFixed(1)} dB -> ${tiltOn.toFixed(1)} dB`);

  // The body is downstream of every coupling path, so it must not disturb the
  // string physics at all -- same partials, same inharmonicity.
  const bOff = measureB(off, FS, noteHz(60), 12, Math.round(0.15 * FS), 1 << 16, 3e-4);
  const bOn = measureB(on, FS, noteHz(60), 12, Math.round(0.15 * FS), 1 << 16, 3e-4);
  check('body leaves string physics untouched', Math.abs(bOn.B / bOff.B - 1) < 0.10,
    `B ${bOff.B.toExponential(2)} -> ${bOn.B.toExponential(2)}`);
}

console.log('\n=== 8. Stability: loud cluster, pedal down, long tail ===');
{
  const p = new Piano(FS, { quality: 32 });
  const script = [{ at: 0, run: (q) => q.setSustain(true) }];
  for (let i = 0; i < 12; i++) script.push({ at: 0.05 * i, run: (q) => q.noteOn(36 + i * 5, 1.0) });
  const x = render(p, 12, script);
  const tail = rms(x, Math.round(10 * FS), Math.round(1.5 * FS));
  const mid = rms(x, Math.round(1 * FS), Math.round(1.5 * FS));
  const allFinite = x.every(Number.isFinite);
  check('no NaN / Inf over 12s', allFinite, `peak=${peak(x).toFixed(3)}`);
  check('stays below the clip ceiling', peak(x) < 0.99, `peak=${peak(x).toFixed(3)}`);
  check('energy decays rather than grows', tail < mid, `mid rms=${mid.toExponential(2)} tail rms=${tail.toExponential(2)}`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
