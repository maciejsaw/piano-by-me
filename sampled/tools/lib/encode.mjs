// Encoding, and why the library is not shipped as WAV.
//
// A full 88-key, 16-layer library is about nine gigabytes of 24-bit stereo
// PCM. Nothing about a browser wants that, and the first thing a listener
// notices is not the codec but whether the note they pressed has loaded.
//
// Opus rather than MP3 or AAC, for one reason that has nothing to do with
// sound quality: gapless. An MP3 decoder hands back a variable number of
// padding samples at the front of the file, which after all the trouble taken
// in trim.mjs to put the hammer strike on sample zero would put it back where
// it started -- and differently per file, so the library's timing would go
// uneven again. Opus carries its pre-skip in the header and every browser
// decoder removes it.
//
// Each sample is peak-normalised before encoding and its restoring gain is
// written into the manifest. That is not loudness matching -- the player
// multiplies the gain straight back, so relative levels across layers and
// notes are exactly preserved. It is that a codec spends its bits relative to
// the signal it is given, and the softest velocity layer sits 45 dB below the
// loudest. Normalising first hands that layer the encoder's full range instead
// of a fortieth of it, at a cost of one multiply per voice.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { interleaveF32 } from './wav.mjs';

/** $FFMPEG, then the PATH, then the optional ffmpeg-static dependency. */
export async function findFfmpeg() {
  if (process.env.FFMPEG && existsSync(process.env.FFMPEG)) return process.env.FFMPEG;
  try {
    const { execSync } = await import('node:child_process');
    const p = execSync('command -v ffmpeg', { encoding: 'utf8' }).trim();
    if (p) return p;
  } catch { /* not on the PATH */ }
  try {
    const m = await import('ffmpeg-static');
    if (m.default && existsSync(m.default)) return m.default;
  } catch { /* not installed */ }
  throw new Error('no ffmpeg: install one, set $FFMPEG, or `npm i -D ffmpeg-static`');
}

const ARGS = {
  // -application audio, not the default: the default tunes for speech below
  // 96 kbit and a piano's decay tail is exactly what that trades away.
  opus: (br) => ['-c:a', 'libopus', '-b:a', br, '-vbr', 'on', '-compression_level', '10',
    '-application', 'audio', '-frame_duration', '20', '-f', 'ogg'],
  webm: (br) => ['-c:a', 'libopus', '-b:a', br, '-vbr', 'on', '-compression_level', '10',
    '-application', 'audio', '-frame_duration', '20', '-f', 'webm'],
  wav: () => ['-c:a', 'pcm_s24le', '-f', 'wav'],
};
export const EXT = { opus: '.ogg', webm: '.webm', wav: '.wav' };

export function encode(ffmpeg, ch, rate, path, { format = 'opus', bitrate = '96k' } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'f32le', '-ar', String(rate), '-ac', String(ch.length), '-i', 'pipe:0',
      ...ARGS[format](bitrate), path,
    ], { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${err.slice(0, 400)}`)));
    const buf = interleaveF32(ch);
    p.stdin.end(Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength));
  });
}
