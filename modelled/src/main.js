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

const $ = (id) => document.getElementById(id);
const LOW = 21, HIGH = 108;

let ctx = null, node = null, model = null, quality = 16;
let unisonCoupling = 0.55, bridgeCoupling = 0.30;
let selNote = 60, selString = 1;
const down = new Set(), silent = new Set();
// Declared here because the keyboard is built before the editor exists.
let editor = null;

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
  node = new AudioWorkletNode(ctx, 'piano-processor', {
    numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
    processorOptions: { quality, unisonCoupling, bridgeCoupling },
  });
  node.port.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'ready') $('statStrings').textContent = m.strings;
    if (m.type === 'stats') {
      $('statActive').textContent = m.active;
      $('statLoad').textContent = (m.load * 100).toFixed(0) + '%';
    }
  };
  node.connect(ctx.destination);
  post({ type: 'gain', value: +$('gain').value });
  if (!edits.empty) post({ type: 'offsets', state: edits.toJSON() });
  $('overlay').style.display = 'none';
}
const post = (m) => node && node.port.postMessage(m);

// ------------------------------------------------------------ note events --
function noteOn(midi, vel) {
  if (midi < LOW || midi > HIGH) return;
  down.add(midi); paintKey(midi);
  post({ type: 'noteOn', midi, velocity: vel });
}
function noteOff(midi) {
  down.delete(midi); paintKey(midi);
  post({ type: 'noteOff', midi });
}
function toggleSilent(midi) {
  const on = !silent.has(midi);
  on ? silent.add(midi) : silent.delete(midi);
  post({ type: 'silentHold', midi, on });
  paintKey(midi);
}

// -------------------------------------------------------------- keyboard ---
const WHITE = [0, 2, 4, 5, 7, 9, 11];
const isBlack = (m) => !WHITE.includes(m % 12);
const keyEl = new Map();

function buildKeyboard() {
  const inner = $('kbInner');
  inner.innerHTML = '';
  const W = 15;
  let x = 0;
  const xs = new Map();
  for (let m = LOW; m <= HIGH; m++) {
    if (!isBlack(m)) { xs.set(m, x); x += W; }
  }
  inner.style.width = x + 'px';
  for (let m = LOW; m <= HIGH; m++) {
    const el = document.createElement('div');
    if (isBlack(m)) {
      el.className = 'bk';
      el.style.left = (xs.get(m + 1) - W * 0.3) + 'px';
      el.style.width = W * 0.6 + 'px';
    } else {
      el.className = 'wk';
      el.style.left = xs.get(m) + 'px';
      el.style.width = (W - 1) + 'px';
      if (m % 12 === 0) el.innerHTML = `<span>${noteName(m)}</span>`;
    }
    el.onmousedown = (ev) => {
      ev.preventDefault();
      if (ev.shiftKey) { toggleSilent(m); return; }
      selectNote(m);
      noteOn(m, 0.45 + 0.5 * (1 - ev.offsetY / el.offsetHeight));
    };
    el.onmouseup = () => down.has(m) && noteOff(m);
    el.onmouseleave = () => down.has(m) && noteOff(m);
    keyEl.set(m, el);
    inner.appendChild(el);
  }
}
function paintKey(m) {
  const el = keyEl.get(m); if (!el) return;
  el.classList.toggle('dn', down.has(m) || silent.has(m));
  el.classList.toggle('sel', m === selNote);
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
    <tr><td>damper</td><td>${n.hasDamper ? 'yes' : 'none (bass)'}</td></tr>`;

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

/** Recompile every string of a note and ship the coefficients to the audio thread. */
function pushNote(midi) {
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
  renderInspector();
}

function bindNoteGeometry(id, apply, fmt) {
  $(id).addEventListener('input', (e) => {
    const n = model.notes[selNote - LOW];
    apply(n, +e.target.value);
    $(id + 'V').textContent = fmt(+e.target.value);
    pushNote(selNote);
  });
}
function bindString(id, key, fmt) {
  $(id).addEventListener('input', (e) => {
    model.notes[selNote - LOW].strings[selString][key] = +e.target.value;
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
$('panicBtn').onclick = () => { down.clear(); silent.clear(); post({ type: 'panic' }); for (let m = LOW; m <= HIGH; m++) paintKey(m); };

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
$('bodyBtn').onclick = (e) => {
  const on = !e.target.classList.contains('on');
  e.target.classList.toggle('on', on);
  e.target.textContent = on ? 'enabled' : 'bypassed';
  post({ type: 'body', enabled: on });
};

$('gain').addEventListener('input', (e) => { $('gainV').textContent = (+e.target.value).toFixed(2); post({ type: 'gain', value: +e.target.value }); });
const pushCoupling = () => post({ type: 'coupling', unison: unisonCoupling, bridge: bridgeCoupling });
$('uc').addEventListener('input', (e) => { unisonCoupling = +e.target.value; $('ucV').textContent = unisonCoupling.toFixed(2); });
$('uc').addEventListener('change', pushCoupling);
$('bc').addEventListener('input', (e) => { bridgeCoupling = +e.target.value; $('bcV').textContent = bridgeCoupling.toFixed(2); });
$('bc').addEventListener('change', pushCoupling);

bindNoteGeometry('len', (n, v) => (n.spec.lengthM = v), (v) => (v * 1000).toFixed(0) + ' mm');
bindNoteGeometry('core', (n, v) => (n.spec.coreDiameterMm = v), (v) => v.toFixed(3) + ' mm');
bindNoteGeometry('wrap', (n, v) => { n.spec.wrapOuterDiameterMm = v; n.spec.wound = v > n.spec.coreDiameterMm; }, (v) => (v ? v.toFixed(2) + ' mm' : 'none'));
bindString('det', 'detuneCents', (v) => v.toFixed(2) + ' ¢');
bindString('t60l', 't60Low', (v) => v.toFixed(1) + ' s');
bindString('t60h', 't60High', (v) => v.toFixed(2) + ' s');
bindString('strike', 'strikePosition', (v) => '1/' + (1 / v).toFixed(1));
bindString('cpl', 'coupling', (v) => v.toFixed(2) + '×');
$('gainV').textContent = (+$('gain').value).toFixed(2);
$('ucV').textContent = unisonCoupling.toFixed(2);
$('bcV').textContent = bridgeCoupling.toFixed(2);


// -------------------------------------------------------- parameter editor -
// The offsets live on the main thread and are posted to the audio thread as
// plain JSON. Nothing here designs a filter: Piano.setOffsets does that, on
// the audio side, and skips the expensive half when no parameter that is baked
// into a loop filter has moved.
const STORE = 'pianoModelX.offsets';
const edits = new Offsets();

const pushOffsets = (state) => {
  post({ type: 'offsets', state });
  const n = Object.keys(state.global).length + Object.keys(state.keys).length;
  $('peCount').textContent = n;
};

editor = createEditor($('peRoot'), {
  offsets: edits,
  onChange: pushOffsets,
  selectedNote: () => selNote,
});

$('peSave').onclick = () => {
  localStorage.setItem(STORE, JSON.stringify(edits.toJSON()));
  $('peSave').textContent = 'saved';
  setTimeout(() => ($('peSave').textContent = 'save'), 900);
};
$('peLoad').onclick = () => {
  const raw = localStorage.getItem(STORE);
  if (!raw) return;
  edits.load(JSON.parse(raw));
  editor.sync(); pushOffsets(edits.toJSON());
};
$('peResetAll').onclick = () => {
  edits.load({});
  editor.sync(); pushOffsets(edits.toJSON());
};
$('peExport').onclick = () => {
  const blob = new Blob([JSON.stringify(edits.toJSON(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'piano-offsets.json';
  a.click();
  URL.revokeObjectURL(a.href);
};
$('peImport').onclick = () => {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'application/json';
  inp.onchange = async () => {
    const f = inp.files[0];
    if (!f) return;
    try {
      edits.load(JSON.parse(await f.text()));
      editor.sync(); pushOffsets(edits.toJSON());
    } catch (err) { console.error('offsets import failed', err); }
  };
  inp.click();
};

// A saved set is applied as soon as audio starts, so a session picks up where
// the last one stopped rather than starting from the shipped curves.
const savedOffsets = localStorage.getItem(STORE);
if (savedOffsets) {
  try { edits.load(JSON.parse(savedOffsets)); editor.sync(); } catch { /* ignore a bad store */ }
}


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
};
