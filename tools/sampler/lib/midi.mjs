// Standard MIDI file -> a flat list of timed events.
//
// Enough of the format to play a recorded piano performance and no more: note
// on and off with velocity, controllers, and the tempo map needed to turn
// ticks into seconds. No SysEx handling beyond skipping it, no SMPTE timing.
//
// The tempo map matters more than it looks. A performance captured from a real
// instrument is usually written at a fixed nominal tempo with all the rubato
// in the note timings, but it does not have to be, and a file that changes
// tempo mid-piece would come out at the wrong speed from the moment it did.
import { readFileSync } from 'node:fs';

class Reader {
  constructor(buf) { this.b = buf; this.p = 0; }
  u8() { return this.b[this.p++]; }
  u16() { const v = this.b.readUInt16BE(this.p); this.p += 2; return v; }
  u32() { const v = this.b.readUInt32BE(this.p); this.p += 4; return v; }
  str(n) { const s = this.b.toString('ascii', this.p, this.p + n); this.p += n; return s; }
  /** MIDI's variable-length quantity: seven bits per byte, high bit continues. */
  vlq() {
    let v = 0, c;
    do { c = this.b[this.p++]; v = (v << 7) | (c & 0x7f); } while (c & 0x80);
    return v;
  }
}

/**
 * @returns {{events: Array, duration: number, ticksPerBeat: number, tracks: number}}
 *   events are `{t, type, ...}` sorted by time in seconds, where type is
 *   'noteOn' | 'noteOff' | 'cc'.
 */
export function parseMidi(path) {
  const r = new Reader(readFileSync(path));
  if (r.str(4) !== 'MThd') throw new Error(`not a MIDI file: ${path}`);
  const headerLen = r.u32();
  const format = r.u16(), ntrks = r.u16(), division = r.u16();
  r.p += headerLen - 6;
  if (division & 0x8000) throw new Error('SMPTE timing is not supported');

  // Pass one: every track, in ticks. Tempo lives on one track but applies to
  // all of them, so seconds cannot be worked out until they are merged.
  const raw = [];
  for (let i = 0; i < ntrks; i++) {
    if (r.str(4) !== 'MTrk') break;
    const len = r.u32(), end = r.p + len;
    let tick = 0, running = 0;
    while (r.p < end) {
      tick += r.vlq();
      let status = r.b[r.p];
      if (status & 0x80) { r.p++; running = status; } else { status = running; }
      const cmd = status & 0xf0;
      if (status === 0xff) {
        const type = r.u8(), n = r.vlq();
        if (type === 0x51) {
          raw.push({ tick, type: 'tempo', usPerBeat: (r.b[r.p] << 16) | (r.b[r.p + 1] << 8) | r.b[r.p + 2] });
        }
        r.p += n;
      } else if (status === 0xf0 || status === 0xf7) {
        r.p += r.vlq();
      } else if (cmd === 0x80 || cmd === 0x90) {
        const note = r.u8(), vel = r.u8();
        // A note-on with velocity zero is a note-off, and most files use it.
        raw.push({ tick, type: (cmd === 0x90 && vel > 0) ? 'noteOn' : 'noteOff', note, vel, ch: status & 0x0f });
      } else if (cmd === 0xa0 || cmd === 0xb0 || cmd === 0xe0) {
        const a = r.u8(), b = r.u8();
        if (cmd === 0xb0) raw.push({ tick, type: 'cc', cc: a, value: b, ch: status & 0x0f });
      } else if (cmd === 0xc0 || cmd === 0xd0) {
        r.u8();
      } else {
        throw new Error(`unexpected status 0x${status.toString(16)} at ${r.p}`);
      }
    }
    r.p = end;
  }

  // Pass two: ticks to seconds, walking the tempo map.
  raw.sort((a, b) => a.tick - b.tick || (a.type === 'tempo' ? -1 : 1));
  let usPerBeat = 500000, lastTick = 0, seconds = 0;
  const events = [];
  for (const e of raw) {
    seconds += ((e.tick - lastTick) / division) * (usPerBeat / 1e6);
    lastTick = e.tick;
    if (e.type === 'tempo') { usPerBeat = e.usPerBeat; continue; }
    events.push({ ...e, t: seconds });
  }
  return { events, duration: seconds, ticksPerBeat: division, tracks: ntrks, format };
}

/**
 * The events of a window, rebased to zero, with anything still sounding at the
 * start left out rather than cut in half.
 *
 * Pedal is the awkward part: CC 64 is a level, not an event, so a window that
 * opens mid-pedal has to be told what the pedal was already doing or the first
 * seconds come out dry.
 */
export function slice(events, from, to) {
  const out = [];
  const ccState = new Map();
  for (const e of events) {
    if (e.t >= from) break;
    if (e.type === 'cc') ccState.set(e.cc, e.value);
  }
  for (const [cc, value] of ccState) out.push({ t: 0, type: 'cc', cc, value });

  const held = new Set();
  for (const e of events) {
    if (e.t < from) continue;
    if (e.t > to) break;
    if (e.type === 'noteOn') held.add(e.note);
    if (e.type === 'noteOff' && !held.has(e.note)) continue;   // its note-on was before the window
    if (e.type === 'noteOff') held.delete(e.note);
    out.push({ ...e, t: e.t - from });
  }
  // Everything still down at the end gets let go, so nothing hangs.
  for (const note of held) out.push({ t: to - from, type: 'noteOff', note, vel: 64 });
  return out.sort((a, b) => a.t - b.t);
}
