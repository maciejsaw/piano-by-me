// Main thread: audio graph, MIDI, UI, and the parameter compiler.
//
// Filter design runs HERE, not on the audio thread — the same modules the
// worklet uses. A knob edit compiles new coefficients and posts them, so the
// audio thread never does anything but arithmetic.

import { buildScale, DEFAULT_SCALE } from './dsp/scale.js';
import { compileString } from './dsp/design.js';
import { derive, noteName } from './dsp/physics.js';
import { Offsets } from './dsp/offsets.js';
import { createEditor } from './param-editor.js';
import { DEFAULT_SETTINGS } from './defaults.js';
import { volumeMap, hardnessMap, createVelMapEditor } from './velocity.js';
// The sampled piano's output EQ, unchanged: the same four bands on the same
// kind of master bus.
import { Eq, BANDS } from '../../sampled/src/eq.js';
// And its keyboard, the notes rising above it, the knobs and the (i) tooltips,
// so the two instruments look and play alike.
import { buildKeyboard as makeKeyboard } from '../../sampled/src/keyboard.js';
import { createStage } from '../../sampled/src/stage.js';
import { knob } from '../../sampled/src/knobs.js';
import { tipify } from '../../sampled/src/tips.js';

const $ = (id) => document.getElementById(id);
const LOW = 21, HIGH = 108;

let ctx = null, node = null, model = null, quality = 16;
let unisonCoupling = 0.55, bridgeCoupling = 0.30;
// Highest note that gets the long dispersion chain; below LOW means off.
let detailSplit = 48;
let selNote = 60, selString = 1;
const down = new Set(), silent = new Set();
// Declared here because the keyboard is built before the editor exists.
let editor = null;
// False until the saved session is back, so a half-restored state is never stored.
let uiReady = false;
// Velocity curves. They live here, not on the audio thread: a strike is
// posted with what they say about it, so the audio side never sees a curve.
const velVolume = volumeMap(), velHardness = hardnessMap();
let lastVel = null, lastVelAt = 0;
// The output EQ. `eqView` runs on an offline context from the start so the
// curve can be drawn and edited before there is any audio; `eqLive` is its
// twin in the real graph, built when audio starts from whatever eqView holds.
const eqView = new Eq(new OfflineAudioContext(1, 128, 48000));
let eqLive = null;

// Flat string index, matching the order Piano builds them in.
const baseIndex = new Map();
function indexModel() {
  let k = 0;
  for (const n of model.notes) { baseIndex.set(n.midi, k); k += n.count; }
}

// ---------------------------------------------------------------- audio ----
async function start() {
  ctx = new AudioContext({ latencyHint: 'interactive' });
  await ctx.audioWorklet.addModule('./src/worklet.js');
  // Everything the page holds goes in at construction -- a restored session's
  // sliders were set before there was an audio thread to post them to.
  node = new AudioWorkletNode(ctx, 'piano-processor', {
    numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
    processorOptions: {
      quality, unisonCoupling, bridgeCoupling, detailSplit, gain: +$('gain').value,
      body: { ...caseOpts(), cavityMix: +$('cmix').value, lidGain: +$('lid').value, enabled: bodyOn() },
      room: roomOpts(),
    },
  });
  node.port.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'ready') $('statStrings').textContent = m.strings;
    if (m.type === 'stats') {
      $('statActive').textContent = m.active;
      $('statLoad').textContent = (m.load * 100).toFixed(0) + '%';
    }
  };
  eqLive = new Eq(ctx);
  eqLive.fromJSON(eqView.toJSON());
  node.connect(eqLive.in);
  eqLive.out.connect(ctx.destination);
  // Offsets first: they recompile every string, which would undo a per-note
  // edit that went in ahead of them.
  if (!edits.empty) post({ type: 'offsets', state: edits.toJSON() });
  for (const midi of Object.keys(noteEdits)) pushNote(+midi, false);
  $('overlay').style.display = 'none';
}
const post = (m) => node && node.port.postMessage(m);

// ------------------------------------------------------------ note events --
function noteOn(midi, vel) {
  if (midi < LOW || midi > HIGH) return;
  down.add(midi); paintKey(midi);
  stage.noteOn(midi);
  const v127 = Math.max(1, Math.min(127, vel * 127));
  const shape = { hardness: velHardness.at(v127) };
  if (velVolume.enabled) shape.levelDb = velVolume.at(v127);
  post({ type: 'noteOn', midi, velocity: vel, shape });
  lastVel = v127; lastVelAt = performance.now();
  flashVel();
}
function noteOff(midi) {
  down.delete(midi); paintKey(midi);
  stage.noteOff(midi);
  post({ type: 'noteOff', midi });
}
function toggleSilent(midi) {
  const on = !silent.has(midi);
  on ? silent.add(midi) : silent.delete(midi);
  post({ type: 'silentHold', midi, on });
  paintKey(midi);
}

// -------------------------------------------------------------- keyboard ---
// Click (or touch) to play, higher on the key for harder; shift-click holds a
// key's dampers up without striking it.
let kb = null;
const stage = createStage($('stage'), { lo: LOW, hi: HIGH, res: () => null });
function buildKeyboard() {
  kb = makeKeyboard($('kbInner'), {
    lo: LOW, hi: HIGH,
    // The keyboard gives 18..127 from the front of the key to the back; this
    // instrument has always taken 0.45..0.95 from the same gesture.
    onDown: (m, v) => noteOn(m, 0.45 + 0.5 * (v - 18) / 109),
    onUp: (m) => down.has(m) && noteOff(m),
    onSelect: selectNote,
    onSilent: toggleSilent,
  });
  // Narrower than the whole keyboard (a phone): start on the middle of it.
  const k = $('kb');
  k.scrollLeft = (k.scrollWidth - k.clientWidth) / 2;
}
function paintKey(m) {
  kb?.paint(m, { down: down.has(m), silent: silent.has(m), selected: m === selNote });
}

// ------------------------------------------------------- computer keyboard -
const MAP = { z:0,s:1,x:2,d:3,c:4,v:5,g:6,b:7,h:8,n:9,j:10,m:11,
              q:12,2:13,w:14,3:15,e:16,r:17,5:18,t:19,6:20,y:21,7:22,u:23,i:24 };
let octave = 4;
addEventListener('keydown', (e) => {
  if (e.repeat || e.metaKey || e.ctrlKey) return;
  if (e.key === ' ') { e.preventDefault(); setSustain(true); return; }
  if (e.key === ',') { octave = Math.max(0, octave - 1); return; }
  if (e.key === '.') { octave = Math.min(7, octave + 1); return; }
  const k = MAP[e.key.toLowerCase()];
  if (k !== undefined) { e.preventDefault(); noteOn(12 * octave + 12 + k, 0.78); }
});
addEventListener('keyup', (e) => {
  if (e.key === ' ') { setSustain(false); return; }
  const k = MAP[e.key.toLowerCase()];
  if (k !== undefined) noteOff(12 * octave + 12 + k);
});

// ------------------------------------------------------------------ pedals -
let sustainOn = false;
function setSustain(on) {
  if (on === sustainOn) return;
  sustainOn = on;
  $('sustainBtn').classList.toggle('on', on);
  post({ type: 'sustain', on });
}

// -------------------------------------------------------------------- MIDI -
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
  if (cmd === 0x90 && d2 > 0) noteOn(d1, d2 / 127);
  else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) noteOff(d1);
  else if (cmd === 0xb0) {
    if (d1 === 64) setSustain(d2 >= 64);
    if (d1 === 67) { const on = d2 >= 64; $('unaBtn').classList.toggle('on', on); post({ type: 'unaCorda', on }); }
    if (d1 === 123) post({ type: 'panic' });
  }
}

// --------------------------------------------------------------- inspector -
function selectNote(midi) {
  const prev = selNote;
  selNote = midi;
  paintKey(prev); paintKey(midi);
  selString = Math.min(selString, model.notes[midi - LOW].count - 1);
  renderInspector();
  editor && editor.refreshSelection();
}

function renderInspector() {
  const n = model.notes[selNote - LOW];
  $('noteName').textContent = n.name;
  n.phys = derive(n.spec, n.f0);
  $('physTable').innerHTML = `
    <tr><td>fundamental</td><td>${n.f0.toFixed(2)} Hz</td></tr>
    <tr><td>type</td><td><span class="tag ${n.spec.wound ? 'w">wound' : 'p">plain'}</span></td></tr>
    <tr><td>speaking length</td><td>${(n.spec.lengthM * 1000).toFixed(0)} mm</td></tr>
    <tr><td>linear density</td><td>${(n.phys.mu * 1000).toFixed(2)} g/m</td></tr>
    <tr><td>tension</td><td>${n.phys.T.toFixed(0)} N</td></tr>
    <tr><td>inharmonicity B</td><td>${n.phys.B.toExponential(2)}</td></tr>
    <tr><td>16th partial</td><td>+${(1200 * Math.log2(Math.sqrt(1 + n.phys.B * 256))).toFixed(0)} cents</td></tr>
    <tr><td>strings</td><td>${n.count}</td></tr>
    <tr><td>damper</td><td>${n.hasDamper ? 'yes' : 'none (treble — rings on)'}</td></tr>`;

  $('stringSel').innerHTML = n.strings
    .map((s, i) => `<button data-i="${i}" class="${i === selString ? 'on' : ''}">string ${i + 1}</button>`).join('');
  [...$('stringSel').children].forEach((b) => {
    b.onclick = () => { selString = +b.dataset.i; renderInspector(); };
  });

  set('len', n.spec.lengthM, (v) => (v * 1000).toFixed(0) + ' mm');
  set('core', n.spec.coreDiameterMm, (v) => v.toFixed(3) + ' mm');
  set('wrap', n.spec.wrapOuterDiameterMm || 0, (v) => (v ? v.toFixed(2) + ' mm' : 'none'));

  const st = n.strings[selString];
  set('det', st.detuneCents, (v) => v.toFixed(2) + ' ¢');
  set('t60l', st.t60Low, (v) => v.toFixed(1) + ' s');
  set('t60h', st.t60High, (v) => v.toFixed(2) + ' s');
  set('strike', st.strikePosition, (v) => '1/' + (1 / v).toFixed(1));
  set('cpl', st.coupling, (v) => v.toFixed(2) + '×');
}
function set(id, value, fmt) {
  const el = $(id); el.value = value; $(id + 'V').textContent = fmt(+value);
}

// What the inspector has changed, as { midi: { spec: {k: v}, strings: {i: {k: v}} } }.
// Its sliders show whichever note is selected, so their positions mean nothing
// on their own; this is the part of them that is a setting.
let noteEdits = {};
function recordEdit(midi, where, key, value, string) {
  const e = (noteEdits[midi] ??= { spec: {}, strings: {} });
  if (where === 'spec') e.spec[key] = value;
  else (e.strings[string] ??= {})[key] = value;
  save();
}
/** Lay saved per-note edits over a freshly built model. */
function applyNoteEdits() {
  for (const [midi, e] of Object.entries(noteEdits)) {
    const n = model.notes[+midi - LOW];
    if (!n) continue;
    Object.assign(n.spec, e.spec);
    for (const [i, t] of Object.entries(e.strings ?? {})) if (n.strings[+i]) Object.assign(n.strings[+i], t);
  }
}

/** Recompile every string of a note and ship the coefficients to the audio thread. */
function pushNote(midi, render = true) {
  const n = model.notes[midi - LOW];
  n.phys = derive(n.spec, n.f0);
  const base = baseIndex.get(midi);
  n.strings.forEach((st, i) => {
    const frac = (unisonCoupling + bridgeCoupling) * st.coupling;
    const coeffs = compileString(ctx ? ctx.sampleRate : 48000, n.phys, {
      ...st, couplingFraction: frac, maxAllpass: quality,
    });
    const split = unisonCoupling / (unisonCoupling + bridgeCoupling || 1);
    post({
      type: 'coeffs', id: base + i, tuning: st, coeffs,
      kUnison: coeffs.kappa * split, kBridge: coeffs.kappa * (1 - split),
    });
  });
  if (render) renderInspector();
}

function bindNoteGeometry(id, apply, fmt) {
  $(id).addEventListener('input', (e) => {
    const n = model.notes[selNote - LOW];
    const changed = apply(n, +e.target.value);
    for (const [k, v] of Object.entries(changed)) recordEdit(selNote, 'spec', k, v);
    $(id + 'V').textContent = fmt(+e.target.value);
    pushNote(selNote);
  });
}
function bindString(id, key, fmt) {
  $(id).addEventListener('input', (e) => {
    model.notes[selNote - LOW].strings[selString][key] = +e.target.value;
    recordEdit(selNote, 'string', key, +e.target.value, selString);
    $(id + 'V').textContent = fmt(+e.target.value);
    pushNote(selNote);
  });
}

// ------------------------------------------------------------------- boot --
model = buildScale(DEFAULT_SCALE);
indexModel();
buildKeyboard();
selectNote(60);
initMidi();

$('startBtn').onclick = () => start();
$('sustainBtn').onclick = () => setSustain(!sustainOn);
$('unaBtn').onclick = (e) => {
  const on = !e.target.classList.contains('on');
  e.target.classList.toggle('on', on);
  post({ type: 'unaCorda', on });
};
$('panicBtn').onclick = () => { down.clear(); silent.clear(); stage.clear(); post({ type: 'panic' }); for (let m = LOW; m <= HIGH; m++) paintKey(m); };

// ------------------------------------------------------------------ body ---
const caseOpts = () => ({
  caseWidth: +$('cw').value, caseLength: +$('cl').value, caseDepth: +$('cd').value,
  cavityQ: +$('cq').value,
});
const fmtM = (v) => (v * 100).toFixed(0) + ' cm';
for (const [id, fmt] of [['cw', fmtM], ['cl', fmtM], ['cd', fmtM], ['cq', (v) => v.toFixed(0)]]) {
  $(id).addEventListener('input', (e) => { $(id + 'V').textContent = fmt(+e.target.value); });
  $(id).addEventListener('change', () => post({ type: 'body', rebuild: true, opts: caseOpts() }));
  $(id + 'V').textContent = fmt(+$(id).value);
}
$('cmix').addEventListener('input', (e) => {
  $('cmixV').textContent = (+e.target.value).toFixed(2);
  post({ type: 'body', cavityMix: +e.target.value });
});
$('lid').addEventListener('input', (e) => {
  $('lidV').textContent = (+e.target.value).toFixed(2);
  post({ type: 'body', lidGain: +e.target.value });
});
$('cmixV').textContent = (+$('cmix').value).toFixed(2);
$('lidV').textContent = (+$('lid').value).toFixed(2);
const bodyOn = () => $('bodyBtn').classList.contains('on');
$('bodyBtn').onclick = (e) => {
  const on = !e.target.classList.contains('on');
  e.target.classList.toggle('on', on);
  e.target.textContent = on ? 'enabled' : 'bypassed';
  post({ type: 'body', enabled: on });
  save();
};

$('gain').addEventListener('input', (e) => { $('gainV').textContent = (+e.target.value).toFixed(2); post({ type: 'gain', value: +e.target.value }); });
const pushCoupling = () => post({ type: 'coupling', unison: unisonCoupling, bridge: bridgeCoupling });
$('uc').addEventListener('input', (e) => { unisonCoupling = +e.target.value; $('ucV').textContent = unisonCoupling.toFixed(2); });
$('uc').addEventListener('change', pushCoupling);
$('bc').addEventListener('input', (e) => { bridgeCoupling = +e.target.value; $('bcV').textContent = bridgeCoupling.toFixed(2); });
$('bc').addEventListener('change', pushCoupling);

// Bass clarity. The label is live; the post waits for the drag to end, because
// it recompiles every string in the register and that is not free.
const detailLabel = (v) =>
  (v < LOW ? 'off' : v >= HIGH ? 'whole keyboard' : `${noteName(v)} and below`);
$('detail').addEventListener('input', (e) => {
  detailSplit = +e.target.value;
  $('detailV').textContent = detailLabel(detailSplit);
});
$('detail').addEventListener('change', () => post({ type: 'detail', split: detailSplit }));

// Each returns the spec fields it changed, so exactly those are recorded.
bindNoteGeometry('len', (n, v) => ({ lengthM: (n.spec.lengthM = v) }), (v) => (v * 1000).toFixed(0) + ' mm');
bindNoteGeometry('core', (n, v) => ({ coreDiameterMm: (n.spec.coreDiameterMm = v) }), (v) => v.toFixed(3) + ' mm');
bindNoteGeometry('wrap', (n, v) => {
  n.spec.wrapOuterDiameterMm = v; n.spec.wound = v > n.spec.coreDiameterMm;
  return { wrapOuterDiameterMm: v, wound: n.spec.wound };
}, (v) => (v ? v.toFixed(2) + ' mm' : 'none'));
bindString('det', 'detuneCents', (v) => v.toFixed(2) + ' ¢');
bindString('t60l', 't60Low', (v) => v.toFixed(1) + ' s');
bindString('t60h', 't60High', (v) => v.toFixed(2) + ' s');
bindString('strike', 'strikePosition', (v) => '1/' + (1 / v).toFixed(1));
bindString('cpl', 'coupling', (v) => v.toFixed(2) + '×');
$('gainV').textContent = (+$('gain').value).toFixed(2);
$('ucV').textContent = unisonCoupling.toFixed(2);
$('bcV').textContent = bridgeCoupling.toFixed(2);
$('detailV').textContent = detailLabel(detailSplit);


// -------------------------------------------------------- parameter editor -
// The offsets live on the main thread and are posted to the audio thread as
// plain JSON. Nothing here designs a filter: Piano.setOffsets does that, on
// the audio side, and skips the expensive half when no parameter that is baked
// into a loop filter has moved.
const edits = new Offsets();

const pushOffsets = (state) => {
  post({ type: 'offsets', state });
  const n = Object.keys(state.global).length + Object.keys(state.keys).length;
  $('peCount').textContent = n;
  save();
};

editor = createEditor($('peRoot'), {
  offsets: edits,
  onChange: pushOffsets,
  selectedNote: () => selNote,
});

$('peResetAll').onclick = () => {
  edits.load({});
  editor.sync(); pushOffsets(edits.toJSON());
};


// -------------------------------------------------------------------- room -
// Levels and the bypass are live; anything that changes a delay length or an
// image-source distance rebuilds, so those go on `change` rather than `input`.
const roomOpts = () => ({
  width: +$('rW').value, depth: +$('rD').value, height: +$('rH').value,
  absorption: +$('rAbs').value, rt60: +$('rRt').value,
  predelayMs: +$('rPre').value, tailDampHz: +$('rDamp').value,
  mix: +$('rMix').value, erLevel: +$('rEr').value, tailLevel: +$('rTail').value,
  listener: { x: +$('rW').value * 0.5, y: +$('rD').value * +$('rPos').value, z: 1.2 },
  source: { x: +$('rW').value * 0.42, y: +$('rD').value * 0.30, z: 1.0 },
  // A rebuild is a new Room, so without this it would come back enabled.
  enabled: $('roomBtn').classList.contains('on'),
});
const roomLive = [['rMix', 'mix', 2], ['rEr', 'erLevel', 2], ['rTail', 'tailLevel', 2]];
for (const [id, key, dp] of roomLive) {
  const el = $(id);
  el.addEventListener('input', () => {
    $(id + 'V').textContent = (+el.value).toFixed(dp);
    post({ type: 'room', [key]: +el.value });
  });
  $(id + 'V').textContent = (+el.value).toFixed(dp);
}
const roomRebuild = [['rRt', (v) => v.toFixed(2) + ' s'], ['rW', (v) => v.toFixed(1) + ' m'],
  ['rD', (v) => v.toFixed(1) + ' m'], ['rH', (v) => v.toFixed(1) + ' m'],
  ['rAbs', (v) => v.toFixed(2)], ['rPre', (v) => v.toFixed(1) + ' ms'],
  ['rDamp', (v) => (v / 1000).toFixed(1) + ' kHz'], ['rPos', (v) => (v * 100).toFixed(0) + '% back']];
for (const [id, fmt] of roomRebuild) {
  const el = $(id);
  el.addEventListener('input', () => ($(id + 'V').textContent = fmt(+el.value)));
  el.addEventListener('change', () => post({ type: 'room', rebuild: true, opts: roomOpts() }));
  $(id + 'V').textContent = fmt(+el.value);
}
$('roomBtn').onclick = (e) => {
  const on = !e.target.classList.contains('on');
  e.target.classList.toggle('on', on);
  e.target.textContent = on ? 'enabled' : 'bypassed';
  post({ type: 'room', enabled: on });
  save();
};


// ---------------------------------------------------- settings: save, file -
// The whole tweakable state -- every instrument, body and room slider, the two
// toggles, the parameter editor's offsets and whatever the inspector changed on
// single notes -- kept in localStorage under this instrument's own key, and as
// one JSON file through the menu. The sampled piano keeps its own under
// 'piano-sampled-curves'; the two never read each other's.
//
// Applying drives the same events a human would (set a slider, dispatch its
// events, click a toggle that disagrees), so there is one code path that moves
// the instrument and a file cannot reach anything the UI cannot.
const STORE = 'piano-modelled-settings';
const LEGACY_OFFSETS = 'pianoModelX.offsets';   // the editor's old save button, now unused
// Performance controls, not settings -- and the inspector's, which show the
// selected note and are kept as noteEdits instead.
const NOT_SETTINGS = new Set(['len', 'core', 'wrap', 'det', 't60l', 't60h', 'strike', 'cpl']);
function save() { if (uiReady) localStorage.setItem(STORE, JSON.stringify(collectSettings())); }

function collectSettings() {
  const sliders = {};
  for (const el of document.querySelectorAll('input[type=range][id]')) {
    if (!NOT_SETTINGS.has(el.id)) sliders[el.id] = el.value;
  }
  return {
    app: 'piano-modelled', version: 1, saved: new Date().toISOString(),
    sliders,
    toggles: { body: bodyOn(), room: $('roomBtn').classList.contains('on') },
    offsets: edits.toJSON(),
    notes: noteEdits,
    eq: eqView.toJSON(),
    velocity: { volume: velVolume.toJSON(), hardness: velHardness.toJSON() },
  };
}

function applySettings(o) {
  if (!o || typeof o !== 'object' || (o.app && o.app !== 'piano-modelled')) {
    throw new Error('not an Electric clavinet settings file');
  }
  // A bare offsets file, from the parameter editor's old export button.
  if (!o.app && o.global && o.keys) o = { offsets: o };
  const was = uiReady; uiReady = false;          // one save at the end, not one per slider
  for (const [id, val] of Object.entries(o.sliders ?? {})) {
    const el = $(id);
    if (!el || NOT_SETTINGS.has(id)) continue;
    el.value = val;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const t = o.toggles ?? {};
  if (t.body != null && bodyOn() !== t.body) $('bodyBtn').click();
  if (t.room != null && $('roomBtn').classList.contains('on') !== t.room) $('roomBtn').click();
  // EQ and velocity curves: a file from before they existed goes back to flat.
  eqView.fromJSON(o.eq ?? { enabled: true, bands: BANDS.map((b) => [b.freq, b.q, b.gain]) });
  eqLive?.fromJSON(eqView.toJSON());
  syncEqUi();
  velVolume.reset(); velVolume.enabled = false; velVolume.fromJSON(o.velocity?.volume);
  velHardness.reset(); velHardness.fromJSON(o.velocity?.hardness);
  syncVelUi();
  edits.load(o.offsets ?? {});
  editor.sync(); pushOffsets(edits.toJSON());
  // Notes: rebuild from the curves, then lay the file's edits over them, so a
  // note edited before and absent from the file goes back to the curve.
  const had = Object.keys(noteEdits);
  noteEdits = o.notes ?? {};
  model = buildScale(DEFAULT_SCALE);
  applyNoteEdits();
  for (const midi of new Set([...had, ...Object.keys(noteEdits)])) pushNote(+midi, false);
  renderInspector();
  uiReady = was;
  save();
}

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function wireMenu() {
  const menu = $('menu');
  $('menuBtn').onclick = (e) => { e.stopPropagation(); menu.classList.toggle('open'); };
  document.addEventListener('click', () => menu.classList.remove('open'));
  $('exportBtn').onclick = () =>
    download(`piano-modelled-${new Date().toISOString().slice(0, 10)}.json`,
      JSON.stringify(collectSettings(), null, 2));
  $('importBtn').onclick = () => $('importFile').click();
  $('importFile').onchange = async (e) => {
    const file = e.target.files?.[0];
    if (file) {
      try { applySettings(JSON.parse(await file.text())); }
      catch (err) { alert('Could not import settings: ' + err.message); }
    }
    e.target.value = '';
  };
  $('resetAllBtn').onclick = () => {
    if (confirm('Reset every setting to the shipped defaults? This reloads the page.')) {
      localStorage.removeItem(STORE); location.reload();
    }
  };
}

// Any settings slider saves when it moves; their own handlers do the rest.
document.addEventListener('input', (e) => {
  const el = e.target;
  if (el instanceof HTMLInputElement && el.type === 'range' && el.id && !NOT_SETTINGS.has(el.id)) save();
});

// --------------------------------------------------------------- velocity -
const velVolEditor = createVelMapEditor($('velVolCanvas'), velVolume, {
  grid: [-12, -24, -36, -48, -60], label: (d) => `${d} dB`, zero: 0,
  markVel: () => (performance.now() - lastVelAt < 900 ? lastVel : null),
  onChange: () => save(),
});
const velHardEditor = createVelMapEditor($('velHardCanvas'), velHardness, {
  grid: [0.5, -0.5], label: (y) => (y > 0 ? '+' : '') + y.toFixed(1), zero: 0,
  markVel: () => (performance.now() - lastVelAt < 900 ? lastVel : null),
  onChange: () => { showHardness(); save(); },
});
function showHardness() {
  const p = velHardness.points;
  const flat = p.every((q) => Math.abs(q.y) < 1e-3);
  $('velHardV').textContent = flat ? 'flat — voicing as fitted'
    : `${fmtH(velHardness.at(1))} at pp … ${fmtH(velHardness.at(127))} at fff`;
}
const fmtH = (y) => (y >= 0 ? '+' : '') + y.toFixed(2);
function syncVelUi() {
  $('velVolBtn').classList.toggle('on', velVolume.enabled);
  $('velVolBtn').textContent = velVolume.enabled ? 'on — hand-drawn volume curve' : 'off — level from hammer speed';
  velVolEditor.draw(); velHardEditor.draw(); showHardness();
}
// The last-hit marker fades out on its own, so redraw a little after a strike.
let velFlashTimer = 0;
function flashVel() {
  velVolEditor.draw(); velHardEditor.draw();
  clearTimeout(velFlashTimer);
  velFlashTimer = setTimeout(() => { velVolEditor.draw(); velHardEditor.draw(); }, 950);
}
$('velVolBtn').onclick = () => { velVolume.enabled = !velVolume.enabled; syncVelUi(); save(); };
$('velVolReset').onclick = () => { velVolume.reset(); syncVelUi(); save(); };
$('velHardReset').onclick = () => { velHardness.reset(); syncVelUi(); save(); };
addEventListener('resize', () => { velVolEditor.draw(); velHardEditor.draw(); drawEq(); });

// --------------------------------------------------------------------- EQ --
const EQ_FREQS = (() => { const f = new Float32Array(160); for (let i = 0; i < 160; i++) f[i] = 20 * Math.pow(1000, i / 159); return f; })();
const eqs = () => (eqLive ? [eqView, eqLive] : [eqView]);

function drawEq() {
  const c = $('eqCanvas'), g = c.getContext('2d');
  const w = c.width = c.clientWidth * devicePixelRatio, h = c.height;
  g.fillStyle = '#0d1119'; g.fillRect(0, 0, w, h);
  const yOf = (db) => h / 2 - (db / 18) * (h / 2 - 4);
  g.strokeStyle = '#19202f';
  for (const db of [-12, -6, 6, 12]) { g.beginPath(); g.moveTo(0, yOf(db)); g.lineTo(w, yOf(db)); g.stroke(); }
  g.font = `${9 * devicePixelRatio}px ui-monospace,monospace`;
  for (const f of [100, 1000, 10000]) {
    const x = Math.log(f / 20) / Math.log(1000) * w;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
    g.fillStyle = '#4f5c76'; g.textAlign = 'left';
    g.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x + 3, h - 3);
  }
  g.strokeStyle = '#323b4c'; g.beginPath(); g.moveTo(0, yOf(0)); g.lineTo(w, yOf(0)); g.stroke();
  const resp = eqView.response(EQ_FREQS);
  g.strokeStyle = eqView.enabled ? '#d8c4a2' : '#323b4c';
  g.lineWidth = 2 * devicePixelRatio;
  g.beginPath();
  for (let i = 0; i < EQ_FREQS.length; i++) {
    const x = i / (EQ_FREQS.length - 1) * w;
    const y = Math.max(1, Math.min(h - 1, yOf(resp[i])));
    i ? g.lineTo(x, y) : g.moveTo(x, y);
  }
  g.stroke();
}

const eqRows = [];
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
      for (const eq of eqs()) {
        eq.set(i, 'freq', Math.exp(+f.value));
        eq.set(i, 'gain', +gg.value);
        if (q) eq.set(i, 'q', +q.value);
      }
      show(); drawEq(); save();
    };
    f.oninput = gg.oninput = apply;
    if (q) q.oninput = apply;
    eqRows.push({ f, g: gg, q, show });
    show();
  });
  $('eqBtn').onclick = () => {
    const on = !eqView.enabled;
    for (const eq of eqs()) eq.setEnabled(on);
    syncEqUi();
    save();
  };
}
/** Put the band sliders and the bypass button where eqView says. */
function syncEqUi() {
  eqView.filters.forEach((flt, i) => {
    const r = eqRows[i]; if (!r) return;
    r.f.value = Math.log(flt.frequency.value);
    r.g.value = flt.gain.value;
    if (r.q) r.q.value = flt.Q.value;
    r.show();
  });
  $('eqBtn').classList.toggle('on', eqView.enabled);
  $('eqBtn').textContent = eqView.enabled ? 'enabled' : 'bypassed';
  drawEq();
}
buildEq();
syncVelUi();

wireMenu();

// ------------------------------------------------------------ simple view --
// By default only the photo, the keyboard with its notes, and a few knobs;
// Settings shows every control. Remembered in this browser.
const knobs = [['gain', 'Volume'], ['rMix', 'Room'], ['bc', 'Resonance'], ['cmix', 'Body']]
  .map(([id, label]) => knob($(id), label, $(id + 'V')));
for (const k of knobs) $('knobs').appendChild(k.el);
setInterval(() => { if (document.body.classList.contains('simple')) for (const k of knobs) k.sync(); }, 250);
const VIEW = 'modelled.view';
function setView(full, remember = true) {
  document.body.classList.toggle('simple', !full);
  $('viewBtn').setAttribute('aria-pressed', String(full));
  if (remember) { try { localStorage.setItem(VIEW, full ? 'full' : 'simple'); } catch { /* not kept */ } }
  // What was hidden was drawn at no width: draw it again now it has one.
  if (full) { editor.sync(); velVolEditor.draw(); velHardEditor.draw(); drawEq(); }
}
$('viewBtn').onclick = () => setView(document.body.classList.contains('simple'));
{
  let full = false;
  try { full = localStorage.getItem(VIEW) === 'full'; } catch { /* default */ }
  setView(full, false);
}
tipify();
// Restore the last session, else the shipped defaults. The editor's old
// offsets-only key is dropped, not migrated: what it held has been folded into
// the shipped curves.
localStorage.removeItem(LEGACY_OFFSETS);
{
  let stored = null;
  try { stored = JSON.parse(localStorage.getItem(STORE)); } catch { stored = null; }
  // Nothing saved (fresh browser, or after a reset). A clone, so applying the
  // defaults cannot mutate the constant.
  if (!stored) stored = structuredClone(DEFAULT_SETTINGS);
  try { applySettings(stored); } catch (err) { console.error('stored settings ignored', err); }
}
uiReady = true;
