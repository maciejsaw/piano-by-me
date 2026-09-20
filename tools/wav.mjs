import { writeFileSync } from 'node:fs';
/**
 * `samples` is interleaved when `channels` is 2: L, R, L, R. The header's
 * frame count is samples/channels, which is the one thing easy to get wrong
 * here -- a stereo file written with a mono frame count plays at half speed.
 */
export function writeWav(path, samples, fs = 48000, channels = 1) {
  const n = samples.length;
  const frames = n / channels;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22); buf.writeUInt32LE(fs, 24);
  buf.writeUInt32LE(fs * 2 * channels, 28);
  buf.writeUInt16LE(2 * channels, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  writeFileSync(path, buf);
  return path;
}
