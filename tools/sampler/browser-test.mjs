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
  const { octaveOf } = await import('/sampled/src/curves.js');
  const { curves } = window.piano;
  curves.setOctave('trim', octaveOf(60), -40);
  engine.noteOn(60, 100); out.octTarget = await peakOver(400); engine.noteOff(60); await settle();
  engine.noteOn(72, 100); out.octNeighbour = await peakOver(400); engine.noteOff(72); await settle();
  curves.setOctave('trim', octaveOf(60), 0);
  await wait(10);
  engine.noteOn(60, 100); out.octRestored = await peakOver(400); engine.noteOff(60); await settle();

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
console.log('  release/damper/pedal samples   :', r.aux, 'of', r.auxTotal, '(pinned)');
console.log('  keys with a pinned layer       :', r.keysReady, 'of 88');
console.log('  silence                        :', f(r.silence));
console.log('  C4 at velocity 110             :', f(r.loud));
console.log('  C4 at velocity 25              :', f(r.soft), `(${(20 * Math.log10(r.soft / r.loud)).toFixed(1)} dB below)`);
console.log('  ten-note pedalled cluster, ff  :', f(r.cluster), `(${(20 * Math.log10(r.cluster)).toFixed(1)} dBFS rms, limiter off)`);
console.log('  held C-E-G after a struck C3   :', f(r.sympathetic), `on ${r.ringing} strings`);
console.log('  same gesture, nothing held     :', f(r.damped));
console.log('  accumulated energy, 1 strike   :', f(r.once));
console.log('  accumulated energy, 4 strikes  :', f(r.fourTimes));
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
console.log('  C4 with its octave trimmed 40dB:', f(r.octTarget));
console.log('  C5, a different octave         :', f(r.octNeighbour));
console.log('  C4 once the octave is restored :', f(r.octRestored));
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
  ['an octave band moves its own octave', r.octTarget < r.octRestored * 0.2],
  ['...and leaves the neighbours alone', r.octNeighbour > r.octRestored * 0.4],
  ['...and is undone by setting it back', r.octRestored > r.octTarget * 5],
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
