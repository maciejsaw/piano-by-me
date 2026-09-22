// Ogg Opus, read just far enough to stream it.
//
// The browser will decode Opus for us (WebCodecs AudioDecoder), but it wants
// bare Opus packets, not an Ogg file -- so this is the demuxer. It is used in
// two places: the stream worker, on every file it holds in memory, and
// tools/sampler/heads.mjs, which cuts the first packets of every sample into
// the small bundle that makes each key playable before its file has arrived.
//
// A demuxed file is the packets laid end to end in one buffer, plus an index.
// Keeping the Ogg framing around would cost nothing but a copy, and a packet
// may straddle two pages, so gathering them once up front keeps every later
// read a plain subarray.

export const RATE = 48000;

/** How many 48 kHz samples one Opus packet decodes to (RFC 6716 section 3.1). */
export function packetFrames(pkt) {
  if (!pkt || !pkt.length) return 0;
  const toc = pkt[0];
  const config = toc >> 3;
  let per;                                        // samples per frame, at 48 kHz
  if (config < 12) per = [480, 960, 1920, 2880][config & 3];       // SILK
  else if (config < 16) per = [480, 960][config & 1];              // hybrid
  else per = [120, 240, 480, 960][config & 3];                     // CELT
  const code = toc & 3;
  const count = code === 0 ? 1 : code === 3 ? (pkt[1] ?? 0) & 0x3f : 2;
  return per * count;
}

/**
 * Split an Ogg Opus file into its packets.
 *
 * Returns { channels, preskip, head, data, off, len, dur, n, total }:
 *   head   the OpusHead packet, which is what AudioDecoder takes as its
 *          `description`
 *   data   every audio packet, back to back
 *   off/len/dur  per packet: where it is in `data`, and how many samples it
 *          decodes to
 *   total  the file's true length in samples, pre-skip already taken off --
 *          the last granule position says where the audio ends, which is
 *          before the end of the last packet
 */
export function demux(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const packets = [];           // each: list of spans
  let cur = null;
  let lastGranule = -1;
  let o = 0;
  while (o + 27 <= u8.length) {
    if (u8[o] !== 0x4f || u8[o + 1] !== 0x67 || u8[o + 2] !== 0x67 || u8[o + 3] !== 0x53) break;
    const nseg = u8[o + 26];
    // The granule is 64-bit; the low 48 bits are more than a day of audio.
    let g = 0;
    for (let i = 5; i >= 0; i--) g = g * 256 + u8[o + 6 + i];
    const neg = u8[o + 13] === 0xff;           // -1 means "no packet ends here"
    let p = o + 27 + nseg;
    for (let s = 0; s < nseg; s++) {
      const L = u8[o + 27 + s];
      if (!cur) cur = [];
      cur.push(p, p + L);
      p += L;
      if (L < 255) { packets.push(cur); cur = null; }
    }
    if (!neg) lastGranule = g;
    o = p;
  }
  if (packets.length < 2) throw new Error('not an Ogg Opus file');

  // Packet 0 is OpusHead, packet 1 OpusTags. The rest is audio.
  const head = gather(u8, packets[0]);
  if (String.fromCharCode(...head.subarray(0, 8)) !== 'OpusHead') throw new Error('not Opus');
  const channels = head[9];
  const preskip = head[10] | (head[11] << 8);

  const n = packets.length - 2;
  let size = 0;
  for (let i = 2; i < packets.length; i++) {
    const sp = packets[i];
    for (let j = 0; j < sp.length; j += 2) size += sp[j + 1] - sp[j];
  }
  const data = new Uint8Array(size);
  const off = new Uint32Array(n), len = new Uint32Array(n), dur = new Uint16Array(n);
  let w = 0, sum = 0;
  for (let i = 0; i < n; i++) {
    const sp = packets[i + 2];
    off[i] = w;
    for (let j = 0; j < sp.length; j += 2) { data.set(u8.subarray(sp[j], sp[j + 1]), w); w += sp[j + 1] - sp[j]; }
    len[i] = w - off[i];
    dur[i] = packetFrames(data.subarray(off[i], w));
    sum += dur[i];
  }
  const total = Math.max(0, (lastGranule >= 0 ? Math.min(lastGranule, sum) : sum) - preskip);
  return { channels, preskip, head, data, off, len, dur, n, total };
}

function gather(u8, spans) {
  let size = 0;
  for (let j = 0; j < spans.length; j += 2) size += spans[j + 1] - spans[j];
  const out = new Uint8Array(size);
  let w = 0;
  for (let j = 0; j < spans.length; j += 2) { out.set(u8.subarray(spans[j], spans[j + 1]), w); w += spans[j + 1] - spans[j]; }
  return out;
}

/**
 * The first packets of a demuxed file, packed for the heads bundle:
 * a little-endian u32 length before each packet.
 */
export function packHead(d, frames) {
  let need = d.preskip + frames + 960, k = 0, sum = 0;
  while (k < d.n && sum < need) sum += d.dur[k++];
  let size = 0;
  for (let i = 0; i < k; i++) size += 4 + d.len[i];
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  let w = 0;
  for (let i = 0; i < k; i++) {
    dv.setUint32(w, d.len[i], true); w += 4;
    out.set(d.data.subarray(d.off[i], d.off[i] + d.len[i]), w); w += d.len[i];
  }
  return { bytes: out, packets: k };
}

/** The inverse of packHead: a partial demuxed file, enough to decode the head. */
export function unpackHead(bytes, { channels, preskip, total, head }) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const offs = [], lens = [];
  let r = 0;
  while (r + 4 <= u8.length) {
    const L = dv.getUint32(r, true); r += 4;
    offs.push(r); lens.push(L); r += L;
  }
  const n = offs.length;
  const off = new Uint32Array(offs), len = new Uint32Array(lens), dur = new Uint16Array(n);
  for (let i = 0; i < n; i++) dur[i] = packetFrames(u8.subarray(off[i], off[i] + len[i]));
  return { channels, preskip, head, data: u8, off, len, dur, n, total };
}

/** A minimal OpusHead for a stream known only by channels and pre-skip. */
export function opusHead(channels, preskip) {
  const h = new Uint8Array(19);
  h.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64]);      // "OpusHead"
  h[8] = 1; h[9] = channels; h[10] = preskip & 0xff; h[11] = preskip >> 8;
  new DataView(h.buffer).setUint32(12, RATE, true);
  return h;
}
