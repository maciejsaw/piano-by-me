// Cut the head of every note sample into one small bundle.
//
//   node sampled/tools/heads.mjs            (after build.mjs)
//
// The player streams: a key is playable once the first quarter second of its
// recording is decoded and in memory, because the rest is decoded while that
// quarter second plays. Those heads are what the bundle holds -- the first
// Opus packets of all 1408 samples, a few megabytes in one request, so every
// key and every layer can speak within seconds of the page opening, long
// before 180 MB of full files have come down the wire.
//
// Nothing is re-encoded. These are the packets of the real files, byte for
// byte, so the head the browser decodes from here is sample-identical to the
// start of the same file decoded in full -- which is what lets playback carry
// on from one into the other with no seam.
//
// Output, next to the samples:
//   heads.bin    for each sample: [u32 packet length][packet] ...
//   heads.json   { headFrames, entries: { key: [offset, length, channels, preskip, total] } }
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { demux, packHead, RATE } from '../src/ogg.js';

const DIR = process.argv[2] ?? 'sampled/samples';
const HEAD_MS = 250;
const headFrames = Math.round(RATE * HEAD_MS / 1000);

const m = JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8'));
const parts = [], entries = {};
let offset = 0;
for (const [midi, n] of Object.entries(m.notes)) {
  for (const [layer, e] of Object.entries(n.layers)) {
    const d = demux(readFileSync(join(DIR, e.file)));
    const { bytes } = packHead(d, headFrames);
    entries[`n${midi}v${layer}`] = [offset, bytes.length, d.channels, d.preskip, d.total];
    parts.push(bytes);
    offset += bytes.length;
  }
}
writeFileSync(join(DIR, 'heads.bin'), Buffer.concat(parts));
writeFileSync(join(DIR, 'heads.json'), JSON.stringify({ v: 1, headFrames, entries }));
console.log(`  ${Object.keys(entries).length} heads of ${HEAD_MS} ms, ${(offset / 1048576).toFixed(1)} MB -> ${DIR}/heads.bin`);
