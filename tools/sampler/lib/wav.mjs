// Stereo WAV I/O for the sample pipeline.
//
// tools/fit/wavread.mjs already reads WAVs, but it downmixes to mono because
// everything the fitter measures -- partials, decay, inharmonicity -- is a
// property of the string and not of the microphone placement. Here the stereo
// image IS the product, so it has to survive the whole pipeline untouched.
import { readFileSync, writeFileSync } from 'node:fs';

/** Read a PCM WAV and return its channels as separate Float32Arrays. */
export function readWavStereo(path) {
  const b = readFileSync(path);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE')
    throw new Error(`not a WAV: ${path}`);

  let pos = 12, fmt = null, dataOff = 0, dataLen = 0;
  while (pos + 8 <= b.length) {
    const id = b.toString('ascii', pos, pos + 4);
    const size = b.readUInt32LE(pos + 4);
    if (id === 'fmt ') {
      fmt = {
        format: b.readUInt16LE(pos + 8),
        channels: b.readUInt16LE(pos + 10),
        rate: b.readUInt32LE(pos + 12),
        bits: b.readUInt16LE(pos + 22),
      };
    } else if (id === 'data') { dataOff = pos + 8; dataLen = Math.min(size, b.length - pos - 8); }
    pos += 8 + size + (size & 1);
  }
  if (!fmt || !dataOff) throw new Error(`malformed WAV: ${path}`);

  const { channels: nch, bits, rate } = fmt;
  const bytes = bits >> 3;
  const frames = Math.floor(dataLen / (bytes * nch));
  const ch = [];
  for (let c = 0; c < nch; c++) ch.push(new Float32Array(frames));

  // Byte arithmetic rather than Buffer.readInt24 (which does not exist) or
  // readInt32LE with a shift: this loop runs over ~600 M samples in a full
  // build, so the per-sample call overhead is the whole cost.
  const stride = bytes * nch;
  for (let c = 0; c < nch; c++) {
    const out = ch[c];
    let o = dataOff + c * bytes;
    if (bits === 24) {
      for (let i = 0; i < frames; i++, o += stride) {
        let v = b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
        if (v & 0x800000) v -= 0x1000000;
        out[i] = v / 8388608;
      }
    } else if (bits === 16) {
      for (let i = 0; i < frames; i++, o += stride) {
        let v = b[o] | (b[o + 1] << 8);
        if (v & 0x8000) v -= 0x10000;
        out[i] = v / 32768;
      }
    } else if (bits === 32 && fmt.format === 3) {
      for (let i = 0; i < frames; i++, o += stride) out[i] = b.readFloatLE(o);
    } else if (bits === 32) {
      for (let i = 0; i < frames; i++, o += stride) out[i] = b.readInt32LE(o) / 2147483648;
    } else throw new Error(`unsupported ${bits}-bit format ${fmt.format}: ${path}`);
  }
  return { ch, rate, bits, frames };
}

/** Mono sum, for anything that is a measurement rather than the product. */
export function mid(ch) {
  if (ch.length === 1) return ch[0];
  const n = ch[0].length, out = new Float32Array(n);
  const g = 1 / ch.length;
  for (let c = 0; c < ch.length; c++) { const x = ch[c]; for (let i = 0; i < n; i++) out[i] += x[i] * g; }
  return out;
}

/** Write 24-bit PCM. Used for the lossless intermediate and for --format wav. */
export function writeWav24(path, ch, rate) {
  const nch = ch.length, frames = ch[0].length, bytes = 3;
  const dataLen = frames * nch * bytes;
  const b = Buffer.alloc(44 + dataLen);
  b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(36 + dataLen, 4); b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii'); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
  b.writeUInt16LE(nch, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * nch * bytes, 28); b.writeUInt16LE(nch * bytes, 32); b.writeUInt16LE(24, 34);
  b.write('data', 36, 'ascii'); b.writeUInt32LE(dataLen, 40);
  let o = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nch; c++, o += 3) {
      let v = Math.round(ch[c][i] * 8388608);
      if (v > 8388607) v = 8388607; else if (v < -8388608) v = -8388608;
      b[o] = v & 255; b[o + 1] = (v >> 8) & 255; b[o + 2] = (v >> 16) & 255;
    }
  }
  writeFileSync(path, b);
}

/** Interleaved float32, the format ffmpeg reads on stdin. */
export function interleaveF32(ch) {
  const nch = ch.length, frames = ch[0].length;
  const out = new Float32Array(frames * nch);
  for (let c = 0; c < nch; c++) { const x = ch[c]; for (let i = 0; i < frames; i++) out[i * nch + c] = x[i]; }
  return out;
}
