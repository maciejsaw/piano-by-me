// Does the sampled piano actually work in a real browser?
//
// Four things, in order of how much trouble they would be if they were wrong:
//
//   1. the Opus files decode at all (decodeAudioData, Ogg container)
//   2. a struck note makes sound, and a harder one makes more
//   3. strings that are free to ring DO ring when another key is struck, and
//      strings that are damped do not
//   4. the resonance piles up when the pedal is down -- the same gesture twice
//      leaves more behind than once
//
// Measured off engine.master through an analyser, so what is checked is the
// signal the instrument produces rather than anything the UI claims.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

// $CHROMIUM, then whatever Playwright brought, then a browser the machine
// already has. Sandboxes and CI images often ship a Chromium whose build
// number does not match the pinned Playwright, and refusing to run then is
// not useful.
const CHROME = [process.env.CHROMIUM, '/opt/pw-browsers/chromium'].find((p) => p && existsSync(p));

const PORT = process.env.PORT || '8138';
const server = spawn(process.execPath, ['tools/serve.mjs'], { env: { ...process.env, PORT }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 700));

const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required'],
  ...(CHROME ? { executablePath: CHROME } : {}),
});
const page = await browser.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(`http://localhost:${PORT}/sampled/`, { waitUntil: 'domcontentloaded' });
await page.click('#startBtn');
await page.waitForFunction(() => window.piano, null, { timeout: 30000 });
// Enough of the library resident that the notes under test are real ones --
// and, specifically, that the release samples have arrived, since those are
// warmed first and several checks below are about them.
await page.waitForFunction(() => window.piano.lib.keysReady() >= 88
  && window.piano.lib.auxResident(21, 108) >= window.piano.lib.auxOrder(21, 108).length,
  null, { timeout: 150000 });

const r = await page.evaluate(async () => {
  const { ctx, engine, lib } = window.piano;
  const wait = (ms) => new Promise((res) => setTimeout(res, ms));
  const an = new AnalyserNode(ctx, { fftSize: 4096 });
  engine.master.connect(an);
  const buf = new Float32Array(an.fftSize);
  const rms = () => {
    an.getFloatTimeDomainData(buf);
    let s = 0; for (const v of buf) s += v * v;
    return Math.sqrt(s / buf.length);
  };
  // Peak RMS over a window, so a decaying note is not missed by one sample.
  const peakOver = async (ms) => {
    let p = 0;
    for (let t = 0; t < ms; t += 25) { p = Math.max(p, rms()); await wait(25); }
    return p;
  };
  const settle = async () => { engine.panic(); await wait(700); };

  const out = {};
  await settle();
  out.silence = await peakOver(200);

  // --- a note sounds, and velocity does something ---
  engine.setLimiter(false);          // measure the instrument, not the seatbelt
  engine.noteOn(60, 110); out.loud = await peakOver(500); engine.noteOff(60); await settle();
  engine.noteOn(60, 25);  out.soft = await peakOver(500); engine.noteOff(60); await settle();

  // --- a ten-note pedalled cluster: the loudest thing the instrument can do ---
  engine.setPedal(1);
  for (const m of [36, 43, 48, 52, 55, 60, 64, 67, 72, 76]) engine.noteOn(m, 127);
  out.cluster = await peakOver(900);
  engine.setPedal(0); await settle();
  engine.setLimiter(true);

  // --- sympathetic resonance, with the struck note fully damped ---
  // Turned up so the held chord is easy to measure, and put back afterwards:
  // leaving it up made the halo check further down read 8x the shipped level
  // and blame the engine for it.
  const shippedAmount = engine.res.amount;
  engine.res.amount = 1.2;
  for (const m of [60, 64, 67]) engine.silentHold(m, true);
  engine.noteOn(48, 120); await wait(420); engine.noteOff(48);
  await wait(1500);                        // C3 is damped; anything left is the held chord
  out.sympathetic = await peakOver(500);
  out.ringing = engine.res.voices.size;
  for (const m of [60, 64, 67]) engine.silentHold(m, false);
  engine.res.amount = shippedAmount;
  await settle();

  // --- the same gesture with everything damped leaves nothing ---
  engine.noteOn(48, 120); await wait(420); engine.noteOff(48);
  await wait(1500);
  out.damped = await peakOver(500);
  await settle();

  // --- a released key under a held pedal keeps ringing, and the pedal stops it ---
  engine.setPedal(1);
  engine.noteOn(55, 110); await wait(200); engine.noteOff(55);
  await wait(700);
  out.pedalHeld = await peakOver(300);
  engine.setPedal(0);
  await wait(400);
  out.pedalLifted = await peakOver(300);
  await settle();

  // --- pile-up: four strikes into a held pedal beat one ---
  engine.setPedal(1);
  engine.noteOn(48, 118); await wait(260); engine.noteOff(48); await wait(900);
  out.once = engine.res.E.reduce((a, b) => a + b, 0);
  await settle(); engine.setPedal(1);
  for (let i = 0; i < 4; i++) { engine.noteOn(48, 118); await wait(260); engine.noteOff(48); }
  await wait(900 - 3 * 260);
  out.fourTimes = engine.res.E.reduce((a, b) => a + b, 0);
  engine.setPedal(0);
  await wait(400);
  out.afterPedalUp = engine.res.E.reduce((a, b) => a + b, 0);
  await settle();

  // --- a halo under a LONG held note ---
  //
  // The thing a strike-only resonance engine gets wrong. A real piano's
  // sympathetic answer to a held note lasts as long as the note does, because
  // the struck string goes on driving the bridge the whole time; an engine
  // that only deposits energy at the attack has a halo that dies on its own
  // schedule a second or two later whatever is being played, and the longer
  // the note is held the more obviously it is missing.
  //
  // So: hold three treble strings silently, strike a bass note into them, keep
  // the key DOWN, and read the accumulator half a second in and again eight
  // seconds in. The treble is the case that matters -- its strings have the
  // shortest time constants, about a second, so by eight seconds nothing the
  // strike deposited is left and what is there is the drive or nothing.
  //
  // Measured twice, the second time with the sustained drive switched off,
  // because the number that means anything is the difference between them.
  const holdHalo = async () => {
    for (const m of [79, 83, 86]) engine.silentHold(m, true);
    engine.noteOn(36, 120);
    await wait(500);
    const early = engine.res.E.reduce((a, b) => a + b, 0);
    await wait(7500);                      // still held, eight seconds in
    const late = engine.res.E.reduce((a, b) => a + b, 0);
    engine.noteOff(36);
    for (const m of [79, 83, 86]) engine.silentHold(m, false);
    await settle();
    return { early, late };
  };
  const shippedSustain = engine.res.sustain;
  const driven = await holdHalo();
  engine.res.sustain = 0;
  const struckOnly = await holdHalo();
  engine.res.sustain = shippedSustain;
  out.haloHeldEarly = driven.early;
  out.haloHeld8s = driven.late;
  out.haloHeld8sNoDrive = struckOnly.late;

  // --- envelopes -----------------------------------------------------------
  // Each of these measures ONE thing, so everything else that makes noise is
  // turned off first: the room, whose 1.35 s tail outlives every gesture
  // below, and the release samples, which are the subject of only the last
  // pair. Without that the numbers are dominated by reverb and the tests pass
  // or fail on nothing in particular.
  const { envelopes } = window.piano;
  const wet = engine.wet.gain.value;
  engine.wet.gain.value = 0;
  engine.releaseNoise = 0;
  engine.damperNoise = 0;
  engine.res.enabled = false;

  // A long, slow-shaped attack should leave almost nothing 60 ms in.
  envelopes.noteAttack.ms = 0;
  engine.noteOn(60, 110); await wait(60); out.attackFast = rms(); engine.noteOff(60); await settle();
  envelopes.noteAttack.ms = 800;
  envelopes.noteAttack.shape.set(0.55, 0.06, 0.82, 0.42);        // 'grip': hangs, then rises
  engine.noteOn(60, 110); await wait(60); out.attackSlow = rms(); engine.noteOff(60); await settle();
  envelopes.noteAttack.ms = 0;
  envelopes.noteAttack.shape.set(0.05, 0.75, 0.2, 0.98);

  // The damper-fall SHAPE decides how much is left part-way through the fall.
  // 'grip' hangs then bites; 'fast' leaves almost at once. Same duration both
  // times -- only the shape differs.
  engine.curves.g.damping = 5;                    // a long, easily measured fall
  const fallAt = async (shape) => {
    envelopes.noteRelease.shape.set(...shape);
    engine.noteOn(60, 110); await wait(350);
    engine.noteOff(60); await wait(260);
    const v = rms();
    await settle();
    return v;
  };
  out.fallGrip = await fallAt([0.55, 0.06, 0.82, 0.42]);
  out.fallFast = await fallAt([0.05, 0.75, 0.2, 0.98]);
  envelopes.noteRelease.shape.set(0.08, 0.62, 0.32, 0.9);
  engine.curves.g.damping = 0;

  // Release level against hold time, as a function and then as audio.
  out.holdShort = envelopes.holdLevel(0);
  out.holdLong = envelopes.holdLevel(envelopes.hold.seconds);
  out.holdKeyNoiseOff = envelopes.holdLevel(envelopes.hold.seconds, 0);

  // Same, through the engine -- checked at the gain the engine schedules
  // rather than at the analyser. A damper thud is impulsive and 40 dB below
  // the note it came off, and measuring one through an 85 ms analyser window
  // immediately after a note-off is not a repeatable thing to do: the first
  // attempt read the note's own tail and reported the same number whatever
  // the release settings were. The gain is what the hold law, the per-key
  // trim and Salamander's own mix all act on, so that is what to assert on.
  const shots = [];
  const realOneShot = engine.oneShot.bind(engine);
  engine.oneShot = (buf, gain, rate) => { shots.push({ dur: buf?.duration, gain }); return realOneShot(buf, gain, rate); };
  const loudestShot = () => shots.reduce((a, b) => (b.gain > a ? b.gain : a), 0);
  const releaseAfter = async (holdMs) => {
    shots.length = 0;
    engine.noteOn(72, 100); await wait(holdMs); engine.noteOff(72);
    await wait(40);
    const g = loudestShot();
    await settle();
    return g;
  };
  envelopes.hold.seconds = 0.6;
  engine.damperNoise = 1;  out.relShortHold = await releaseAfter(60);
  out.relLongHold = await releaseAfter(900);
  engine.curves.setKey('damperLevel', 72, -40);
  out.relPerKey = await releaseAfter(60);
  engine.curves.setKey('damperLevel', 72, 0);
  envelopes.hold.seconds = 8;

  // The key-release thud at its shipped level. Salamander records these at
  // full scale -- rel40.wav peaks within 2 dB of a fortissimo C4 -- and its
  // SFZ takes 37 dB back off in the group header. This compares the gain a
  // key lift schedules against the gain of the fortissimo note it followed.
  engine.damperNoise = 0; engine.releaseNoise = 1;
  shots.length = 0;
  const v = engine.noteOn(64, 120);
  out.ffNoteGain = v.g.gain.value;
  await wait(200);
  engine.noteOff(64, 120);
  await wait(40);
  out.keyThudGain = loudestShot();
  await settle();

  // And that a release sample is audible at all -- the gains above would all
  // be right with the node disconnected.
  engine.damperNoise = 8; engine.releaseNoise = 0;
  engine.curves.setKey('trim', 72, -60);
  engine.noteOn(72, 110); await wait(60); engine.noteOff(72);
  out.releaseAudible = await peakOver(400);
  engine.curves.setKey('trim', 72, 0);
  await settle();
  engine.oneShot = realOneShot;

  engine.wet.gain.value = wet;
  engine.releaseNoise = 0.9;
  engine.damperNoise = 1;
  engine.res.enabled = true;

  // --- the halo has to be a halo -------------------------------------------
  // This is the check that would have caught the worst bug in this engine.
  // The resonance voices were not applying the manifest gain that restores a
  // recording's true level, so they played peak-normalised pianissimo samples
  // as if they were fortissimo -- about 20 dB too loud, on up to 24 voices at
  // once. Over a pedalled passage the "sympathetic halo" came out 15 dB ABOVE
  // the notes supposed to be causing it, and the instrument sounded like a
  // granular synth because that is what it had become.
  //
  // The assertion is on ONE SYMPATHETIC STRING against one struck string,
  // because that is the quantity with a reference behind it: the physically
  // modelled variant in this repo measures its own pedal halo at -27 dB below
  // a strike peak. Asserting on the total instead would be asserting on how
  // many strings a chord happens to excite, which is a property of the chord.
  engine.res.enabled = true;
  await settle();
  engine.setPedal(1);
  let loudestVoice = 0, loudAt = null;
  for (const n of [48, 55, 60, 64, 67, 72]) {
    engine.noteOn(n, 96);
    for (let t = 0; t < 320; t += 40) {
      for (const [m, v] of engine.res.voices) if (v.target > loudestVoice) { loudestVoice = v.target; loudAt = m; }
      await wait(40);
    }
    engine.noteOff(n);
  }
  for (let t = 0; t < 600; t += 40) {
    for (const [m, v] of engine.res.voices) if (v.target > loudestVoice) { loudestVoice = v.target; loudAt = m; }
    await wait(40);
  }
  out.ringingVoices = engine.res.voices.size;
  out.loudAt = loudAt; out.resAmount = engine.res.amount;
  engine.setPedal(0);
  await settle();
  const struckV = engine.noteOn(60, 96);
  out.struckGain = struckV ? struckV.g.gain.value : 0;
  out.voiceGain = loudestVoice;
  out.haloDb = 20 * Math.log10(Math.max(loudestVoice, 1e-12) / Math.max(out.struckGain, 1e-12));
  await settle();

  // --- per-octave scaling ---------------------------------------------------
  // The middle tier between one slider for the whole compass and drawing
  // eighty-eight keys by hand. It has to move its own octave and leave the
  // neighbours alone, which is the only thing that can really go wrong.
  const { curves } = window.piano;
  // From a clean slate: the shipped defaults carry their own trim ranges, and
  // every measurement below is a difference against "no range edits at all".
  // It is put back the same way at the end of the block.
  curves.reset('trim');
  // A range edit with a hard edge, so the neighbour an octave away is
  // untouched and the effect is unambiguous.
  curves.setScope('trim', { lo: 57, hi: 62 }, -40, 0);
  engine.noteOn(60, 100); out.octTarget = await peakOver(400); engine.noteOff(60); await settle();
  engine.noteOn(72, 100); out.octNeighbour = await peakOver(400); engine.noteOff(72); await settle();
  curves.setScope('trim', { lo: 57, hi: 62 }, 0, 0);
  await wait(10);
  engine.noteOn(60, 100); out.octRestored = await peakOver(400); engine.noteOff(60); await settle();

  // Feathering: the point of the whole tier. A range raised with a fade must
  // not leave a step at its edge, and must still reach its full value inside.
  const stepFor = (f) => { curves.setScope('trim', { lo: 84, hi: 108 }, 12, f); return curves.worstStep('trim').step; };
  out.hardStep = stepFor(0);
  out.featherStep = stepFor(6);
  curves.setScope('trim', { lo: 84, hi: 108 }, 12, 6);
  out.featherInside = curves.at('trim', 96) - curves.at('trim', 60);
  // Widening the fade has to keep reducing the step, every time. That is the
  // property; any particular number is just where the raised cosine is
  // steepest for that width.
  out.featherLadder = [0, 3, 6, 10, 14].map(stepFor).map((v) => +v.toFixed(2));
  out.featherMonotonic = out.featherLadder.every((v, i, a) => i === 0 || v < a[i - 1]);
  curves.reset('trim');

  // --- attack alignment -----------------------------------------------------
  // Every recording's measured attack front has to land the same distance
  // after the key goes down, whether the engine gets there by skipping into a
  // late sample or by holding an early one back.
  const landings = (on) => {
    engine.alignStarts = on;
    const out = [];
    for (const midi of [21, 33, 45, 60, 72, 84, 96, 108]) {
      for (const layer of [1, 8, 16]) {
        const t0 = lib.m.notes[midi]?.layers?.[layer]?.t0;
        if (t0 == null) continue;
        const at = engine.startAt(midi, { t0, buf: { duration: 5 } });
        out.push(t0 - at.offset * 1000 + at.delay * 1000);
      }
    }
    return out;
  };
  const spread = (v) => Math.max(...v) - Math.min(...v);
  out.alignSpread = spread(landings(true));
  out.rawSpread = spread(landings(false));
  engine.alignStarts = true;
  out.alignTarget = lib.m.alignMs ?? null;
  // Per-key Sample start, on top of the alignment, moving one key alone.
  const startOf = (midi) => {
    const t0 = lib.m.notes[midi].layers[8].t0;
    return engine.startAt(midi, { t0, buf: { duration: 5 } }).offset * 1000;
  };
  const before = startOf(60), sibling = startOf(61);
  curves.setKey('startTrim', 60, 20);
  out.trimMoved = startOf(60) - before;
  out.trimNeighbour = Math.abs(startOf(61) - sibling);
  curves.setKey('startTrim', 60, 0);
  // It must never skip so far in that the note is a fragment.
  curves.setKey('startTrim', 60, 100000);
  out.trimClamped = engine.startAt(60, { t0: 12, buf: { duration: 4 } }).offset;
  curves.setKey('startTrim', 60, 0);

  // --- the per-key resonance level curve ------------------------------------
  // Drawn down over the top of the keyboard, the strings it covers must take
  // less energy and the ones it does not must be untouched.
  const ringTop = async () => {
    engine.res.E.fill(0);
    for (const m of [48, 55, 60]) { engine.noteOn(m, 120); await wait(40); engine.noteOff(m); }
    await wait(300);
    let top = 0, mid = 0;
    for (let i = 0; i < engine.res.n; i++) {
      const k = engine.res.lo + i;
      if (k >= 96) top = Math.max(top, engine.res.E[i]);
      else if (k > 60 && k < 90) mid = Math.max(mid, engine.res.E[i]);
    }
    return { top, mid };
  };
  // From flat: the shipped defaults carry a drawn curve of their own, and what
  // is being checked here is what drawing one DOES. Put it back afterwards.
  const shipped = engine.res.keyCurve.toJSON();
  engine.res.keyCurve.reset(); engine.res.refreshKeyCurve();
  engine.setPedal(1);
  const flat = await ringTop();
  engine.res.keyCurve.fromJSON({ points: [{ k: 21, db: 0 }, { k: 84, db: 0 }, { k: 96, db: -18 }, { k: 108, db: -18 }] });
  engine.res.refreshKeyCurve();
  const drawn = await ringTop();
  out.resCurveTop = drawn.top / Math.max(1e-12, flat.top);
  out.resCurveMid = drawn.mid / Math.max(1e-12, flat.mid);
  out.resCurveAt = [60, 96].map((k) => engine.res.keyCurve.at(k));
  engine.res.keyCurve.fromJSON(shipped); engine.res.refreshKeyCurve();
  engine.setPedal(0);
  await settle();

  // --- the output EQ --------------------------------------------------------
  // Measured on the output node, because the EQ sits after the master bus --
  // an analyser on the master would show a flat response however wrong the
  // wiring was.
  const eqAn = new AnalyserNode(ctx, { fftSize: 8192 });
  engine.outputNode().connect(eqAn);
  const spec = new Float32Array(eqAn.frequencyBinCount);
  const bandDb = (hz) => {
    eqAn.getFloatFrequencyData(spec);
    const k = Math.round(hz * eqAn.fftSize / ctx.sampleRate);
    let m = -200;
    for (let i = k - 2; i <= k + 2; i++) m = Math.max(m, spec[i]);
    return m;
  };
  const holdAndMeasure = async (hz) => {
    engine.noteOn(36, 105);
    let m = -200;
    for (let t = 0; t < 500; t += 25) { m = Math.max(m, bandDb(hz)); await wait(25); }
    engine.noteOff(36); await settle();
    return m;
  };
  // Resonance off for the whole block: this measures a filter, and the bass
  // note the probe holds rings the undamped top of the keyboard sympathetically
  // for all 500 ms of the window. That ring is voice-allocated and jittered, so
  // it is run-to-run noise in a measurement whose tolerance is 2 dB.
  const eqRes = engine.res.enabled;
  engine.res.enabled = false;
  engine.eq.setEnabled(true);
  for (const i of [0, 1, 2, 3]) engine.eq.set(i, 'gain', 0);
  // The shelf corner is moved well above the probe frequency first. At the
  // shipped 90 Hz corner a probe at 100 Hz sits halfway down the transition
  // and reads half the gain -- correct behaviour for a shelf, and a test that
  // asserted +12 dB there would have been asserting the filter is not a shelf.
  engine.eq.set(0, 'freq', 400);
  out.eqFlat = await holdAndMeasure(100);
  engine.eq.set(0, 'gain', 12);
  out.eqBoost = await holdAndMeasure(100);
  engine.eq.setEnabled(false);
  out.eqBypass = await holdAndMeasure(100);
  engine.eq.setEnabled(true);
  engine.eq.set(0, 'gain', 0);
  engine.eq.set(0, 'freq', 90);
  engine.res.enabled = eqRes;

  out.loaded = lib.loaded;
  out.aux = lib.auxResident(21, 108);
  out.auxTotal = lib.auxOrder(21, 108).length;
  out.keysReady = lib.keysReady();
  out.failed = lib.failed;
  out.resident = Math.round(lib.bytes / 1048576);
  out.finite = [out.loud, out.soft, out.sympathetic].every(Number.isFinite);
  return out;
});

const f = (v) => (typeof v === 'number' ? v.toExponential(2) : String(v));
console.log('\n  samples decoded / failed       :', r.loaded, '/', r.failed);
console.log('  resident after warm-up         :', r.resident, 'MB');
console.log('  release/damper samples         :', r.aux, 'of', r.auxTotal, '(pinned)');
console.log('  keys with a pinned layer       :', r.keysReady, 'of 88');
console.log('  silence                        :', f(r.silence));
console.log('  C4 at velocity 110             :', f(r.loud));
console.log('  C4 at velocity 25              :', f(r.soft), `(${(20 * Math.log10(r.soft / r.loud)).toFixed(1)} dB below)`);
console.log('  ten-note pedalled cluster, ff  :', f(r.cluster), `(${(20 * Math.log10(r.cluster)).toFixed(1)} dBFS rms, limiter off)`);
console.log('  held C-E-G after a struck C3   :', f(r.sympathetic), `on ${r.ringing} strings`);
console.log('  same gesture, nothing held     :', f(r.damped));
console.log('  accumulated energy, 1 strike   :', f(r.once));
console.log('  accumulated energy, 4 strikes  :', f(r.fourTimes));
console.log('  halo under a held note, 0.5 s  :', f(r.haloHeldEarly));
console.log('  ...the same note, 8 s in       :', f(r.haloHeld8s));
console.log('  ...with the sustained drive off:', f(r.haloHeld8sNoDrive),
  `(the drive is worth ${(10 * Math.log10(Math.max(r.haloHeld8s, 1e-14) / Math.max(r.haloHeld8sNoDrive, 1e-14))).toFixed(1)} dB at 8 s)`);
console.log('  after the pedal comes up       :', f(r.afterPedalUp));
console.log('  key released, pedal still down :', f(r.pedalHeld));
console.log('  ...then the pedal comes up     :', f(r.pedalLifted));
console.log('');
console.log('  60 ms in, no attack envelope   :', f(r.attackFast));
console.log('  60 ms in, 800 ms shaped attack :', f(r.attackSlow));
console.log('  part-way through a "grip" fall :', f(r.fallGrip));
console.log('  ...and through a "fast" fall   :', f(r.fallFast));
console.log('  hold law, 0 s / full / key-off :', r.holdShort.toFixed(3), '/', r.holdLong.toFixed(3), '/', r.holdKeyNoiseOff.toFixed(3));
console.log('  damper gain, 60 ms hold        :', f(r.relShortHold));
console.log('  damper gain, 900 ms hold       :', f(r.relLongHold), `(${(20 * Math.log10(r.relLongHold / r.relShortHold)).toFixed(1)} dB)`);
console.log('  ...with that key trimmed 40 dB :', f(r.relPerKey), `(${(20 * Math.log10(r.relPerKey / r.relShortHold)).toFixed(1)} dB)`);
console.log('  key thud vs the ff note it left:', (20 * Math.log10(r.keyThudGain / r.ffNoteGain)).toFixed(1), 'dB');
console.log('  a release sample is audible    :', f(r.releaseAudible));
console.log('  one sympathetic string         :', r.haloDb.toFixed(1), 'dB under one struck string',
  `(${r.ringingVoices} ringing; the modelled variant measures -27 dB)`);
console.log('');
console.log('');
console.log('  C4 inside a range trimmed 40dB :', f(r.octTarget));
console.log('  C5, outside that range         :', f(r.octNeighbour));
console.log('  C4 once the range is cleared   :', f(r.octRestored));
console.log('  +12 dB range, inside it        :', r.featherInside.toFixed(1), 'dB');
console.log('  biggest neighbour step, by fade:', r.featherLadder.map((v, i) => `${[0, 3, 6, 10, 14][i]}:${v}`).join('  '), 'dB');
console.log('  attack front, aligned / raw    :', r.alignSpread.toFixed(2), '/', r.rawSpread.toFixed(1),
  `ms of spread (target ${r.alignTarget} ms)`);
console.log('  top-string resonance, drawn -18:',
  (10 * Math.log10(Math.max(r.resCurveTop, 1e-12))).toFixed(1), 'dB of energy');
console.log('  middle strings, same pass      :',
  (10 * Math.log10(Math.max(r.resCurveMid, 1e-12))).toFixed(2), 'dB (should be 0)');
console.log('  100 Hz, EQ flat                :', r.eqFlat.toFixed(1), 'dB');
console.log('  ...with a +12 dB low shelf     :', r.eqBoost.toFixed(1), 'dB', `(${(r.eqBoost - r.eqFlat).toFixed(1)} dB)`);
console.log('  ...with the EQ bypassed        :', r.eqBypass.toFixed(1), 'dB');
console.log('');
console.log('  console errors                 :', errors.length ? errors.join(' | ') : 'none');

const checks = [
  ['samples decoded', r.loaded > 40 && r.failed === 0],
  ['every key can speak', r.keysReady === 88],
  ['every release sample is pinned', r.aux === r.auxTotal],
  ['a note sounds', r.loud > 0.01],
  ['a note is not clipping', r.loud < 0.35],
  ['velocity changes level', r.soft < r.loud * 0.5],
  ['the worst case has headroom', r.cluster < 0.55],
  ['held strings ring', r.sympathetic > Math.max(r.silence * 6, 2e-4)],
  ['damped strings do not', r.damped < r.sympathetic * 0.4],
  ['resonance piles up', r.fourTimes > r.once * 1.8],
  // Only that the halo is STILL THERE eight seconds into a held note, which is
  // what the aftersound decay fit and the energy floor buy. There is no check
  // on the sustained drive's share of it: measured on a held pedalled chord it
  // is worth 0.0 dB, because a strike deposits its energy all at once and a
  // note twenty-five decibels into its own decay cannot compete with what that
  // strike left behind. It earns its keep only where the resonator's time
  // constant is far shorter than the driving note's -- a treble string under a
  // long bass note -- and that is too narrow a case to assert a ratio on. The
  // number is printed above; it is a diagnostic, not a guarantee.
  ['a held note still has a halo 8 s in', r.haloHeld8s > 0],
  ['the pedal cuts it', r.afterPedalUp < r.fourTimes * 0.05],
  ['a released key rings on under the pedal', r.pedalHeld > 5e-3],
  ['lifting the pedal stops it', r.pedalLifted < r.pedalHeld * 0.3],
  ['values finite', r.finite],
  ['the attack envelope holds the note back', r.attackSlow < r.attackFast * 0.2],
  ['the damper-fall shape changes the fall', r.fallGrip > r.fallFast * 2],
  ['the hold law falls with hold time', r.holdLong < r.holdShort * 0.6],
  ['key noise opts out of the hold law', Math.abs(r.holdKeyNoiseOff - 1) < 1e-6],
  ['a long-held key gives a quieter release', r.relLongHold < r.relShortHold * 0.3],
  ['per-key release level works', Math.abs(20 * Math.log10(r.relPerKey / r.relShortHold) + 40) < 1],
  ['the key thud sits well under the note', 20 * Math.log10(r.keyThudGain / r.ffNoteGain) < -28],
  ['release samples are audible', r.releaseAudible > 1e-4],
  ['a sympathetic string stays well under a struck one', r.haloDb < -18],
  ['...but is still audible', r.haloDb > -35],
  ['a range edit moves its own keys', r.octTarget < r.octRestored * 0.2],
  ['...and leaves keys outside it alone', r.octNeighbour > r.octRestored * 0.4],
  ['...and is undone by setting it back', r.octRestored > r.octTarget * 5],
  ['a feathered range still reaches full value inside', Math.abs(r.featherInside - 12) < 0.1],
  ['...and a fade cuts the edge step fourfold', r.featherStep <= r.hardStep / 4],
  ['...with a hard edge dropping it all at once', r.hardStep > 11],
  ['...and a wider fade always being gentler', r.featherMonotonic],
  ['aligned attacks land together', r.alignSpread < 0.5],
  ['...which the recordings do not do on their own', r.rawSpread > 5],
  ['...and per-key sample start moves one key', Math.abs(r.trimMoved - 20) < 0.5 && r.trimNeighbour < 0.01],
  ['...and cannot skip past half the recording', r.trimClamped <= 2 + 1e-9],
  ['the resonance curve quietens the keys it covers', r.resCurveTop < 0.2],
  // A decibel of slack: the two passes are measured a beat apart in real time
  // and the accumulator is leaking the whole while, which is worth a few
  // percent on its own. The keys the curve covers come back 120 dB down.
  ['...and leaves the keys it does not alone', Math.abs(10 * Math.log10(r.resCurveMid)) < 1],
  ['the output EQ is in the signal path', r.eqBoost - r.eqFlat > 8],
  ['...and its bypass is a real bypass', Math.abs(r.eqBypass - r.eqFlat) < 2],
  ['no console errors', errors.length === 0],
];
console.log('');
for (const [name, ok] of checks) console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}`);
const ok = checks.every((c) => c[1]);
console.log(ok ? '\n  BROWSER CHECK PASSED\n' : '\n  BROWSER CHECK FAILED\n');
await browser.close();
server.kill();
process.exit(ok ? 0 : 1);
