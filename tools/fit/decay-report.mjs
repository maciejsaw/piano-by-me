// Per-partial decay shape, model vs sample. `node tools/fit/decay-report.mjs`
import { readWav } from './wavread.mjs';
import { partialDecay } from './decay.mjs';
import { Piano } from '../../src/dsp/piano.js';

const FS = 48000;
const SAMPLE = process.env.SAMPLE ?? '/home/user/samples/salamander/C3v12.wav';
const MIDI = 48, F0 = 440 * Math.pow(2, (MIDI - 69) / 12);

export function renderNote(seconds = 8, midi = MIDI, opts = {}) {
  const { velocity = 0.75, ...rest } = opts;
  const p = new Piano(FS, { quality: 32, ...rest });
  const N = Math.round(FS * seconds), x = new Float64Array(N), buf = new Float32Array(256);
  p.noteOn(midi, velocity);
  for (let i = 0; i < N; i += 256) {
    p.render(buf, 256);
    for (let k = 0; k < 256 && i + k < N; k++) x[i + k] = buf[k];
  }
  return x;
}

export function report(label, x, fs, f0 = F0) {
  const r = partialDecay(x, fs, f0);
  console.log(`\n${label}  f0=${r.f0.toFixed(2)} B=${r.B.toExponential(2)}`);
  console.log('   n     f Hz   early   late   curve   blurE   blurL   rise');
  for (const t of r.tracks) {
    console.log(
      `  ${String(t.n).padStart(2)} ${t.f.toFixed(1).padStart(8)} ` +
      [t.early, t.late, t.curve, t.blurEarly, t.blurLate, t.blurRise]
        .map((v) => v.toFixed(1).padStart(7)).join(''),
    );
  }
  return r;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const s = readWav(SAMPLE);
  const real = report('REAL   ' + SAMPLE.split('/').pop(), s.data, s.rate);
  const ours = report('MODEL  C3', renderNote(), FS);
  console.log('\n  diff (model - real), positive = ours holds on longer / blurs more');
  console.log('   n   early    late   curve    rise');
  for (let i = 0; i < Math.min(real.tracks.length, ours.tracks.length); i++) {
    const a = ours.tracks[i], b = real.tracks[i];
    console.log(`  ${String(a.n).padStart(2)} ` + [a.early - b.early, a.late - b.late,
      a.curve - b.curve, a.blurRise - b.blurRise].map((v) => v.toFixed(1).padStart(7)).join(''));
  }
}
