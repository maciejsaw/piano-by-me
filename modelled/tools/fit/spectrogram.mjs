// Render a spectrogram to PNG, so differences can be SEEN.
//
// Numbers summarise; a picture shows structure a summary was not designed to
// carry. Stacked panels share one colour scale and one log-frequency axis, so
// two instruments can be compared directly.
//
//   node tools/fit/spectrogram.mjs out.png <midi> [seconds]

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fft } from './comb.mjs';

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c; }
  return t;
})();
const crc32 = (b) => { let c = -1;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0; };

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  const c = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  out.writeUInt32BE(crc32(c), 8 + data.length);
  return out;
}

/** RGB pixel buffer -> PNG file. */
export function writePng(path, rgb, w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  writeFileSync(path, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]));
  return path;
}

/** Magma-ish ramp: dark for quiet, bright for loud. */
function colour(v) {
  const t = Math.max(0, Math.min(1, v));
  const r = Math.min(255, Math.round(255 * Math.min(1, t * 1.9)));
  const g = Math.round(255 * Math.max(0, Math.min(1, (t - 0.28) * 1.7)));
  const b = Math.round(255 * (t < 0.5 ? t * 1.4 : Math.max(0, 1.3 - t * 1.6)));
  return [r, g, b];
}

/**
 * One panel of log-frequency spectrogram, as a column-major dB matrix.
 * Levels are relative to the panel's own peak so panels are comparable.
 */
export function panel(x, fs, { width = 560, height = 300, fMin = 60, fMax = 8000, spanS = 10, startS = 0 } = {}) {
  const N = 8192;
  const hop = Math.max(1, Math.floor((spanS * fs) / width));
  const re = new Float64Array(N), im = new Float64Array(N);
  const cols = [];
  let peak = -1e9;
  for (let c = 0; c < width; c++) {
    const o = Math.round(startS * fs) + c * hop;
    if (o + N > x.length) { cols.push(null); continue; }
    for (let i = 0; i < N; i++) { re[i] = x[o + i] * 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1))); im[i] = 0; }
    fft(re, im);
    const col = new Float64Array(height);
    for (let y = 0; y < height; y++) {
      // row 0 is the top, i.e. the highest frequency
      const f0 = fMin * Math.pow(fMax / fMin, 1 - (y + 1) / height);
      const f1 = fMin * Math.pow(fMax / fMin, 1 - y / height);
      const k0 = Math.max(1, Math.floor((f0 * N) / fs)), k1 = Math.min(N / 2 - 1, Math.ceil((f1 * N) / fs));
      let m = 0;
      for (let k = k0; k <= k1; k++) m = Math.max(m, re[k] * re[k] + im[k] * im[k]);
      const db = 10 * Math.log10(m + 1e-20);
      col[y] = db;
      if (db > peak) peak = db;
    }
    cols.push(col);
  }
  return { cols, peak, width, height };
}

/**
 * Remove each frequency row's own decay, leaving only how it FLUCTUATES.
 *
 * On a plain spectrogram the decay dominates and every partial just fades. Take
 * the decay out row by row and what is left is the modulation itself, which is
 * the thing being judged: independent partials look like scattered speckle,
 * while a notch sweeping across the spectrum lines up into vertical stripes,
 * because every partial dips at the same moment. Phasing becomes visible.
 */
export function fluctuation(p, { clipDb = 45 } = {}) {
  const { cols, width, height } = p;
  const out = { cols: cols.map((c) => (c ? new Float64Array(height) : null)), peak: clipDb, width, height };
  for (let y = 0; y < height; y++) {
    const xs = [], ys = [];
    for (let c = 0; c < width; c++) if (cols[c]) { xs.push((2 * c) / (width - 1) - 1); ys.push(cols[c][y]); }
    if (ys.length < 8) continue;
    // cubic least squares, same shape the numeric metrics detrend with
    const P = 4, A = Array.from({ length: P }, () => new Float64Array(P)), b = new Float64Array(P);
    const basis = (t) => [1, t, t * t, t * t * t];
    for (let i = 0; i < xs.length; i++) { const B = basis(xs[i]);
      for (let q = 0; q < P; q++) { b[q] += B[q] * ys[i]; for (let r = 0; r < P; r++) A[q][r] += B[q] * B[r]; } }
    for (let c = 0; c < P; c++) {
      let piv = c; for (let r = c + 1; r < P; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
      [A[c], A[piv]] = [A[piv], A[c]]; [b[c], b[piv]] = [b[piv], b[c]];
      for (let r = 0; r < P; r++) { if (r === c || !A[c][c]) continue;
        const m = A[r][c] / A[c][c];
        for (let k = c; k < P; k++) A[r][k] -= m * A[c][k];
        b[r] -= m * b[c]; } }
    const co = [0, 1, 2, 3].map((i) => (A[i][i] ? b[i] / A[i][i] : 0));
    let i = 0;
    for (let c = 0; c < width; c++) {
      if (!cols[c]) continue;
      const B = basis(xs[i]);
      // rows too quiet to matter are flattened rather than amplified into noise
      // the troughs BETWEEN partials carry no useful fluctuation, and left in
      // they swamp the picture; flatten them to the neutral colour instead
      const quiet = ys[i] < p.peak - clipDb;
      out.cols[c][y] = quiet ? 0 : ys[i] - B.reduce((s, v, q) => s + v * co[q], 0);
      i++;
    }
  }
  return out;
}

/** Blue below the trend, black at it, yellow above. For fluctuation maps. */
function diverge(d, clip) {
  const t = Math.max(-1, Math.min(1, d / clip));
  if (t >= 0) return [Math.round(255 * Math.min(1, t * 1.6)), Math.round(255 * Math.min(1, t * 1.25)), Math.round(60 * t)];
  const u = -t;
  return [Math.round(30 * u), Math.round(150 * u), Math.round(255 * Math.min(1, u * 1.3))];
}

/** Stack panels into one PNG with a shared 70 dB scale. */
export function writeSpectrograms(path, panels, { range = 70, gap = 6, diverging = false } = {}) {
  const w = panels[0].width, ph = panels[0].height;
  const h = panels.length * ph + (panels.length - 1) * gap;
  const rgb = Buffer.alloc(w * h * 3);
  let yOff = 0;
  for (const p of panels) {
    for (let y = 0; y < ph; y++) for (let c = 0; c < w; c++) {
      const col = p.cols[c];
      const [r, g, b] = diverging
        ? diverge(col ? col[y] : 0, range)
        : colour(col ? (col[y] - p.peak + range) / range : 0);
      const o = ((yOff + y) * w + c) * 3;
      rgb[o] = r; rgb[o + 1] = g; rgb[o + 2] = b;
    }
    yOff += ph;
    if (yOff < h) { for (let y = 0; y < gap; y++) for (let c = 0; c < w; c++) {
      const o = ((yOff + y) * w + c) * 3; rgb[o] = 40; rgb[o + 1] = 90; rgb[o + 2] = 140; } }
    yOff += gap;
  }
  return writePng(path, rgb, w, h);
}
