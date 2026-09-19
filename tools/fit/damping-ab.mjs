// A/B of the transient-damping depth against the sample. node tools/fit/damping-ab.mjs
import { readWav } from './wavread.mjs';
import { renderNote } from './decay-report.mjs';
import { writeWav } from '../wav.mjs';
const FS = 48000;
const s = readWav('/home/user/samples/salamander/C3v12.wav');
const rms=(x,a,n)=>{let v=0;for(let i=a;i<a+n;i++)v+=x[i]*x[i];return Math.sqrt(v/n);};
const ref = rms(s.data, Math.round(0.3*s.rate), 9600);
const segs = [Float64Array.from(s.data)];
for (const o of [
  { transientDepth: 0.28, transientRiseS: 0.001 },          // what you heard
  { transientDepth: 0.14, transientRiseS: 0.001 },          // half
  { transientDepth: 0.14, transientRiseS: 0.04 },           // half, attack spared
]) {
  const x = renderNote(8, 48, o);
  const g = ref / rms(x, Math.round(0.3*FS), 9600);
  segs.push(Float64Array.from(x, v => v * g));
}
const len = Math.round(7*FS), gap = Math.round(0.7*FS);
const out = new Float32Array(segs.length * (len + gap));
segs.forEach((seg, i) => { for (let k = 0; k < len; k++) out[i*(len+gap)+k] = seg[k] ?? 0; });
writeWav('renders/c3-damping-ab.wav', out, FS);
console.log('real | d=0.28 (what you heard) | d=0.14 | d=0.14 attack spared');
