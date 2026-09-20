// Fetch the Salamander recordings.
//
//   node tools/sampler/fetch.mjs [--dir DIR] [--keep-archive]
//
// 1.26 GB of 48 kHz / 24-bit WAV, which expands to about 1.9 GB. The 44.1/16
// and FLAC editions of the same library are smaller, but this one needs no
// decoder and is already at the rate the browser wants, so nothing in the
// pipeline has to resample before it has decided to.
import { createWriteStream, existsSync, mkdirSync, statSync, unlinkSync, renameSync, readdirSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const URL_ = 'https://freepats.zenvoid.org/Piano/SalamanderGrandPiano/SalamanderGrandPianoV3+20161209_48khz24bit.tar.xz';
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const args = process.argv.slice(2);
const dir = args.includes('--dir') ? args[args.indexOf('--dir') + 1]
  : process.env.SALAMANDER_DIR || join(REPO, '..', 'samples');
const keep = args.includes('--keep-archive');
const dest = join(dir, 'salamander-src');

if (existsSync(join(dest, '48khz24bit'))) {
  console.log(`  already there: ${dest}`);
  console.log(`  ${readdirSync(join(dest, '48khz24bit')).length} files\n  next: node tools/sampler/build.mjs --src ${join(dest, '48khz24bit')}\n`);
  process.exit(0);
}
mkdirSync(dir, { recursive: true });
const archive = join(dir, 'salamander-v3.tar.xz');

if (!existsSync(archive)) {
  console.log(`  downloading ${URL_}`);
  const r = await fetch(URL_);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  const total = Number(r.headers.get('content-length')) || 0;
  let got = 0, last = 0;
  const tmp = `${archive}.part`;
  await pipeline(
    Readable.fromWeb(r.body).on('data', (c) => {
      got += c.length;
      if (Date.now() - last > 400) {
        last = Date.now();
        process.stdout.write(`\r  ${(got / 1048576).toFixed(0)} MB${total ? ` / ${(total / 1048576).toFixed(0)} MB  ${(got / total * 100).toFixed(0)}%` : ''}   `);
      }
    }),
    createWriteStream(tmp),
  );
  renameSync(tmp, archive);
  process.stdout.write('\n');
}
console.log(`  extracting ${(statSync(archive).size / 1048576).toFixed(0)} MB`);
await new Promise((res, rej) => {
  const p = spawn('tar', ['-xJf', archive, '-C', dir], { stdio: 'inherit' });
  p.on('error', rej);
  p.on('close', (c) => (c === 0 ? res() : rej(new Error(`tar exited ${c}`))));
});
renameSync(join(dir, 'SalamanderGrandPianoV3_48khz24bit'), dest);
if (!keep) unlinkSync(archive);

console.log(`\n  ${dest}`);
console.log(`  ${readdirSync(join(dest, '48khz24bit')).length} recordings`);
console.log(`\n  next: node tools/sampler/build.mjs --src ${join(dest, '48khz24bit')}\n`);
console.log('  Salamander Grand Piano V3 by Alexander Holm, CC-BY 3.0.');
