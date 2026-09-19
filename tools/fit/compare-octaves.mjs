// One note per octave, sample against model, as wavs and as spectrograms.
//
//   node tools/fit/compare-octaves.mjs [outDir]
//
// Each wav is the real note, a short gap, then ours, matched in level at
// 0.3 s so what is being compared is the sound and not the volume. The
// spectrogram sheet puts the sample on top and ours underneath at the same
// scale, over the span where that note actually has something to show.
import { mkdirSync } from 'node:fs';
import { readWav } from './wavread.mjs';
import { panel, writeSpectrograms } from './spectrogram.mjs';
import { renderNote } from './decay-report.mjs';
import { fitBands } from './bands.mjs';
import { noteHz } from '../../src/dsp/physics.js';
import { writeWav } from '../wav.mjs';

const FS = 48000;
const DIR = process.env.SAMPLES ?? '/home/user/samples/salamander';
const out = process.argv[2] || 'renders/octaves';
mkdirSync(out, { recursive: true });

// One per octave, plus A0 because the bottom is where the model is worst.
const PICKS = [['A0', 21], ['C2', 36], ['C3', 48], ['C4', 60], ['C5', 72], ['C6', 84], ['C7', 96], ['C8', 108]];

const rms = (x, a, n) => { let v = 0; for (let i = a; i < a + n; i++) v += (x[i] ?? 0) ** 2; return Math.sqrt(v / n); };

const all = [];
for (const [name, midi] of PICKS) {
  const s = readWav(`${DIR}/${name}v12.wav`);
  const lenS = Math.min(7, s.data.length / s.rate - 0.05);
  const ours = renderNote(Math.ceil(lenS) + 1, midi);
  const g = rms(s.data, Math.round(0.3 * s.rate), 9600) / Math.max(rms(ours, Math.round(0.3 * FS), 9600), 1e-12);
  const model = Float64Array.from(ours, (v) => v * g);

  const len = Math.round(lenS * FS), gap = Math.round(0.5 * FS);
  const ab = new Float32Array(len * 2 + gap);
  for (let i = 0; i < len; i++) { ab[i] = s.data[i] ?? 0; ab[len + gap + i] = model[i] ?? 0; }
  writeWav(`${out}/${name.toLowerCase()}-ab.wav`, ab, FS);
  all.push({ name, ab });

  // Show up to where this note's energy actually ends, with a little headroom.
  const fTop = fitBands(s.data, s.rate, noteHz(midi)).fTop;
  const opts = { spanS: Math.min(6, lenS), fMin: Math.max(40, noteHz(midi) * 0.5), fMax: Math.min(12000, fTop * 1.6) };
  writeSpectrograms(`${out}/${name.toLowerCase()}-spect.png`,
    [panel(s.data, s.rate, opts), panel(model, FS, opts)]);
  console.log(`${name.padEnd(4)} f0=${noteHz(midi).toFixed(1).padStart(7)} Hz  fTop=${Math.round(fTop)} Hz  -> ${name.toLowerCase()}-ab.wav, ${name.toLowerCase()}-spect.png`);
}

// And one file with the lot, in order, for a single pass through the range.
const total = all.reduce((n, a) => n + a.ab.length + Math.round(0.9 * FS), 0);
const tour = new Float32Array(total);
let p = 0;
for (const a of all) { tour.set(a.ab, p); p += a.ab.length + Math.round(0.9 * FS); }
writeWav(`${out}/octave-tour.wav`, tour, FS);
console.log(`\n${out}/octave-tour.wav: each note as real, then ours, bottom to top`);
