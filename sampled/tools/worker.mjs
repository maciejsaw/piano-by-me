// One build job: read a recording, make every key it serves, write them out.
//
// Grouped by SOURCE rather than by target key so that a 25 MB bass recording
// is read and decoded once for the three keys it becomes, not three times.
import { parentPort, workerData } from 'node:worker_threads';
import { join } from 'node:path';
import { readWavStereo, mid } from './lib/wav.mjs';
import { makeSincTable } from './lib/resample.mjs';
import { repitch, correctionAt } from './lib/repitch.mjs';
import { subsonic, findOnset, findTail, fadeIn, fadeOut, slice, peakOf } from './lib/trim.mjs';
import { encode, EXT } from './lib/encode.mjs';
import { measureF0, decayCurve, earlyDecayRate, rmsOf } from './lib/analysis.mjs';
import { maxSeconds, noteName } from './lib/plan.mjs';

const cfg = workerData;
// -3 dBFS, not -1. Opus is a transform codec: the waveform it reconstructs is
// not the one it was given, and on a piano attack it overshoots by up to about
// 2 dB. At -1 dBFS the decoded peak measured +1.25 dBFS, which a browser
// clips. The 2 dB given up here is free -- every sample's true level is
// restored from the manifest at playback anyway.
const TARGET_PEAK = Math.pow(10, -3 / 20);

/**
 * A soft layer is allowed less time than a loud one.
 *
 * The absolute tail floor in trim.mjs already does most of this. The cap is
 * the backstop for notes that never reach the floor inside their recording,
 * and it should slope the same way.
 */
const layerCap = (layer) => 0.5 + 0.5 * (layer - 1) / 15;

// One sinc table per ratio, built lazily and kept: they cost 2 MB and a few
// hundred Bessel evaluations each, and there are only ever a handful.
const tables = new Map();
function tableFor(ratio) {
  const key = ratio.toFixed(6);
  let t = tables.get(key);
  if (!t) { t = makeSincTable({ cutoff: Math.min(0.86, 0.98 / Math.max(ratio, 1)) }); tables.set(key, t); }
  return t;
}
const gains = new Map();
function gainFor(ratio) {
  if (!cfg.correct || ratio === 1) return null;
  const key = ratio.toFixed(6);
  let g = gains.get(key);
  if (!g) { g = correctionAt(cfg.body, ratio); gains.set(key, g); }
  return g;
}

/** Trim, fade, normalise, encode. Returns what the manifest needs to undo it. */
async function finish(ch, rate, outPath, { capS = Infinity, tailRelDb, analyse = false, midi = null }) {
  subsonic(ch, rate, cfg.subsonicHz);
  const m = mid(ch);
  const on = findOnset(m, rate, { relDb: cfg.onsetDb });
  let end = findTail(m, rate, tailRelDb != null ? { relDb: tailRelDb } : undefined);
  end = Math.min(end, on + Math.round(capS * rate), ch[0].length);
  if (end <= on + 64) end = Math.min(ch[0].length, on + 64);

  const cut = slice(ch, on, end);
  fadeIn(cut, rate, cfg.fadeInMs);
  fadeOut(cut, rate, Math.min(cfg.fadeOutMs, (cut[0].length / rate) * 250));

  const peak = Math.max(peakOf(cut[0]), cut[1] ? peakOf(cut[1]) : 0);
  const scale = peak > 1e-9 ? TARGET_PEAK / peak : 1;
  for (const x of cut) for (let i = 0; i < x.length; i++) x[i] *= scale;

  const meta = {
    gain: +(1 / scale).toPrecision(6),          // multiply by this to restore the true level
    peak: +peak.toPrecision(6),
    dur: +(cut[0].length / rate).toFixed(4),
    trimmedMs: +(on / rate * 1000).toFixed(1),
  };
  if (analyse) {
    const cm = mid(cut);
    meta.rms = +(rmsOf(cm) * (1 / scale)).toPrecision(4);
    const curve = decayCurve(cm, rate);
    const edr = earlyDecayRate(curve);
    if (edr) meta.edr = edr;                    // dB per second over the first 20 dB
    if (midi != null) {
      const f = measureF0(cm, rate, midi);
      meta.hz = +f.hz.toFixed(3);
      meta.cents = +f.cents.toFixed(2);
      if (!f.confident) meta.hzUncertain = true;
      if (f.B) meta.B = +f.B.toPrecision(3);
    }
    meta.decay = { t: curve.t, db: curve.db };
  }
  await encode(cfg.ffmpeg, cut, rate, outPath, { format: cfg.format, bitrate: cfg.bitrate });
  return meta;
}

async function runNote(job) {
  const { ch, rate } = readWavStereo(job.file);
  const out = [];
  for (const t of job.targets) {
    const y = repitch(ch, rate, t.ratio, tableFor(t.ratio), gainFor(t.ratio));
    const name = `n${t.midi}v${job.layer}${EXT[cfg.format]}`;
    const meta = await finish(y, rate, join(cfg.out, name), {
      capS: maxSeconds(t.midi) * layerCap(job.layer),
      analyse: true,
      midi: job.analyseF0 ? t.midi : null,
    });
    out.push({ kind: 'note', midi: t.midi, layer: job.layer, src: job.srcMidi, shift: t.midi - job.srcMidi,
      ratio: +t.ratio.toPrecision(8), file: name, ...meta });
  }
  return out;
}

async function runDamper(job) {
  const { ch, rate } = readWavStereo(job.file);
  const out = [];
  for (const t of job.targets) {
    const y = repitch(ch, rate, t.ratio, tableFor(t.ratio), gainFor(t.ratio));
    const name = `h${t.midi}${job.variant}${EXT[cfg.format]}`;
    // These are quiet by nature; a -72 dB tail test against their own peak
    // would keep several seconds of room tone that nobody will hear under a
    // note that is still ringing.
    const meta = await finish(y, rate, join(cfg.out, name), { capS: 8, tailRelDb: -60 });
    out.push({ kind: 'damper', midi: t.midi, variant: job.variant, file: name, ...meta });
  }
  return out;
}

async function runSimple(job) {
  const { ch, rate } = readWavStereo(job.file);
  const meta = await finish(ch, rate, join(cfg.out, job.name), { capS: job.capS ?? 4, tailRelDb: -60 });
  return [{ kind: job.kind, midi: job.midi ?? null, id: job.id ?? null, file: job.name, ...meta }];
}

parentPort.on('message', async (job) => {
  if (job === null) { parentPort.close(); return; }
  try {
    const run = job.kind === 'note' ? runNote : job.kind === 'damper' ? runDamper : runSimple;
    parentPort.postMessage({ ok: true, job: job.id ?? job.kind, out: await run(job) });
  } catch (e) {
    parentPort.postMessage({ ok: false, job: job.file, error: e.stack || String(e) });
  }
});
