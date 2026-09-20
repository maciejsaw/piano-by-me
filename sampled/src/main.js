// Main thread: load the library, build the instrument, wire the controls.
import { Library } from './library.js';
import { Curves, createEditor, PARAMS, noteName, LOW, HIGH } from './curves.js';
import { Engine } from './engine.js';
import { buildKeyboard } from './keyboard.js';
import { levelDb, pickLayer } from './velocity.js';
import { Envelopes } from './envelopes.js';
import { createBezierEditor, SHAPES } from './bezier.js';
import { BANDS } from './eq.js';

const $ = (id) => document.getElementById(id);
const STORE = 'piano-sampled-curves';

let ctx = null, lib = null, engine = null, kb = null;
let selNote = 60;
const curves = new Curves();
const envelopes = new Envelopes();
let envEditors = [];
const down = new Set(), silent = new Set();

// ------------------------------------------------------------------ start --
async function start() {
  $('startBtn').disabled = true;
  $('startBtn').textContent = 'loading…';
  ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
  await ctx.resume();

  lib = new Library(ctx, './samples', { budgetMb: +$('budget').value });
  try { await lib.loadManifest(); }
  catch (e) {
    $('startBtn').disabled = false;
    $('startBtn').textContent = 'Start audio';
    $('loadMsg').innerHTML = `<b style="color:#e08a6a">${e.message}</b><br>
      Run <code>node tools/sampler/fetch.mjs</code> then <code>node tools/sampler/build.mjs</code>.`;
    return;
  }
  lib.onprogress = updateLoad;

  engine = new Engine(ctx, lib, curves, envelopes);
  restore();
  buildUI();

  // Enough to play with before the rest arrives: the mezzo-forte layer, from
  // the middle of the keyboard outwards.
  lib.startWarm(LOW, HIGH);
  // Handles for the console and for tools/sampler/browser-test.mjs. Everything
  // the UI can do is a method on one of these.
  window.piano = { ctx, lib, engine, curves, envelopes, noteOn, noteOff, setPedal, setSostenuto, setUna, toggleSilent, pickLayer, levelDb, ui: true };
  $('overlay').style.display = 'none';
  // The resonance tick has to keep running; the painting does not. Offline
  // rendering turns the UI off, because repainting 88 keys every 40 ms is
  // enough main-thread work to jitter a note scheduler by ten milliseconds.
  const ticker = setInterval(() => { engine.tick(0.04); if (window.piano.ui) paintResonance(); }, 40);
  const loader = setInterval(() => { if (window.piano.ui) updateLoad(); }, 400);
  window.piano.ui = true;
  window.piano.timers = { ticker, loader };
  initMidi();
}

// ------------------------------------------------------------- note events --
function noteOn(midi, vel) {
  if (!engine || midi < LOW || midi > HIGH) return;
  engine.noteOn(midi, vel);
  down.add(midi); paint(midi); editor?.playing();
}
function noteOff(midi, vel = 64) {
  if (!engine) return;
  engine.noteOff(midi, vel);
  down.delete(midi); paint(midi); editor?.playing();
}
function toggleSilent(midi) {
  silent.has(midi) ? silent.delete(midi) : silent.add(midi);
  engine.silentHold(midi, silent.has(midi));
  paint(midi);
}
const paint = (m) => kb?.paint(m, {
  down: down.has(m), silent: silent.has(m), selected: m === selNote,
  resonating: engine?.res.voices.has(m),
});
let lastRes = new Set();
function paintResonance() {
  const now = new Set(engine.res.voices.keys());
  for (const m of lastRes) if (!now.has(m)) paint(m);
  for (const m of now) if (!lastRes.has(m)) paint(m);
  lastRes = now;
  const s = engine.stats();
  $('statVoices').textContent = s.voices;
  $('statRes').textContent = s.resonating;
  $('statUndamped').textContent = s.undamped;
}

function select(m) {
  const prev = selNote; selNote = m;
  paint(prev); paint(m);
  editor?.refresh();
  renderNote();
  redrawEnvs();          // the hold curve's ghost is the SELECTED note's decay
}
const redrawEnvs = () => { for (const e of envEditors) e.draw(); const n = $('hoNote'); if (n) n.textContent = noteName(selNote); };

// -------------------------------------------------------------------- MIDI --
async function initMidi() {
  if (!navigator.requestMIDIAccess) { $('midiSel').innerHTML = '<option>Web MIDI unsupported (use Chrome/Edge)</option>'; return; }
  let access;
  try { access = await navigator.requestMIDIAccess(); }
  catch { $('midiSel').innerHTML = '<option>MIDI permission denied</option>'; return; }
  const refresh = () => {
    const inputs = [...access.inputs.values()];
    $('midiSel').innerHTML = inputs.length
      ? inputs.map((i, k) => `<option value="${k}">${i.name}</option>`).join('')
      : '<option>no MIDI device</option>';
    inputs.forEach((i) => { i.onmidimessage = onMidi; });
  };
  access.onstatechange = refresh;
  refresh();
}
function onMidi(e) {
  const [st, d1, d2] = e.data;
  const cmd = st & 0xf0;
  if (cmd === 0x90 && d2 > 0) noteOn(d1, d2);
  else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) noteOff(d1, d2 || 64);
  else if (cmd === 0xb0) {
    // Continuous, not a switch: a half-pedalled CC 64 is a real technique and
    // most controllers send the whole range.
    if (d1 === 64) setPedal(d2 / 127);
    if (d1 === 66) setSostenuto(d2 >= 64);
    if (d1 === 67) setUna(d2 / 127);
    if (d1 === 123) engine.panic();
  }
}

// ------------------------------------------------------------------ pedals --
function setPedal(v) {
  engine.setPedal(v);
  $('pedalBtn').classList.toggle('on', v >= 0.5);
  $('pedalBtn').textContent = v < 0.02 ? 'sustain' : v >= 0.98 ? 'sustain ▮▮▮' : `sustain ${(v * 100) | 0}%`;
  $('ped').value = v;
}
function setSostenuto(on) { engine.setSostenuto(on); $('sostBtn').classList.toggle('on', on); }
function setUna(v) { engine.setUnaCorda(v); $('unaBtn').classList.toggle('on', v >= 0.5); }

// -------------------------------------------------------- computer keyboard --
const MAP = { z: 0, s: 1, x: 2, d: 3, c: 4, v: 5, g: 6, b: 7, h: 8, n: 9, j: 10, m: 11,
  q: 12, 2: 13, w: 14, 3: 15, e: 16, r: 17, 5: 18, t: 19, 6: 20, y: 21, 7: 22, u: 23 };
let octave = 4;
addEventListener('keydown', (e) => {
  if (e.repeat || e.metaKey || e.ctrlKey || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
  if (e.key === ' ') { e.preventDefault(); setPedal(1); return; }
  if (e.key === ',') { octave = Math.max(0, octave - 1); return; }
  if (e.key === '.') { octave = Math.min(7, octave + 1); return; }
  const k = MAP[e.key.toLowerCase()];
  if (k !== undefined) { e.preventDefault(); noteOn(12 * octave + 12 + k, 96); }
});
addEventListener('keyup', (e) => {
  if (e.key === ' ') { setPedal(0); return; }
  const k = MAP[e.key.toLowerCase()];
  if (k !== undefined) noteOff(12 * octave + 12 + k);
});

// ---------------------------------------------------------------------- UI --
let editor = null;
function buildUI() {
  kb = buildKeyboard($('kbInner'), {
    lo: LOW, hi: HIGH,
    onDown: noteOn, onUp: (m) => noteOff(m), onSelect: select, onSilent: toggleSilent,
  });
  for (let m = LOW; m <= HIGH; m++) paint(m);

  editor = createEditor($('editor'), curves, () => {
    engine.refreshStrips();
    renderNote();
    save();
  }, () => selNote, () => down);

  bezierRow('na', envelopes.noteAttack);
  bezierRow('nr', envelopes.noteRelease);
  bezierRow('ra', envelopes.relAttack);
  bezierRow('rr', envelopes.relRelease);
  bezierRow('ho', envelopes.hold, { ghost: () => envelopes.ghostFor(lib.note(selNote)) });
  buildEq();

  const bind = (id, fn, fmt) => {
    const el = $(id), out = $(id + 'V');
    const run = () => { const v = +el.value; fn(v); if (out) out.textContent = fmt ? fmt(v) : v.toFixed(2); };
    el.oninput = run; run();
  };
  const db = (v) => `${v >= 0 ? '+' : ''}${(20 * Math.log10(Math.max(v, 1e-4))).toFixed(1)} dB`;

  bind('gain', (v) => { engine.master.gain.value = v; }, db);
  bind('spread', (v) => { engine.spread = v; engine.refreshStrips(); });
  bind('width', (v) => { engine.width = v; engine.refreshStrips(); }, (v) => v.toFixed(2) + '×');
  bind('wet', (v) => { engine.wet.gain.value = v; }, db);
  bind('rt60', (v) => engine.setRoom({ rt60: v }), (v) => v.toFixed(2) + ' s');
  bind('size', (v) => engine.setRoom({ width: 7.2 * v, depth: 9.5 * v, height: 3.8 * Math.sqrt(v) }), (v) => (9.5 * v).toFixed(1) + ' m deep');
  bind('absorb', (v) => engine.setRoom({ absorption: v }));
  bind('dist', (v) => engine.setRoom({ distance: v }), (v) => v < 0.5 ? 'over the strings' : v < 0.8 ? 'at the piano' : 'across the room');
  bind('resAmt', (v) => { engine.res.amount = v; }, (v) => `${v.toFixed(3)} (${(20 * Math.log10(v / 0.15)).toFixed(1)} dB of default)`);
  bind('resDrive', (v) => { engine.res.drive = v; }, (v) => v.toFixed(1) + ' (vel^n)');
  bind('resSel', (v) => { engine.res.build(v); }, (v) => v.toFixed(1) + '× bandwidth');
  bind('resTone', (v) => engine.res.setTone(v), (v) => (v / 1000).toFixed(1) + ' kHz');
  bind('resMax', (v) => { engine.res.maxVoices = v; }, (v) => v.toFixed(0) + ' voices');
  bind('relNoise', (v) => { engine.releaseNoise = v; }, db);
  bind('dampNoise', (v) => { engine.damperNoise = v; }, db);
  bind('pedNoise', (v) => { engine.pedalNoise = v; }, db);
  bind('ped', setPedal, (v) => (v * 100).toFixed(0) + '%');
  bind('una', setUna, (v) => (v * 100).toFixed(0) + '%');
  bind('budget', (v) => { if (lib) lib.budget = v * 1048576; }, (v) => v.toFixed(0) + ' MB');

  const envMs = (id, env) => bind(id, (v) => { env.ms = v; save(); }, (v) => v.toFixed(0) + ' ms');
  envMs('naMs', envelopes.noteAttack);
  envMs('raMs', envelopes.relAttack);
  envMs('rrMs', envelopes.relRelease);
  bind('hoSec', (v) => { envelopes.hold.seconds = v; redrawEnvs(); save(); }, (v) => v.toFixed(1) + ' s held');
  bind('hoFloor', (v) => { envelopes.hold.floorDb = v; redrawEnvs(); save(); }, (v) => v.toFixed(0) + ' dB');
  bind('hoKey', (v) => { envelopes.hold.keyNoiseFollow = v; save(); }, (v) => (v * 100).toFixed(0) + '%');

  $('limBtn').onclick = () => {
    engine.setLimiter(!engine.limiterOn);
    $('limBtn').classList.toggle('on', engine.limiterOn);
    $('limBtn').textContent = engine.limiterOn ? 'on' : 'off (watch your ears)';
  };
  $('persBtn').onclick = () => {
    engine.perspective *= -1;
    $('persBtn').textContent = engine.perspective > 0 ? "player's view" : 'audience view';
    engine.refreshStrips();
  };
  $('resBtn').onclick = () => {
    engine.res.enabled = !engine.res.enabled;
    $('resBtn').classList.toggle('on', engine.res.enabled);
    $('resBtn').textContent = engine.res.enabled ? 'resonance on' : 'resonance off';
  };
  $('pedalBtn').onclick = () => setPedal(engine.pedal >= 0.5 ? 0 : 1);
  $('sostBtn').onclick = () => setSostenuto(!engine.sostenuto.size);
  $('unaBtn').onclick = () => setUna(engine.unaCorda >= 0.5 ? 0 : 1);
  $('panicBtn').onclick = () => {
    engine.panic(); down.clear(); silent.clear();
    for (let m = LOW; m <= HIGH; m++) paint(m);
    editor?.playing();
  };
  renderNote();
}

const save = () => localStorage.setItem(STORE, JSON.stringify({
  curves: curves.toJSON(), envelopes: envelopes.toJSON(), eq: engine?.eq.toJSON(),
}));
// ------------------------------------------------------------------- EQ ----
const EQ_FREQS = (() => { const f = new Float32Array(160); for (let i = 0; i < 160; i++) f[i] = 20 * Math.pow(1000, i / 159); return f; })();

function drawEq() {
  const c = $('eqCanvas'), g = c.getContext('2d');
  const w = c.width = c.clientWidth * devicePixelRatio, h = c.height;
  g.fillStyle = '#17150f'; g.fillRect(0, 0, w, h);
  const yOf = (db) => h / 2 - (db / 18) * (h / 2 - 4);
  g.strokeStyle = '#2b261d';
  for (const db of [-12, -6, 6, 12]) { g.beginPath(); g.moveTo(0, yOf(db)); g.lineTo(w, yOf(db)); g.stroke(); }
  g.font = `${9 * devicePixelRatio}px ui-monospace,monospace`;
  for (const f of [100, 1000, 10000]) {
    const x = Math.log(f / 20) / Math.log(1000) * w;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
    g.fillStyle = '#6d6458'; g.textAlign = 'left';
    g.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x + 3, h - 3);
  }
  g.strokeStyle = '#4a4134'; g.beginPath(); g.moveTo(0, yOf(0)); g.lineTo(w, yOf(0)); g.stroke();
  const resp = engine.eq.response(EQ_FREQS);
  g.strokeStyle = engine.eq.enabled ? '#d9a441' : '#4a4134';
  g.lineWidth = 2 * devicePixelRatio;
  g.beginPath();
  for (let i = 0; i < EQ_FREQS.length; i++) {
    const x = i / (EQ_FREQS.length - 1) * w;
    const y = Math.max(1, Math.min(h - 1, yOf(resp[i])));
    i ? g.lineTo(x, y) : g.moveTo(x, y);
  }
  g.stroke();
}

function buildEq() {
  const root = $('eqBands');
  root.innerHTML = '';
  BANDS.forEach((b, i) => {
    const row = document.createElement('div');
    const qCtl = b.hasQ ? `<input type="range" class="q" min="0.3" max="4" step="0.05" value="${b.q}" title="Q">` : '';
    row.innerHTML = `<div class="eqband"><label title="${b.type}">${b.label}</label>
      <input type="range" class="f" min="${Math.log(b.fMin)}" max="${Math.log(b.fMax)}" step="0.001" value="${Math.log(b.freq)}" title="frequency">
      <input type="range" class="g" min="-15" max="15" step="0.1" value="${b.gain}" title="gain">
      ${qCtl}<output></output></div>`;
    root.appendChild(row);
    const f = row.querySelector('.f'), gg = row.querySelector('.g'), q = row.querySelector('.q');
    const show = () => {
      const hz = Math.exp(+f.value);
      row.querySelector('output').textContent =
        `${hz < 1000 ? hz.toFixed(0) : (hz / 1000).toFixed(2) + 'k'} ${(+gg.value >= 0 ? '+' : '')}${(+gg.value).toFixed(1)}`;
    };
    const apply = () => {
      engine.eq.set(i, 'freq', Math.exp(+f.value));
      engine.eq.set(i, 'gain', +gg.value);
      if (q) engine.eq.set(i, 'q', +q.value);
      show(); drawEq(); save();
    };
    f.oninput = gg.oninput = apply;
    if (q) q.oninput = apply;
    show();
  });
  $('eqBtn').onclick = () => {
    engine.eq.setEnabled(!engine.eq.enabled);
    $('eqBtn').classList.toggle('on', engine.eq.enabled);
    $('eqBtn').textContent = engine.eq.enabled ? 'enabled' : 'bypassed';
    drawEq();
  };
  drawEq();
}

function restore() {
  try {
    const o = JSON.parse(localStorage.getItem(STORE));
    curves.fromJSON(o?.curves);
    envelopes.fromJSON(o?.envelopes);
    engine.eq.fromJSON(o?.eq);
  } catch { /* first run, or a shape this version no longer has */ }
}

/**
 * Wire one Bezier editor: the canvas, its preset buttons, and any sliders.
 *
 * The presets are starting points rather than choices -- they set the handles
 * and then you move them. A preset that could not be adjusted would be back to
 * having a fixed shape and only a time knob, which is the thing these replace.
 */
function bezierRow(id, env, { ghost = null, note = null } = {}) {
  const canvas = $(id + 'Canvas');
  const ed = createBezierEditor(canvas, env.shape, () => { save(); }, { ghost });
  const bar = $(id + 'Preset');
  for (const [name, make] of Object.entries(SHAPES)) {
    const b = document.createElement('button');
    b.textContent = name;
    b.onclick = () => { const n = make(); env.shape.set(n.x1, n.y1, n.x2, n.y2); ed.draw(); save(); };
    bar.appendChild(b);
  }
  envEditors.push(ed);
  return ed;
}

/** The inspector: what this key is made of, and what a velocity will do to it. */
function renderNote() {
  if (!lib) return;
  const n = lib.note(selNote);
  if (!n) return;
  const rel = lib.relDb[selNote] ?? {};
  const top = lib.layers[lib.layers.length - 1];
  $('noteName').textContent = n.name;
  $('noteTable').innerHTML = `
    <tr><td>recorded as</td><td>${noteName(n.src)}${n.shift ? `, shifted ${n.shift > 0 ? '+' : ''}${n.shift} semitone` : ' (root, untouched)'}</td></tr>
    <tr><td>pitch</td><td>${n.hz?.toFixed(2) ?? '–'} Hz${n.cents != null ? ` (${n.cents > 0 ? '+' : ''}${n.cents.toFixed(1)}¢ of equal)` : ''}</td></tr>
    <tr><td>layers</td><td>${Object.keys(n.layers).length}, spanning ${(-Math.min(...Object.values(rel))).toFixed(1)} dB</td></tr>
    <tr><td>decay</td><td>${n.layers[top]?.edr?.toFixed(1) ?? '–'} dB/s at ff, ${n.layers[1]?.edr?.toFixed(1) ?? '–'} at pp</td></tr>
    <tr><td>longest</td><td>${n.layers[top]?.dur?.toFixed(1) ?? '–'} s</td></tr>
    <tr><td>damper</td><td>${selNote <= lib.m.highestDamped ? 'yes' : 'none — always rings'}</td></tr>`;

  const c = $('velCanvas'), g = c.getContext('2d');
  const w = c.width = c.clientWidth * devicePixelRatio, h = c.height;
  g.fillStyle = '#17150f'; g.fillRect(0, 0, w, h);
  const dyn = curves.at('dynamic', selNote), gam = Math.max(0.15, curves.at('gamma', selNote));
  const bias = Math.round(curves.at('layerBias', selNote));
  // the layer each velocity reaches for, as a background band
  for (let v = 1; v <= 127; v++) {
    const l = pickLayer(v, lib.m.hivel, lib.layers, bias);
    g.fillStyle = l % 2 ? '#201c14' : '#262117';
    g.fillRect((v - 1) / 127 * w, 0, w / 127 + 1, h);
  }
  g.strokeStyle = '#3a3328';
  for (let d = 0; d >= -48; d -= 12) {
    const y = (-d / 48) * h;
    g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
  }
  g.strokeStyle = '#d9a441'; g.lineWidth = 2 * devicePixelRatio; g.beginPath();
  for (let v = 1; v <= 127; v++) {
    const y = Math.min(h, (-(levelDb(v, dyn, gam) + curves.at('trim', selNote)) / 48) * h);
    v === 1 ? g.moveTo(0, y) : g.lineTo((v - 1) / 127 * w, y);
  }
  g.stroke();
  const rows = [1, 16, 32, 48, 64, 80, 96, 112, 127].map((v) => {
    const l = pickLayer(v, lib.m.hivel, lib.layers, bias);
    const target = levelDb(v, dyn, gam) + curves.at('trim', selNote);
    const already = rel[l] ?? 0;
    return `<tr><td>vel ${String(v).padStart(3)}</td><td>layer ${String(l).padStart(2)}</td>
      <td>${target.toFixed(1)} dB</td><td>${(target - already >= 0 ? '+' : '')}${(target - already).toFixed(1)} on it</td></tr>`;
  }).join('');
  $('velTable').innerHTML = `<tr><td colspan="4" style="color:var(--dim)">what each velocity does on ${noteName(selNote)}:
    which recording, the level asked for, and the trim applied to that recording to get there</td></tr>${rows}`;

  $('velHint').textContent = `${noteName(selNote)} — ${dyn.toFixed(0)} dB range, curve ${gam.toFixed(2)}${bias ? `, layer bias ${bias > 0 ? '+' : ''}${bias}` : ''}. Bands are which of the ${lib.layers.length} recordings each velocity plays.`;
}

function updateLoad() {
  if (!lib) return;
  const total = lib.layers.length * 88;
  $('statLoad').textContent = `${lib.loaded}/${total}`;
  $('statKeys').textContent = `${lib.keysReady()}/88`;
  $('statMem').textContent = `${(lib.bytes / 1048576).toFixed(0)} MB`;
  $('loadBar').style.width = `${Math.min(100, lib.loaded / total * 100)}%`;
}

$('startBtn').onclick = () => start().catch((e) => {
  $('loadMsg').innerHTML = `<b style="color:#e08a6a">${e.message}</b>`;
  $('startBtn').disabled = false; $('startBtn').textContent = 'Start audio';
});
