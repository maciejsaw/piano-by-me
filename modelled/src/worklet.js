// Audio-thread host. Deliberately thin: it owns the Piano and applies messages.
// Filter design happens on the MAIN thread (same modules) and arrives here as
// ready-made coefficients, so turning a knob costs the audio thread nothing.

import { Piano } from './dsp/piano.js';
import { Room } from './dsp/room.js';

class PianoProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions || {};
    this.piano = new Piano(sampleRate, {
      quality: o.quality ?? 16,
      unisonCoupling: o.unisonCoupling ?? 0.55,
      bridgeCoupling: o.bridgeCoupling ?? 0.30,
      body: o.body, room: o.room,
    });
    this.gain = o.gain ?? 1;
    this.frames = 0;
    this.load = 0;
    this.port.onmessage = (e) => this.handle(e.data);
    this.port.postMessage({ type: 'ready', strings: this.piano.strings.length });
  }

  handle(m) {
    const p = this.piano;
    switch (m.type) {
      case 'noteOn':      p.noteOn(m.midi, m.velocity); break;
      case 'noteOff':     p.noteOff(m.midi); break;
      case 'sustain':     p.setSustain(m.on); break;
      case 'unaCorda':    p.setUnaCorda(m.on); break;
      case 'gain':        this.gain = m.value; break;
      case 'panic':       p.panic(); break;
      case 'offsets':     p.setOffsets(m.state); break;
      case 'room': {
        // Levels and the bypass are free to set live; anything that changes a
        // delay length has to be rebuilt, so only do that when asked.
        const r = p.room;
        if (m.enabled !== undefined) r.enabled = m.enabled;
        if (m.mix !== undefined) r.mix = m.mix;
        if (m.erLevel !== undefined) r.erLevel = m.erLevel;
        if (m.tailLevel !== undefined) r.tailLevel = m.tailLevel;
        if (m.rebuild) p.room = new Room(sampleRate, m.opts || {});
        break;
      }
      case 'body': {
        // Rebuilding the cavity reallocates resonators, so do it only when a
        // dimension actually changed; mixes and gains are free to set live.
        const b = p.body;
        if (m.enabled !== undefined) b.enabled = m.enabled;
        if (m.cavityMix !== undefined) b.cavityMix = m.cavityMix;
        if (m.lidGain !== undefined) b.lidGain = m.lidGain;
        if (m.rebuild) p.rebuildBody(m.opts);
        break;
      }
      case 'coupling':
        p.unisonCoupling = m.unison; p.bridgeCoupling = m.bridge;
        for (const s of p.strings) p.recompileString(s);
        break;
      case 'coeffs': {
        // Pre-designed on the main thread; just swap them in.
        const s = p.strings[m.id];
        if (!s) break;
        Object.assign(s.tuning, m.tuning);
        s.coeffs = m.coeffs;
        s.kUnison = m.kUnison;
        s.kBridge = m.kBridge;
        s.setCoefficients(m.coeffs);
        break;
      }
      case 'silentHold': {
        // Depress keys without striking: the sympathetic-resonance demo.
        const note = p.notes[m.midi - 21];
        if (note) { for (const s of note.voices) s.setDamper(!m.on); note.held = m.on; }
        p.refreshActive();
        break;
      }
    }
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const ch = out[0];
    const t0 = currentTime;
    if (out.length > 1) {
      this.piano.renderStereo(ch, out[1], ch.length);
      if (this.gain !== 1) {
        for (let i = 0; i < ch.length; i++) { ch[i] *= this.gain; out[1][i] *= this.gain; }
      }
      for (let c = 2; c < out.length; c++) out[c].set(ch);
    } else {
      this.piano.render(ch, ch.length);
      if (this.gain !== 1) for (let i = 0; i < ch.length; i++) ch[i] *= this.gain;
    }

    // Report load and active-string count a few times a second.
    this.frames += ch.length;
    if (this.frames >= sampleRate / 6) {
      this.frames = 0;
      this.port.postMessage({
        type: 'stats',
        active: this.piano.active.length,
        load: (currentTime - t0) * sampleRate / ch.length,
      });
    }
    return true;
  }
}

registerProcessor('piano-processor', PianoProcessor);
