// Measure the decay curves the sympathetic resonance needs, from the library
// as built, and write them into the manifest.
//
// The resonance engine divides a sympathetic voice's own decay back out of its
// gain, so it needs the decay of whichever layer it plays. The build used to
// keep that curve for the softest layer only, because that was the one it
// played -- and the softest layer turns out to be the wrong one: a pianissimo
// recording reaches the room's noise floor about 23 dB under its peak within
// two or three seconds (C2 sits flat at -23 dB from 3 s to the end), so the
// compensation could not follow it far without amplifying room noise, and the
// halo died with the recording rather than with the accumulator.
//
// A mezzo layer has the same string ringing 10-15 dB further above the floor.
// This measures those layers' curves, with the build's own decayCurve(), from
// the Opus files the browser will play -- so nothing has to be re-fetched or
// rebuilt. build.mjs records the same curves on a full rebuild.
//
//   node sampled/tools/res-decay.mjs [--layers 4,6,8,10]
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { findFfmpeg } from './lib/encode.mjs';
import { decayCurve } from './lib/analysis.mjs';
import { RES_LAYERS } from './lib/plan.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dir = join(REPO, 'sampled', 'samples');
const argi = process.argv.indexOf('--layers');
const layers = argi > 0 ? process.argv[argi + 1].split(',').map(Number) : RES_LAYERS;

const ffmpeg = await findFfmpeg();
function decode(file) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', join(dir, file),
    '-f', 'f32le', '-ac', '1', '-ar', '48000', 'pipe:1'], { maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`decode failed: ${file}`);
  return new Float32Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.length >> 2);
}

const path = join(dir, 'manifest.json');
const m = JSON.parse(readFileSync(path, 'utf8'));
let done = 0;
for (const [midi, n] of Object.entries(m.notes)) {
  n.layerDecay = {};
  for (const l of layers) {
    const e = n.layers[l];
    if (!e) continue;
    const { t, db } = decayCurve(decode(e.file), 48000);
    n.layerDecay[l] = { t, db };
    done++;
  }
  process.stdout.write(`\r  ${midi}  ${done} curves`);
}
m.resLayers = layers;
writeFileSync(path, JSON.stringify(m));
console.log(`\n  wrote layerDecay for layers ${layers.join(', ')} into ${path}`);
