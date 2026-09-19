import { readFileSync } from 'node:fs';

/** Read a PCM WAV (16/24/32-bit int or 32-bit float) and downmix to mono. */
export function readWav(path) {
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
    } else if (id === 'data') { dataOff = pos + 8; dataLen = size; }
    pos += 8 + size + (size & 1);
  }
  if (!fmt || !dataOff) throw new Error(`malformed WAV: ${path}`);

  const { channels: ch, bits } = fmt;
  const bytes = bits / 8;
  const frames = Math.floor(dataLen / (bytes * ch));
  const out = new Float64Array(frames);
  const isFloat = fmt.format === 3;

  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < ch; c++) {
      const o = dataOff + (i * ch + c) * bytes;
      let v;
      if (isFloat) v = bits === 64 ? b.readDoubleLE(o) : b.readFloatLE(o);
      else if (bits === 16) v = b.readInt16LE(o) / 32768;
      else if (bits === 24) v = ((b[o] | (b[o + 1] << 8) | (b[o + 2] << 24 >> 8)) << 8 >> 8) / 8388608;
      else if (bits === 32) v = b.readInt32LE(o) / 2147483648;
      else if (bits === 8) v = (b[o] - 128) / 128;
      else throw new Error(`unsupported bit depth ${bits}`);
      acc += v;
    }
    out[i] = acc / ch;
  }
  return { data: out, rate: fmt.rate, channels: ch, bits };
}
