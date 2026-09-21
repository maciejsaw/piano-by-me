// Build the per-key sample library.
//
//   node tools/sampler/build.mjs [--src DIR] [--out DIR] [options]
//
// In:  thirty recordings of a Yamaha C5, every third semitone, sixteen
//      velocity layers each, plus key-release noise, damper-release string
//      resonance.
// Out: one dedicated sample per key per layer -- 88 x 16 rather than 30 x 16 --
//      repitched with the body response held still, silence stripped from the
//      front, tails cut at the noise floor, peak-normalised, Opus-encoded, and
//      a manifest that tells the player everything it cannot hear for itself.
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { cpus } from 'node:os';
import { findFfmpeg, EXT } from './lib/encode.mjs';
import { ROOTS, HARM_ROOTS, planNotes, centsTable, noteName, LOW, HIGH } from './lib/plan.mjs';
import { readWavStereo, mid } from './lib/wav.mjs';
import { measureF0, midiToHz } from './lib/analysis.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');

// Salamander's own velocity split, read off the SFZ. The player does not use
// it to choose a layer -- it picks by measured level instead -- but it is what
// the recordings were made against, so it belongs in the manifest.
const HIVEL = [26, 34, 36, 43, 46, 50, 56, 64, 72, 80, 88, 96, 104, 112, 120, 127];

// The levels Salamander's own SFZ plays the auxiliary samples at, and they are
// not decoration. The key-release recordings are at full scale in the file --
// `rel40.wav` peaks within 2 dB of a fortissimo C4 -- and the SFZ takes 37 dB
// straight back off in its group header. Play them at face value, as this did
// at first, and every key lift sounds like a dropped hammer.
//
//   rel*      <group> trigger=release pitch_keytrack=0 volume=-37 rt_decay=2
//   harmL/S   <group> trigger=release volume=-4 rt_decay=6..9
//   harmV3    <group> trigger=release rt_decay=2
const MIX_DB = { release: -37, damperL: -4, damperS: -4, damperV: 0 };

// The top twenty keys of a grand have no dampers: they ring until they stop.
// Salamander's SFZ puts the break at key 89, and so do we.
const HIGHEST_DAMPED = 88;

function args(argv) {
  const o = {
    src: process.env.SALAMANDER || '/home/user/samples/salamander-src/48khz24bit',
    out: join(REPO, 'sampled', 'samples'),
    format: 'opus', bitrate: '96k', layers: 16,
    jobs: Math.max(1, Math.min(cpus().length, 8)),
    correct: true, tune: 'measured',
    onsetDb: -55, fadeInMs: 1, fadeOutMs: 150, subsonicHz: 8,
    extras: true, only: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    if (a === '--src') o.src = next();
    else if (a === '--out') o.out = next();
    else if (a === '--format') o.format = next();
    else if (a === '--bitrate') o.bitrate = next();
    else if (a === '--layers') o.layers = +next();
    else if (a === '--jobs') o.jobs = +next();
    else if (a === '--tune') o.tune = next();
    else if (a === '--only') o.only = next().split(',').map(Number);
    else if (a === '--no-correct') o.correct = false;
    else if (a === '--no-extras') o.extras = false;
    else if (a === '--help' || a === '-h') { usage(); process.exit(0); }
    else throw new Error(`unknown option ${a}`);
  }
  if (!EXT[o.format]) throw new Error(`--format must be one of ${Object.keys(EXT).join(', ')}`);
  return o;
}
function usage() {
  console.log(`
  build.mjs -- render a per-key piano library from the Salamander recordings

  --src DIR       the 48khz24bit folder of the Salamander library
  --out DIR       where to write (default sampled/samples)
  --format F      opus (default) | webm | wav
  --bitrate B     Opus target, default 96k
  --layers N      keep every Nth of the 16 velocity layers: 16, 8, 4
  --jobs N        parallel workers, default one per core
  --tune MODE     how keys are placed:
                    measured (default) every key's real pitch is measured and
                             placed on the fitted Railsback. This library's C8
                             is 88 cents sharp while A7 is 40, so left alone
                             there is a 48-cent step between A#7 and B7
                    curve    roots untouched, repitched keys follow the local
                             width of the stretch curve -- preserves the
                             recording exactly, tuning warts included
                    none     exact equal-tempered ratios from each root
  --only A,B      build only these target keys, for trying things out
  --no-correct    skip the body correction -- plain resampling, for comparison
  --no-extras     notes only: no release or damper samples
`);
}

/** Every Nth layer, always keeping the softest and the loudest. */
function chooseLayers(n) {
  if (n >= 16) return Array.from({ length: 16 }, (_, i) => i + 1);
  const out = [];
  for (let i = 0; i < n; i++) out.push(1 + Math.round(i * 15 / (n - 1)));
  return [...new Set(out)];
}

/** Each recording's actual fundamental, from its mezzo-forte layer. */
function measureRoots(src, roots) {
  const out = {};
  process.stdout.write('  measuring source pitches');
  for (const r of roots) {
    const { ch, rate } = readWavStereo(join(src, `${noteName(r)}v12.wav`));
    out[r] = measureF0(mid(ch), rate, r).hz;
    process.stdout.write('.');
  }
  process.stdout.write('\n');
  return out;
}

/** Ratios that land every key on the fitted stretch curve, roots included. */
function retune(targets, root, srcHz, cents) {
  return targets.map((t) => {
    const want = midiToHz(t.midi) * Math.pow(2, ((cents?.[t.midi] ?? 0) / 1200));
    return { ...t, ratio: want / srcHz };
  });
}

async function main() {
  const o = args(process.argv);
  const ffmpeg = await findFfmpeg();
  if (!existsSync(o.src)) throw new Error(`no such source dir: ${o.src}\n  run tools/sampler/fetch.mjs first`);
  mkdirSync(o.out, { recursive: true });

  const body = JSON.parse(readFileSync(join(REPO, 'fitted', 'salamander-body.json'), 'utf8')).curve;
  const scale = JSON.parse(readFileSync(join(REPO, 'fitted', 'salamander-scale.json'), 'utf8'));
  const cents = o.tune === 'none' ? null : centsTable(scale);
  const layers = chooseLayers(o.layers);
  const keep = (m) => !o.only || o.only.includes(m);

  // ---- jobs ----------------------------------------------------------------
  //
  // --tune measured needs each recording's real pitch, and it must be ONE
  // pitch per recorded note or the sixteen layers of a key would end up tuned
  // against each other. So it is measured once here, off the mezzo-forte
  // layer, rather than per job in the workers.
  const measured = o.tune === 'measured' ? measureRoots(o.src, ROOTS) : null;

  const jobs = [];
  const notePlan = planNotes(ROOTS, cents);
  for (const [root, targets] of notePlan) {
    const t = targets.filter((x) => keep(x.midi));
    if (!t.length) continue;
    const tt = measured ? retune(t, root, measured[root], cents) : t;
    for (const layer of layers) {
      jobs.push({ kind: 'note', id: `${noteName(root)}v${layer}`, srcMidi: root, layer, targets: tt,
        file: join(o.src, `${noteName(root)}v${layer}.wav`),
        // f0 is measured once per key, on the layer nearest mezzo-forte: it is
        // a property of the string, and 1408 Goertzel searches to confirm that
        // would be 1320 of them wasted.
        analyseF0: layer === 12 || layers.length < 4 });
    }
  }
  if (o.extras) {
    // Keys 89 and up have no dampers on a C5, so they have no damper-release
    // sound to record -- which is also why Salamander's harm* recordings stop
    // at D#6. (fitted/salamander-scale.json has a lowestDamped field, but it
    // belongs to the physical model's own damper layout and is not this.)
    const harmPlan = planNotes(HARM_ROOTS, cents, { lo: LOW, hi: HIGHEST_DAMPED });
    for (const [root, targets] of harmPlan) {
      const t = targets.filter((x) => keep(x.midi));
      if (!t.length) continue;
      for (const [variant, prefix] of [['L', 'harmL'], ['S', 'harmS'], ['V', 'harmV3']]) {
        const file = join(o.src, `${prefix}${noteName(root)}.wav`);
        if (existsSync(file)) jobs.push({ kind: 'damper', id: `${prefix}${noteName(root)}`, srcMidi: root, variant, targets: t, file });
      }
    }
    for (let m = LOW; m <= HIGH; m++) {
      if (!keep(m)) continue;
      const file = join(o.src, `rel${m - 20}.wav`);
      if (existsSync(file)) jobs.push({ kind: 'release', id: `rel${m - 20}`, midi: m, file, name: `r${m}${EXT[o.format]}`, capS: 3 });
    }
    // Salamander's pedalD/pedalU recordings are deliberately NOT built. They
    // are a mechanism being worked -- two files, whichever way you use the
    // pedal, carrying a room and a frame that are not the ones this engine
    // renders -- and the thing they stand in for, the undamped frame lighting
    // up under the pedal, is modelled properly by the resonance accumulator
    // and the soundboard reverb instead.
  }

  console.log(`  source   ${o.src}`);
  console.log(`  out      ${o.out}  (${o.format}${o.format === 'opus' ? ' ' + o.bitrate : ''})`);
  console.log(`  keys     ${o.only ? o.only.join(',') : `${LOW}..${HIGH}`}   layers ${layers.length}   body correction ${o.correct ? 'on' : 'OFF'}   tuning ${o.tune}`);
  console.log(`  ${jobs.length} jobs on ${o.jobs} workers\n`);

  // ---- run -----------------------------------------------------------------
  const cfg = { ...o, ffmpeg, body };
  const results = [];
  const started = Date.now();
  let next = 0, done = 0, failed = 0;
  await new Promise((resolve, reject) => {
    let live = 0;
    const tick = (label) => {
      const pct = (done / jobs.length * 100).toFixed(0).padStart(3);
      const el = (Date.now() - started) / 1000;
      const eta = done ? (el / done) * (jobs.length - done) : 0;
      process.stdout.write(`\r  ${pct}%  ${String(done).padStart(4)}/${jobs.length}  ${el.toFixed(0)}s elapsed, ${eta.toFixed(0)}s left   ${label.padEnd(14)}`);
    };
    const feed = (w) => {
      if (next >= jobs.length) { w.postMessage(null); if (--live === 0) resolve(); return; }
      w.postMessage(jobs[next++]);
    };
    for (let i = 0; i < Math.min(o.jobs, jobs.length); i++) {
      const w = new Worker(join(HERE, 'worker.mjs'), { workerData: cfg });
      live++;
      w.on('message', (m) => {
        done++;
        if (m.ok) results.push(...m.out);
        else { failed++; process.stdout.write(`\n  FAILED ${m.job}: ${m.error.split('\n')[0]}\n`); }
        tick(m.ok ? String(m.job) : 'failed');
        feed(w);
      });
      w.on('error', reject);
      feed(w);
    }
  });
  process.stdout.write('\n');

  // ---- manifest ------------------------------------------------------------
  const notes = {};
  const need = (m) => (notes[m] ??= { midi: m, name: noteName(m), layers: {} });
  for (const r of results) {
    if (r.kind === 'note') {
      const n = need(r.midi);
      n.src = r.src; n.shift = r.shift; n.ratio = r.ratio;
      if (r.hz) { n.hz = r.hz; n.cents = r.cents; if (r.B) n.B = r.B; if (r.hzUncertain) n.hzUncertain = true; }
      const { kind, midi, layer, src, shift, ratio, hz, cents: c, decay, hzUncertain, B, ...rest } = r;
      n.layers[layer] = rest;
      if (r.edr) n.layers[layer].edr = r.edr;
      // The resonance engine divides a sympathetic voice's own decay back out,
      // so it needs the curve -- from the softest layer, which is the one it
      // plays.
      if (layer === 1) n.decay = decay;
    } else if (r.kind === 'damper') {
      const n = need(r.midi);
      (n.damper ??= {})[r.variant] = { file: r.file, gain: r.gain, dur: r.dur };
    } else if (r.kind === 'release') {
      need(r.midi).release = { file: r.file, gain: r.gain, dur: r.dur };
    }
  }
  let bytes = 0, count = 0;
  for (const f of readdirSync(o.out)) if (f !== 'manifest.json') { bytes += statSync(join(o.out, f)).size; count++; }

  const manifest = {
    name: 'Salamander Grand Piano V3 — Yamaha C5',
    source: {
      library: 'Salamander Grand Piano V3, 48 kHz / 24 bit',
      author: 'Alexander Holm',
      license: 'CC-BY 3.0',
      url: 'https://freepats.zenvoid.org/Piano/acoustic-grand-piano.html',
    },
    built: new Date().toISOString().slice(0, 19) + 'Z',
    format: o.format, ext: EXT[o.format], rate: 48000, bitrate: o.format === 'opus' ? o.bitrate : null,
    keys: { lo: LOW, hi: HIGH },
    lowestDamped: LOW, highestDamped: HIGHEST_DAMPED,
    layers, hivel: HIVEL, mixDb: MIX_DB,
    bodyCorrection: o.correct, tuning: o.tune,
    // Every sample was normalised to -1 dBFS; `gain` on each entry puts the
    // real level back. Nothing downstream should ever ignore it.
    normalisedToDbfs: -3,
    notes,
  };
  writeFileSync(join(o.out, 'manifest.json'), JSON.stringify(manifest));

  const keysBuilt = Object.keys(notes).length;
  console.log(`\n  ${count} files, ${(bytes / 1048576).toFixed(1)} MB, ${keysBuilt} keys`);
  console.log(`  ${((Date.now() - started) / 1000 / 60).toFixed(1)} min${failed ? `, ${failed} FAILED` : ''}`);
  console.log(`  manifest -> ${join(o.out, 'manifest.json')}\n`);
  if (failed) process.exitCode = 1;
}

main().catch((e) => { console.error('\n' + (e.stack || e.message)); process.exit(1); });
