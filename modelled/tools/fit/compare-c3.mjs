// Real vs model, as pictures and as one wav. `node tools/fit/compare-c3.mjs`
//
// Top panel is the sample, bottom is us, same scale and same time span, so a
// partial that holds on too long or dies too early is visible as a stripe of
// the wrong length rather than a number in a table.
import { mkdirSync } from 'node:fs';
import { readWav } from './wavread.mjs';
import { panel, fluctuation, writeSpectrograms } from './spectrogram.mjs';
import { renderNote } from './decay-report.mjs';
import { writeWav } from '../wav.mjs';

const FS = 48000;
const MIDI = Number(process.env.MIDI ?? 48);
const NAME = process.env.NOTE ?? 'C3';
const out = process.argv[2] || 'renders';
mkdirSync(out, { recursive: true });

const s = readWav(`/home/user/samples/salamander/${NAME}v12.wav`);
const ours = renderNote(8, MIDI);

// Match loudness at 0.3 s, so the pictures compare shape and not level.
const rms = (x, a, n) => { let v = 0; for (let i = a; i < a + n; i++) v += x[i] * x[i]; return Math.sqrt(v / n); };
const g = rms(s.data, Math.round(0.3 * s.rate), 9600) / rms(ours, Math.round(0.3 * FS), 9600);
const model = Float64Array.from(ours, (v) => v * g);

const opts = { spanS: 7, fMax: 5000 };
const pReal = panel(s.data, s.rate, opts), pOurs = panel(model, FS, opts);
writeSpectrograms(`${out}/spect-${NAME.toLowerCase()}-decay.png`, [pReal, pOurs]);
writeSpectrograms(`${out}/fluct-${NAME.toLowerCase()}-decay.png`,
  [fluctuation(pReal), fluctuation(pOurs)], { diverging: true });

const gap = Math.round(0.6 * FS), len = Math.round(7 * FS);
const ab = new Float32Array((len + gap) * 2);
for (let i = 0; i < len; i++) ab[i] = s.data[i];
for (let i = 0; i < len; i++) ab[len + gap + i] = model[i];
writeWav(`${out}/${NAME.toLowerCase()}-decay-ab.wav`, ab, FS);
console.log(`wrote spect-/fluct-${NAME.toLowerCase()}-decay.png and ${NAME.toLowerCase()}-decay-ab.wav (real, then ours)`);
