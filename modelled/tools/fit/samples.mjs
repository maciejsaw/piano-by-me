// Load and index a sample library of isolated notes.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readWav } from './wavread.mjs';

const NAMES = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };
export function nameToMidi(name) {
  const m = /^([A-G]#?)(-?\d+)$/.exec(name);
  if (!m) return null;
  return NAMES[m[1]] + (parseInt(m[2], 10) + 1) * 12;
}

/** Index files named like `C4v13.wav` -> { midi, velocityLayer, path }. */
export function indexLibrary(dir) {
  const out = [];
  for (const f of readdirSync(dir)) {
    const m = /^([A-G]#?-?\d+)v(\d+)\.wav$/.exec(f);
    if (!m) continue;
    const midi = nameToMidi(m[1]);
    if (midi == null) continue;
    out.push({ midi, note: m[1], layer: parseInt(m[2], 10), path: join(dir, f) });
  }
  return out.sort((a, b) => a.midi - b.midi || a.layer - b.layer);
}

/** Trim leading silence so analysis windows line up with the attack. */
export function loadNote(path, { trimDb = -45 } = {}) {
  const { data, rate } = readWav(path);
  let peak = 0;
  for (const v of data) peak = Math.max(peak, Math.abs(v));
  const thresh = peak * Math.pow(10, trimDb / 20);
  let onset = 0;
  while (onset < data.length && Math.abs(data[onset]) < thresh) onset++;
  onset = Math.max(0, onset - Math.round(0.002 * rate));
  return { data: data.subarray(onset), rate, peak, onset };
}
