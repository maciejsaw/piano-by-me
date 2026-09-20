// The five envelopes, and the one function that is not an envelope.
//
// A sampler's envelopes are not there to make the note -- the recording
// already is the note. They are there for the joins: the moment a damper
// lands, the moment a key comes back up, the moment a release sample starts
// on top of a note that has not finished. Every one of those is a crossfade,
// and what a crossfade sounds like is entirely its shape.
//
// Hence Bézier rather than a time constant. See bezier.js for the argument.
import { Bezier, SHAPES } from './bezier.js';

export class Envelopes {
  constructor() {
    // The recording already contains a hammer strike, so this is zero by
    // default and doing nothing. It is here for taking the knock off the
    // front of a note, which is a real thing to want and impossible after
    // the fact any other way.
    this.noteAttack = { ms: 0, shape: SHAPES.fast() };

    // The damper landing. How LONG it takes is per key -- bass dampers are
    // slower, and the "Damper fall" curve on the right scales that. This is
    // the SHAPE, which is the part that decides whether a released chord
    // sounds stopped or swallowed.
    this.noteRelease = { shape: SHAPES.natural() };

    // The release samples' own envelopes. The attack matters more than it
    // looks: these start on top of a note that is still sounding, and a
    // release sample switched on at full level is a click.
    this.relAttack = { ms: 4, shape: SHAPES.fast() };
    this.relRelease = { ms: 240, shape: SHAPES.natural() };

    // The pedal-action sample's own attack. The pedal thud is a mechanical
    // event with a real rise to it, and shaping that rise -- softening the
    // knock, or sharpening it -- is separate from everything else, so it gets
    // its own curve. Its long reverberant tail is the engine's, not a shape.
    this.pedalAttack = { ms: 6, shape: SHAPES.fast() };

    // Release level against how long the key was held. Not an envelope -- a
    // function of a number that is not time-since-note-off.
    this.hold = { seconds: 8, floorDb: -26, shape: SHAPES.natural(), keyNoiseFollow: 0 };
  }

  /**
   * How loud a release sample should be after the key was held for `held`.
   *
   * The damper-release sound is the sound of a damper STOPPING something, so
   * it depends on how much is left to stop -- and a piano string four seconds
   * into its decay has very little. Salamander's SFZ models this as a flat
   * dB-per-second (rt_decay); this is the same idea with the shape exposed,
   * because a string's decay is not a straight line in dB and the first
   * second matters far more than the eighth.
   *
   * The editor draws the selected note's MEASURED decay behind the curve, so
   * "physically right" is something you can trace rather than something you
   * have to take on trust.
   */
  holdLevel(heldSeconds, follow = 1) {
    const u = Math.min(1, Math.max(0, heldSeconds / this.hold.seconds));
    const floor = Math.pow(10, this.hold.floorDb / 20);
    const full = 1 + (floor - 1) * this.hold.shape.at(u);
    return 1 + (full - 1) * Math.max(0, Math.min(1, follow));
  }

  /** The measured decay of `note`, on the hold curve's own axes, for the ghost. */
  ghostFor(note) {
    if (!note?.decay) return null;
    const floor = Math.pow(10, this.hold.floorDb / 20);
    if (Math.abs(floor - 1) < 1e-6) return null;      // no fade at all: nothing to trace
    const d = note.decay;
    const ref = Math.max(...d.db);
    const pts = [];
    for (let i = 0; i < d.t.length; i++) {
      const u = d.t[i] / this.hold.seconds;
      if (u > 1) break;
      const lin = Math.pow(10, (d.db[i] - ref) / 20);
      pts.push([u, Math.max(0, Math.min(1.25, (lin - 1) / (floor - 1)))]);
    }
    return pts.length > 1 ? pts : null;
  }

  toJSON() {
    return {
      noteAttack: { ms: this.noteAttack.ms, shape: this.noteAttack.shape.toJSON() },
      noteRelease: { shape: this.noteRelease.shape.toJSON() },
      relAttack: { ms: this.relAttack.ms, shape: this.relAttack.shape.toJSON() },
      relRelease: { ms: this.relRelease.ms, shape: this.relRelease.shape.toJSON() },
      pedalAttack: { ms: this.pedalAttack.ms, shape: this.pedalAttack.shape.toJSON() },
      hold: { seconds: this.hold.seconds, floorDb: this.hold.floorDb, keyNoiseFollow: this.hold.keyNoiseFollow, shape: this.hold.shape.toJSON() },
    };
  }
  fromJSON(o) {
    if (!o) return;
    const d = new Envelopes();
    for (const k of ['noteAttack', 'noteRelease', 'relAttack', 'relRelease', 'pedalAttack', 'hold']) {
      if (!o[k]) continue;
      // Keep the SAME shape instance -- the Bezier editors hold a reference to
      // it, so an import that replaced it would leave them editing a ghost.
      // Update its control points in place and copy the scalar fields.
      const { shape: sh, ...rest } = o[k];
      Object.assign(this[k], rest);
      const pts = Array.isArray(sh) && sh.length === 4 ? sh : d[k].shape.toJSON();
      this[k].shape.set(...pts);
    }
  }
}
