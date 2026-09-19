// Solve the felt hardness curve so contact time lands where it should.
//
//   node tools/fit/fit-hardness.mjs
//
// Contact duration is the single thing that decides how far up the partial
// ladder a strike reaches, and it is not a free parameter: it falls about
// eightfold from the bottom of the keyboard to the top, from four and a half
// milliseconds at A0 to half a millisecond at C8. A bass hammer rests on a
// long, heavy string; a treble hammer barely touches a short stiff one.
//
// Against the string's own period that means something different again. At A0
// contact is a twentieth of a period, so the hammer is long gone before the
// wave returns. At C8 it is comparable to the period. What must NOT happen is
// contact running to many periods: then the felt is still lying on the string
// through round trip after round trip, damping what it just excited, and the
// note comes out dull and choked no matter what the loss filter says.
//
// That is what a global change to felt stiffness did: it flattened contact to
// 1.5-2.7 ms everywhere, which is three times too short at A0 -- a sharp pulse
// on a long string, heard as a metallic zing -- and eleven periods at C8.
//
// So hardness is solved per note rather than set by hand: bisect on the
// hardness value until contactMs hits the target, at a mezzo-forte blow.
import { contactMs } from '../../src/dsp/hammer.js';
import { buildScale, DEFAULT_SCALE } from '../../src/dsp/scale.js';
import { noteHz } from '../../src/dsp/physics.js';

const FS = 48000;
const VEL = Number(process.env.VEL ?? 0.75);
const speed = 0.18 * Math.pow(VEL, 0.15) * Math.exp(3.5 * VEL * VEL);

// Measured contact durations, bass to treble. C4 at 2 ms is the one everybody
// reports (Chaigne & Askenfelt; Russell); the rest follows the usual curve.
const TARGET = [[21, 4.5], [33, 3.4], [45, 2.6], [60, 2.0], [72, 1.4], [84, 1.0], [96, 0.7], [108, 0.5]];
const lerpT = (t, x) => {
  if (x <= t[0][0]) return t[0][1];
  for (let i = 0; i < t.length - 1; i++) {
    if (x >= t[i][0] && x <= t[i + 1][0]) {
      const u = (x - t[i][0]) / (t[i + 1][0] - t[i][0]);
      return t[i][1] + (t[i + 1][1] - t[i][1]) * u;
    }
  }
  return t[t.length - 1][1];
};

const model = buildScale(DEFAULT_SCALE);
const KBASE = 1.8e9;

function contactFor(note, hardness) {
  return contactMs(FS, {
    mass: lerpT(DEFAULT_SCALE.voicing.hammerMass, note.midi) * Math.pow(10, -0.35 * hardness),
    K: KBASE * Math.pow(10, 2 * hardness),
    p: note.feltP,
    Z: note.Z * note.count,
    velocity: speed,
    strikeDelay: 8,
    eps: note.feltEps,
    tauUs: 2,
  });
}

const anchors = [21, 27, 33, 39, 45, 51, 57, 63, 69, 75, 81, 87, 93, 99, 105, 108];
const solved = [];
console.log(`solving at velocity ${VEL} (${speed.toFixed(2)} m/s)\n`);
console.log('note   target   solved   hardness   period   contact/period');
for (const midi of anchors) {
  const note = model.notes[midi - 21];
  const want = lerpT(TARGET, midi);
  // Contact shortens as the felt gets harder, so the bracket is monotone.
  let lo = -1.6, hi = 2.4;
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2;
    if (contactFor(note, mid) > want) lo = mid; else hi = mid;
  }
  const h = (lo + hi) / 2;
  const got = contactFor(note, h);
  const per = 1000 / noteHz(midi);
  solved.push([midi, +h.toFixed(3)]);
  console.log(
    `${note.name.padEnd(5)} ${want.toFixed(2).padStart(7)} ${got.toFixed(2).padStart(8)} ${h.toFixed(3).padStart(10)}` +
    ` ${per.toFixed(2).padStart(8)} ${(got / per).toFixed(2).padStart(15)}`,
  );
}
console.log('\n    hardness: ' + JSON.stringify(solved).replace(/\],\[/g, '], [') + ',');
