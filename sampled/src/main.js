// Main thread: load the library, build the instrument, wire the controls.
import { Library } from './library.js';
import { Curves, createEditor, PARAMS, noteName, LOW, HIGH } from './curves.js';
import { Engine, loadWorklets } from './engine.js';
import * as irStore from './ir-store.js';
import { buildKeyboard } from './keyboard.js';
import { levelDb, pickLayer, nativeAt, nearestLayer, createVelCurveEditor, createVelLayerEditor } from './velocity.js';
import { Envelopes } from './envelopes.js';
import { createBezierEditor, SHAPES } from './bezier.js';
import { BANDS } from './eq.js';
import { createResCurveEditor, distanceDb } from './resonance.js';
import { DEFAULT_SETTINGS } from './defaults.js';
import { tipify } from './tips.js';
import { createStage } from './stage.js';
import { knob } from './knobs.js';

const $ = (id) => document.getElementById(id);
const STORE = 'piano-sampled-curves';
// The audio buffer size, as an AudioContext latencyHint. A context cannot
// change it once made, so picking another one saves it and reloads.
const LATENCY = 'piano-sampled-latency';
const latencyHint = () => {
  let v = null;
  try { v = localStorage.getItem(LATENCY); } catch { /* private window */ }
  if (!v) return 'interactive';
  return /^[0-9.]+$/.test(v) ? +v : v;
};

let ctx = null, lib = null, engine = null, kb = null;
let selNote = 60;
const curves = new Curves();
const envelopes = new Envelopes();
let envEditors = [];
let uiReady = false;              // true once buildUI has created every control
let stored = null;               // the parsed localStorage state, applied in two passes
let velCurveEditor = null;       // the hand-drawn velocity volume curve editor
let velLayerEditor = null;       // the velocity -> layer curve editor
let resCurveEditor = null;       // the per-key resonance level curve editor
let lastVel = null, lastVelAt = 0;  // the most recent strike, for the curve's marker
const down = new Set(), silent = new Set();
// midi -> { layer, vel, at, held }: what the Sample map lights up. `layer` is
// the recording that ACTUALLY sounded, which the library may have substituted
// for a neighbour while the wanted one was still downloading.
const layerHits = new Map();

// ------------------------------------------------------------------ start --
async function start(install = false) {
  $('startBtn').disabled = true;
  $('installChk').disabled = true;
  $('uninstallBtn').disabled = true;
  $('startBtn').textContent = 'loading…';
  ctx = new AudioContext({ latencyHint: latencyHint(), sampleRate: 48000 });
  await ctx.resume();
  keepRunning(ctx);

  lib = new Library(ctx, './samples');
  try { await lib.loadManifest(); }
  catch (e) {
    $('startBtn').disabled = false;
    $('installChk').disabled = false;
    $('uninstallBtn').disabled = false;
    $('startBtn').textContent = 'Start audio';
    $('loadMsg').innerHTML = `<b style="color:#e08a6a">${e.message}</b><br>
      Run <code>node sampled/tools/fetch.mjs</code> then <code>node sampled/tools/build.mjs</code>.`;
    return;
  }
  lib.onprogress = updateLoad;
  // The note samples stream: a worker holds them as Opus and decodes each one
  // as it plays, into an AudioWorklet voice. See stream.js.
  await lib.startStreaming();
  lib.streamer.onerror = (msg) => {
    lastStreamError = msg;
    $('installV').textContent = msg;
    // Without Opus decoding there is no piano at all, so say so out loud.
    if (/cannot decode/.test(msg)) alert(`Piano Model X: ${msg}`);
  };
  // Ticked on the start screen: install first, and bring the player up only
  // once every sample is on disk -- so it never runs from memory meanwhile.
  if (install) await runInstall();

  await loadWorklets(ctx);
  engine = new Engine(ctx, lib, curves, envelopes);
  restore();
  buildUI();
  buildKnobs();
  restoreControls();       // second pass: sliders, EQ bands and toggles

  // Enough to play with before the rest arrives: the mezzo-forte layer, from
  // the middle of the keyboard outwards.
  lib.startWarm(LOW, HIGH);
  // Handles for the console and for sampled/tools/browser-test.mjs. Everything
  // the UI can do is a method on one of these.
  window.piano = { ctx, lib, engine, curves, envelopes, noteOn, noteOff, setPedal, setSoloRes, toggleSilent, pickLayer, levelDb, ui: true };
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

/**
 * The context can stop underneath the page: the OS suspends audio across a
 * sleep, and some browsers 'interrupt' it for a call or an output device that
 * went away. Nothing else here would ever notice -- the piano would just go
 * silent until a reload. So ask for it back whenever it drops, and again on
 * the next thing the player does, because a browser may only allow resume()
 * from a gesture. Nothing in this page suspends the context on purpose.
 */
let wakeAudio = () => {};
function keepRunning(c) {
  wakeAudio = () => {
    if (c.state === 'running' || c.state === 'closed') return;
    c.resume().catch(() => { /* not allowed yet: the next gesture tries again */ });
  };
  c.addEventListener('statechange', () => {
    if (c.state === 'running' || c.state === 'closed') return;
    console.warn(`sampled: audio context ${c.state}, resuming`);
    wakeAudio();
  });
  for (const ev of ['pointerdown', 'keydown', 'touchend']) addEventListener(ev, () => wakeAudio(), { capture: true, passive: true });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) wakeAudio(); });
  addEventListener('focus', () => wakeAudio());
}

/** The simple view's knobs, each standing in for a slider in the full view. */
function buildKnobs() {
  const root = $('knobs');
  for (const [id, label] of [['gain', 'Volume'], ['dry', 'Direct'], ['fdnWet', 'Room'], ['wet', 'Hall'], ['resAll', 'Resonance']]) {
    const k = knob($(id), label, $(id + 'V'));
    root.appendChild(k.el);
    knobs.push(k);
  }
}

/**
 * Simple view (the picture, the keyboard, a few knobs) or the full one with
 * every control. Remembered in this browser.
 */
const VIEW = 'sampled.view';
function setView(full, remember = true) {
  document.body.classList.toggle('simple', !full);
  $('viewBtn').setAttribute('aria-pressed', String(full));
  if (remember) { try { localStorage.setItem(VIEW, full ? 'full' : 'simple'); } catch { /* not kept */ } }
  // What was hidden was drawn at no width: draw it again now it has one.
  if (full && window.piano?.ui) redrawAll();
}
function redrawAll() {
  editor?.refresh();
  velCurveEditor?.draw(); velLayerEditor?.draw(); resCurveEditor?.draw();
  redrawEnvs(); drawEq(); renderNote();
}
$('viewBtn').onclick = () => setView(document.body.classList.contains('simple'));
try { setView(localStorage.getItem(VIEW) === 'full', false); } catch { setView(false, false); }

// ------------------------------------------------------------- note events --
function noteOn(midi, vel) {
  if (!engine || midi < LOW || midi > HIGH) return;
  const v = engine.noteOn(midi, vel);
  if (v) layerHits.set(midi, { layer: v.layer, vel, at: performance.now(), held: true });
  stage?.noteOn(midi);
  lastVel = vel; lastVelAt = performance.now();
  down.add(midi); paint(midi); editor?.playing();
}
function noteOff(midi, vel = 64) {
  if (!engine) return;
  engine.noteOff(midi, vel);
  const hit = layerHits.get(midi);
  if (hit) { hit.held = false; hit.at = performance.now(); }
  stage?.noteOff(midi);
  down.delete(midi); paint(midi); editor?.playing();
}
/** Everything off, and the keyboard drawn to match. */
function panic() {
  if (!engine) return;
  engine.panic(); down.clear(); silent.clear(); stage?.clear();
  for (let m = LOW; m <= HIGH; m++) paint(m);
  editor?.playing();
}
function toggleSilent(midi) {
  silent.has(midi) ? silent.delete(midi) : silent.add(midi);
  engine.silentHold(midi, silent.has(midi));
  paint(midi);
}
const paint = (m) => kb?.paint(m, {
  down: down.has(m), silent: silent.has(m), selected: m === selNote,
  resonating: resRinging.has(m),
});
/**
 * What the resonance engine is doing, on a keyboard: which strings are
 * answering and how loudly, over which dampers are off.
 */
// The curve editor behind the map shows the same levels, so it only needs
// repainting while something is ringing (plus once more when it stops).
let resCurveLive = false;
function paintResMap() {
  const live = engine ? engine.res.level.some((e) => e > 0) : false;
  if (live || resCurveLive) { resCurveEditor?.draw(); resCurveLive = live; }
  const c = $('resMap');
  if (!c || !engine || !c.offsetParent) return;      // hidden in the simple view
  const g = c.getContext('2d');
  const w = c.width = c.clientWidth * devicePixelRatio;
  const h = c.height, bw = w / 88, lab = 12 * devicePixelRatio;
  const plot = h - lab;
  g.fillStyle = '#0d1119'; g.fillRect(0, 0, w, h);

  const res = engine.res;
  const undamped = engine.undamped ?? new Set();
  for (let m = LOW; m <= HIGH; m++) {
    const x = (m - LOW) * bw;
    const black = ![0, 2, 4, 5, 7, 9, 11].includes(m % 12);
    // A damper off is the pedal's actual job, so it is the background.
    g.fillStyle = undamped.has(m) ? (black ? '#171d2a' : '#1e2637') : (black ? '#090c11' : '#10151f');
    g.fillRect(x, 0, Math.max(1, bw - 0.5), plot);
  }

  // Level per string, on a 48 dB scale.
  for (let i = 0; i < res.n; i++) {
    const e = res.level[i];
    if (e <= 0) continue;
    const midi = res.lo + i;
    const bar = Math.max(0, Math.min(1, 1 + 20 * Math.log10(e) / 48)) * (plot - 2);
    g.fillStyle = '#d8c4a2';
    g.fillRect((midi - LOW) * bw + 0.5, plot - bar, Math.max(1, bw - 1), bar);
  }

  g.fillStyle = 'rgba(141,161,190,0.45)';
  for (const m of down) g.fillRect((m - LOW) * bw, 0, Math.max(1.5, bw), plot);

  g.font = `${9 * devicePixelRatio}px ui-monospace,monospace`;
  g.textAlign = 'center';
  g.fillStyle = '#4f5c76';
  for (let m = 24; m <= HIGH; m += 12) g.fillText(noteName(m), (m - LOW) * bw + bw / 2, h - 2);
}

/**
 * The whole library as a grid -- 88 keys across, 16 velocity layers up -- with
 * the recording that each played note reached for lit as it sounds.
 *
 * It answers the one question the velocity chart cannot: not what a velocity
 * WOULD do to the selected note, but which of the sixteen recordings is
 * actually playing, on the key you actually hit. A cell is brighter when its
 * sample is resident, so the streaming warm-up is visible here too.
 */
function paintLayerMap() {
  const c = $('layerMap');
  if (!c || !engine || !lib || !c.offsetParent) return;
  const g = c.getContext('2d');
  const w = c.width = c.clientWidth * devicePixelRatio, h = c.height;
  const lab = 12 * devicePixelRatio, plot = h - lab;
  const cols = HIGH - LOW + 1, bw = w / cols;
  const layers = lib.layers, rows = layers.length, rh = plot / rows;
  g.fillStyle = '#0d1119'; g.fillRect(0, 0, w, h);

  // The library, layer by layer: loudest at the top, softest at the bottom.
  for (let ci = 0; ci < cols; ci++) {
    const m = LOW + ci;
    const n = lib.note(m);
    if (!n) continue;
    const x = ci * bw;
    const black = ![0, 2, 4, 5, 7, 9, 11].includes(m % 12);
    for (let r = 0; r < rows; r++) {
      const layer = layers[r];
      if (!n.layers?.[layer]) continue;
      const y = (rows - 1 - r) * rh;
      const resident = lib.has(lib.key(m, layer));
      g.fillStyle = resident ? (black ? '#1b2231' : '#222b3e') : (black ? '#10151f' : '#151b28');
      g.fillRect(x + 0.5, y + 0.5, Math.max(1, bw - 1), Math.max(1, rh - 1));
    }
  }

  // What is sounding, fading after the key comes up.
  const now = performance.now(), FADE = 900;
  for (const [m, hit] of layerHits) {
    const a = hit.held ? 1 : Math.max(0, 1 - (now - hit.at) / FADE);
    if (a <= 0) { layerHits.delete(m); continue; }
    const r = layers.indexOf(hit.layer);
    if (r < 0 || m < LOW || m > HIGH) continue;
    const x = (m - LOW) * bw, y = (rows - 1 - r) * rh;
    g.fillStyle = `rgba(111,168,220,${0.14 * a})`;   // the key, full height
    g.fillRect(x, 0, Math.max(1, bw), plot);
    g.fillStyle = `rgba(217,164,65,${0.9 * a})`;      // the recording that sounded
    g.fillRect(x + 0.5, y + 0.5, Math.max(1, bw - 1), Math.max(1, rh - 1));
  }

  g.font = `${9 * devicePixelRatio}px ui-monospace,monospace`;
  g.fillStyle = '#4f5c76'; g.textAlign = 'left';
  g.fillText('ff', 2 * devicePixelRatio, 8 * devicePixelRatio);
  g.fillText('pp', 2 * devicePixelRatio, plot - 2 * devicePixelRatio);
  g.textAlign = 'center';
  for (let m = 24; m <= HIGH; m += 12) g.fillText(noteName(m), (m - LOW) * bw + bw / 2, h - 2);
}

let resRinging = new Set();
function paintResonance() {
  const last = resRinging;
  resRinging = engine.res.ringing();
  for (const m of last) if (!resRinging.has(m)) paint(m);
  for (const m of resRinging) if (!last.has(m)) paint(m);
  paintResMap();
  paintLayerMap();
  if (performance.now() - lastVelAt < 900) { velCurveEditor?.draw(); velLayerEditor?.draw(); }   // the strike marker fades
  stage?.tick();
  for (const k of knobs) k.sync();
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
  velCurveEditor?.draw();   // its layer bands follow the selected key's bias
  velLayerEditor?.draw();
  redrawEnvs();          // the hold curve's ghost is the SELECTED note's decay
}
const redrawEnvs = () => { for (const e of envEditors) e.draw(); const n = $('hoNote'); if (n) n.textContent = noteName(selNote); };

// -------------------------------------------------------------------- MIDI --
async function initMidi() {
  if (!navigator.requestMIDIAccess) { $('midiSel').innerHTML = '<option>Web MIDI unsupported (use Chrome/Edge)</option>'; return; }
  let access;
  try { access = await navigator.requestMIDIAccess(); }
  catch { $('midiSel').innerHTML = '<option>MIDI permission denied</option>'; return; }
  const refresh = (e) => {
    const inputs = [...access.inputs.values()];
    $('midiSel').innerHTML = inputs.length
      ? inputs.map((i, k) => `<option value="${k}">${i.name}</option>`).join('')
      : '<option>no MIDI device</option>';
    inputs.forEach((i) => { i.onmidimessage = (m) => onMidi(m, i.id); });
    if (e?.port?.type === 'input' && e.port.state === 'disconnected') unplugged(e.port.id);
  };
  access.onstatechange = refresh;
  refresh();
}
// What each MIDI input is holding down, so a keyboard that is unplugged -- or
// drops off the USB bus mid-phrase -- does not leave its notes and its pedal
// stuck on: the note-offs it would have sent are never coming.
const midiHeld = new Map();       // input id -> { notes: Set, pedal }
function heldBy(id) {
  let h = midiHeld.get(id);
  if (!h) midiHeld.set(id, h = { notes: new Set(), pedal: 0 });
  return h;
}
function unplugged(id) {
  const h = midiHeld.get(id);
  if (!h) return;
  midiHeld.delete(id);
  for (const m of h.notes) noteOff(m);
  if (h.pedal > 0) setPedal(0);
}
function onMidi(e, id) {
  const [st, d1, d2] = e.data;
  const cmd = st & 0xf0;
  const h = heldBy(id);
  wakeAudio();
  if (cmd === 0x90 && d2 > 0) { h.notes.add(d1); noteOn(d1, d2); }
  else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) { h.notes.delete(d1); noteOff(d1, d2 || 64); }
  else if (cmd === 0xb0) {
    // Continuous, not a switch: a half-pedalled CC 64 is a real technique and
    // most controllers send the whole range.
    if (d1 === 64) { h.pedal = d2 / 127; setPedal(h.pedal); }
    // All sound off, all notes off: what a DAW or a controller's panic button
    // sends. Reset all controllers lets the pedal up.
    if (d1 === 120 || d1 === 123) { for (const x of midiHeld.values()) { x.notes.clear(); x.pedal = 0; } panic(); }
    if (d1 === 121) { h.pedal = 0; setPedal(0); }
  }
}

// ------------------------------------------------------------------ pedals --
function setPedal(v) {
  if (!engine) return;
  engine.setPedal(v);
  $('pedalBtn').classList.toggle('on', v >= 0.5);
  $('pedalBtn').textContent = v < 0.02 ? 'sustain' : v >= 0.98 ? 'sustain ▮▮▮' : `sustain ${(v * 100) | 0}%`;
  $('ped').value = v;
}
/** Mute everything but the resonance. */
function setSoloRes(on) {
  engine.setSoloRes(on);
  $('resSoloBtn').classList.toggle('on', on);
  $('resSoloBtn').textContent = on ? 'solo ▮' : 'solo';
}


// -------------------------------------------------------- computer keyboard --
const MAP = { z: 0, s: 1, x: 2, d: 3, c: 4, v: 5, g: 6, b: 7, h: 8, n: 9, j: 10, m: 11,
  q: 12, 2: 13, w: 14, 3: 15, e: 16, r: 17, 5: 18, t: 19, 6: 20, y: 21, 7: 22, u: 23 };
let octave = 4;
addEventListener('keydown', (e) => {
  if (e.repeat || e.metaKey || e.ctrlKey || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
  if (e.key === ' ') { e.preventDefault(); spaceHeld = true; setPedal(1); return; }
  if (e.key === ',') { octave = Math.max(0, octave - 1); return; }
  if (e.key === '.') { octave = Math.min(7, octave + 1); return; }
  const key = e.key.toLowerCase(), k = MAP[key];
  if (k !== undefined) {
    e.preventDefault();
    const m = 12 * octave + 12 + k;
    typed.set(key, m);
    noteOn(m, 96);
  }
});
// Which note each typed key started, so letting go stops that note even if
// the octave moved in between -- recomputing it at keyup left the first one
// stuck on.
const typed = new Map();
let spaceHeld = false;
addEventListener('keyup', (e) => {
  if (e.key === ' ') { spaceHeld = false; setPedal(0); return; }
  const key = e.key.toLowerCase(), m = typed.get(key);
  if (m === undefined) return;
  typed.delete(key);
  noteOff(m);
});
// A window that loses focus with keys down never sees their keyups.
addEventListener('blur', () => {
  for (const m of typed.values()) noteOff(m);
  typed.clear();
  if (spaceHeld) { spaceHeld = false; setPedal(0); }
});

// ---------------------------------------------------------------------- UI --
let editor = null;
let stage = null;
const knobs = [];
function buildUI() {
  stage = createStage($('stage'), {
    lo: LOW, hi: HIGH,
    res: () => engine?.res,
  });
  kb = buildKeyboard($('kbInner'), {
    lo: LOW, hi: HIGH,
    onDown: noteOn, onUp: (m) => noteOff(m), onSelect: select, onSilent: toggleSilent,
  });
  for (let m = LOW; m <= HIGH; m++) paint(m);
  // Narrower than the whole keyboard (a phone): start on the middle of it.
  const kbEl = $('kb');
  kbEl.scrollLeft = (kbEl.scrollWidth - kbEl.clientWidth) / 2;

  editor = createEditor($('editor'), curves, () => {
    engine.refreshStrips();
    renderNote();
    save();
  }, () => selNote, () => down);
  tipify($('editor'));

  bezierRow('na', envelopes.noteAttack);
  bezierRow('nr', envelopes.noteRelease, { falling: true });
  bezierRow('ra', envelopes.relAttack);
  bezierRow('rr', envelopes.relRelease, { falling: true });
  bezierRow('rf', envelopes.resAttack);
  bezierRow('rl', envelopes.resRelease, { falling: true });
  bezierRow('ho', envelopes.hold, { ghost: () => envelopes.ghostFor(lib.note(selNote)) });
  buildEq();

  velLayerEditor = createVelLayerEditor($('velLayerCanvas'), engine.velLayer, {
    markVel: () => (performance.now() - lastVelAt < 900 ? lastVel : null),
    onChange: () => { save(); renderNote(); },
  });
  velCurveEditor = createVelCurveEditor($('velCurveCanvas'), engine.velCurve, {
    layers: lib.layers, hivel: lib.m.hivel,
    bias: () => Math.round(curves.at('layerBias', selNote)),
    markVel: () => (performance.now() - lastVelAt < 900 ? lastVel : null),
    onChange: () => { save(); renderNote(); },
  });
  // Per-key resonance level. Redrawn with the resonance map (paintResMap) so
  // the ringing strings behind it move in real time.
  resCurveEditor = createResCurveEditor($('resCurveCanvas'), engine.res.keyCurve, {
    topDamped: engine.topDamped,
    energy: (m) => engine.res.level[m - engine.res.lo] ?? 0,
    onChange: () => { engine.res.refreshKeyCurve(); syncResCurve(); save(); },
  });
  $('resCurveResetBtn').onclick = () => {
    engine.res.keyCurve.reset(); engine.res.refreshKeyCurve();
    resCurveEditor.draw(); syncResCurve(); save();
  };
  syncResCurve();

  const syncVelCurveBtn = () => {
    $('velCurveBtn').classList.toggle('on', engine.velCurve.enabled);
    $('velCurveBtn').textContent = engine.velCurve.enabled
      ? 'on — hand-drawn volume curve' : 'off — native layer levels';
  };
  $('velCurveBtn').onclick = () => {
    engine.velCurve.enabled = !engine.velCurve.enabled;
    syncVelCurveBtn(); velCurveEditor.draw(); renderNote(); save();
  };
  syncVelCurveBtn();

  const bind = (id, fn, fmt) => {
    const el = $(id), out = $(id + 'V');
    // Every slider persists on change. save() is a no-op until the UI is built,
    // so the initial run() during buildUI does not write a half-populated set.
    const run = () => { const v = +el.value; fn(v); if (out) out.textContent = fmt ? fmt(v) : v.toFixed(2); save(); };
    el.oninput = run; run();
  };
  const db = (v) => {
    const d = 20 * Math.log10(Math.max(v, 1e-4));
    return v <= 0 ? 'off' : `${d >= 0 ? '+' : ''}${d.toFixed(1)} dB`;
  };

  bind('gain', (v) => { engine.master.gain.value = v; }, db);
  bind('spread', (v) => { engine.spread = v; engine.refreshStrips(); },
    (v) => v === 0 ? 'off' : v > 0 ? `+${v.toFixed(2)} wider` : `${v.toFixed(2)} mirrored`);
  bind('width', (v) => { engine.width = v; engine.refreshStrips(); }, (v) => v.toFixed(2) + '×');
  bind('dry', (v) => { engine.dry.gain.value = v; }, (v) => v === 0 ? 'off — reverbs only' : db(v));
  // Each room's own send expander, and its meter: level as the bar, the
  // expander's pull as the red part from the right, reported every 50 ms.
  for (const [pfx, r] of [['aExp', engine.hall], ['bExp', engine.early]]) {
    bind(pfx + 'Ratio', (v) => engine.setSendExpander(r, { ratio: v }), (v) => v <= 1 ? 'off' : `${v.toFixed(2)}:1`);
    bind(pfx + 'Thr', (v) => engine.setSendExpander(r, { threshold: v }), (v) => v.toFixed(1) + ' dB');
    bind(pfx + 'Att', (v) => engine.setSendExpander(r, { attack: v }), (v) => v.toFixed(1) + ' ms');
    bind(pfx + 'Rel', (v) => engine.setSendExpander(r, { release: v }), (v) => v.toFixed(0) + ' ms');
    r.exp.port.onmessage = (e) => {
      const { levelDb, reductionDb } = e.data;
      // Nothing on the send is not "fully pulled down": draw an empty meter.
      const silent = levelDb < -70;
      const lvl = silent ? 0 : Math.max(0, Math.min(1, (levelDb + 70) / 70));
      const gr = silent ? 0 : Math.max(0, Math.min(1, -reductionDb / 40));
      $(pfx + 'Level').style.width = `${(lvl * 100).toFixed(1)}%`;
      $(pfx + 'Gr').style.width = `${(gr * 100).toFixed(1)}%`;
      $(pfx + 'GrV').textContent = silent ? 'silent'
        : `${levelDb.toFixed(0)} dB, −${(-reductionDb).toFixed(1)} dB`;
    };
  }
  bind('wet', (v) => { engine.wet.gain.value = v; linkToggles(); }, db);
  // Bass and treble read out in seconds, which move with the reverb time.
  const hallRtReadouts = () => {
    const rt = engine.hallOpts.rt60;
    for (const [id, f] of [['hallBass', '125 Hz'], ['hallTreble', '8 kHz']]) {
      const v = +$(id).value;
      $(id + 'V').textContent = `${(v * rt).toFixed(2)} s @ ${f}`;
    }
  };
  bind('rt60', (v) => { engine.setHall({ rt60: v }); hallRtReadouts(); }, (v) => v.toFixed(2) + ' s mids');
  bind('hallBass', (v) => engine.setHall({ bass: v }),
    (v) => `${(v * engine.hallOpts.rt60).toFixed(2)} s @ 125 Hz`);
  bind('hallTreble', (v) => engine.setHall({ treble: v }),
    (v) => `${(v * engine.hallOpts.rt60).toFixed(2)} s @ 8 kHz`);
  bind('hallPre', (v) => engine.setHall({ predelayMs: v }), (v) => v.toFixed(1) + ' ms');
  bind('hallBuild', (v) => engine.setHall({ buildMs: v }), (v) => v.toFixed(0) + ' ms');
  bind('fdnWet', (v) => { engine.early.wet.gain.value = v; linkToggles(); }, db);
  bind('fdnEr', (v) => engine.setFdnRoom({ erLevel: v }), (v) => v.toFixed(2) + '×');
  bind('fdnTail', (v) => engine.setFdnRoom({ tailLevel: v }), (v) => v.toFixed(2) + '×');
  bind('fdnW', (v) => engine.setFdnRoom({ width: v }), (v) => v.toFixed(1) + ' m');
  bind('fdnD', (v) => engine.setFdnRoom({ depth: v }), (v) => v.toFixed(1) + ' m');
  bind('fdnH', (v) => engine.setFdnRoom({ height: v }), (v) => v.toFixed(1) + ' m');
  bind('fdnAbs', (v) => engine.setFdnRoom({ absorption: v }));
  bind('fdnPre', (v) => engine.setFdnRoom({ predelayMs: v }), (v) => v.toFixed(1) + ' ms');
  bind('fdnDamp', (v) => engine.setFdnRoom({ tailDampHz: v }), (v) => (v / 1000).toFixed(1) + ' kHz');
  bind('fdnPos', (v) => engine.setFdnRoom({ distance: v }), (v) => (v * 100).toFixed(0) + '% back');
  const sec = (v) => v.toFixed(2) + ' s';
  bind('symAmt', (v) => { engine.res.symAmount = v; }, db);
  bind('resAll', (v) => { engine.res.amount = v; linkToggles(); }, db);
  bind('resSel', (v) => { engine.res.build(v); }, (v) => v.toFixed(1) + '× bandwidth');
  // What a dB-per-doubling rate comes to at 1 semitone, an octave, two octaves.
  const reach = (v) => [1, 12, 24].map((d) => distanceDb(d, v).toFixed(0)).join(' / ') + ' dB';
  bind('resProx', (v) => engine.res.setProximity(v),
    (v) => v === 0 ? 'no preference'
      : `${Math.abs(v).toFixed(1)} dB/doubling toward ${v > 0 ? 'near' : 'distant'} (${reach(v)})`);
  bind('symRel', (v) => { engine.res.symRelease = v; }, sec);
  bind('symPedalUp', (v) => { engine.res.pedalUpRelease = v; }, sec);
  bind('sbLevel', (v) => { engine.res.sbAmount = v; }, db);
  bind('sbFalloff', (v) => { engine.res.sbFalloff = v; }, (v) => v === 0 ? 'flat' : `${v.toFixed(1)} dB/doubling (${reach(v)})`);
  bind('sbStep', (v) => { engine.res.sbStep = v; },
    (v) => v === 1 ? 'every string' : v === 12 ? 'octaves only' : `every ${v}${v === 2 ? 'nd' : v === 3 ? 'rd' : 'th'}`);
  bind('sbRel', (v) => { engine.res.sbRelease = v; }, sec);
  bind('selfAmt', (v) => { engine.res.selfAmount = v; }, db);
  bind('selfRel', (v) => { engine.res.selfRelease = v; }, sec);
  bind('resTone', (v) => engine.res.setTone(v), (v) => (v / 1000).toFixed(1) + ' kHz');
  bind('resMax', (v) => { engine.res.maxVoices = v; }, (v) => v.toFixed(0) + ' voices');
  bind('resXfade', (v) => { engine.res.crossfade = v; }, sec);
  bind('resResume', (v) => { engine.res.resumeDb = v; }, (v) => v.toFixed(0) + ' dB');
  bind('resStart', (v) => { engine.res.startAt = v; }, (v) => v.toFixed(2) + ' s in');
  bind('resBloom', (v) => { engine.res.bloom = v; }, (v) => v === 0 ? 'none' : (v * 1000).toFixed(0) + ' ms');
  bind('relNoise', (v) => { engine.releaseNoise = v; }, db);
  bind('dampNoise', (v) => { engine.damperNoise = v; }, db);
  bind('cutDb', (v) => { engine.cutDb = v; }, (v) => v <= -100 ? 'off' : v.toFixed(0) + ' dB');
  bind('pedSweep', (v) => { engine.pedalSweep = v / 1000; }, (v) => v === 0 ? 'all at once' : `bass ${v.toFixed(0)} ms after treble`);
  bind('pedDampCount', (v) => { engine.pedalDamperCount = v; }, (v) => v === 0 ? 'none' : `loudest ${v.toFixed(0)}`);
  bind('pedDampLevel', (v) => { engine.pedalDamperLevel = v; }, (v) => v === 0 ? 'off' : `${(20 * Math.log10(v)).toFixed(1)} dB of a key release`);
  bind('relTrim', (v) => { engine.relStartTrim = v; }, (v) => v.toFixed(0) + ' ms');
  bind('relRR', (v) => { engine.relRoundRobin = v; }, (v) => '±' + v.toFixed(0) + ' ms');
  bind('relDelay', (v) => { engine.releaseDelay = v; }, (v) => v.toFixed(0) + ' ms');
  bind('ped', setPedal, (v) => (v * 100).toFixed(0) + '%');

  const envMs = (id, env) => bind(id, (v) => { env.ms = v; save(); }, (v) => v.toFixed(0) + ' ms');
  envMs('naMs', envelopes.noteAttack);
  envMs('raMs', envelopes.relAttack);
  envMs('rrMs', envelopes.relRelease);
  bind('hoSec', (v) => { envelopes.hold.seconds = v; redrawEnvs(); save(); }, (v) => v.toFixed(1) + ' s held');
  bind('hoFloor', (v) => { envelopes.hold.floorDb = v; redrawEnvs(); save(); }, (v) => v.toFixed(0) + ' dB');
  bind('hoKey', (v) => { envelopes.hold.keyNoiseFollow = v; save(); }, (v) => (v * 100).toFixed(0) + '%');

  const syncAlign = () => {
    $('alignBtn').classList.toggle('on', engine.alignStarts);
    $('alignBtn').textContent = engine.alignStarts ? 'on' : 'off — as recorded';
    $('alignV').textContent = engine.alignStarts ? `${engine.alignMs.toFixed(1)} ms in` : '';
  };
  $('alignBtn').onclick = () => { engine.alignStarts = !engine.alignStarts; syncAlign(); save(); };
  syncAlign();

  $('limBtn').onclick = () => {
    engine.setLimiter(!engine.limiterOn);
    $('limBtn').classList.toggle('on', engine.limiterOn);
    $('limBtn').textContent = engine.limiterOn ? 'on' : 'off (watch your ears)';
    save();
  };
  const syncRooms = () => {
    for (const [id, r] of [['roomBtn', engine.hall], ['fdnBtn', engine.early]]) {
      $(id).classList.toggle('on', r.on);
      $(id).textContent = r.on ? 'on' : 'off';
    }
  };
  $('roomBtn').onclick = () => { engine.setHallOn(!engine.hall.on); syncRooms(); save(); };
  $('fdnBtn').onclick = () => { engine.setEarlyOn(!engine.early.on); syncRooms(); save(); };
  syncRooms();

  // The hall's impulse: synthetic, or a captured IR the player loads. The file
  // is kept in IndexedDB (it is far too big for localStorage), so it comes
  // back on reload; it is not part of an exported settings file.
  const syncHallIr = (name) => {
    $('hallIrBtn').classList.toggle('on', !!name);
    $('hallIrBtn').textContent = name ? `${name} — click for synthetic` : 'synthetic — load an IR file…';
  };
  const useHallIr = async (name, bytes) => {
    const buf = await ctx.decodeAudioData(bytes.slice(0));
    engine.setHallIR(buf);
    syncHallIr(name);
    $('hallIrBtn').nextElementSibling.textContent =
      `${buf.numberOfChannels === 1 ? 'mono' : buf.numberOfChannels + ' ch'}, ${buf.duration.toFixed(1)} s`;
  };
  $('hallIrBtn').onclick = () => {
    if (engine.hallFile) {
      engine.setHallIR(null); syncHallIr(null);
      $('hallIrBtn').nextElementSibling.textContent = '';
      irStore.clear().catch(() => {});
    } else $('hallIrFile').click();
  };
  $('hallIrFile').onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const bytes = await f.arrayBuffer();
    try {
      await useHallIr(f.name, bytes);
      irStore.put(f.name, bytes).catch(() => {});
    } catch (err) { alert(`Could not decode ${f.name}: ${err.message}`); }
  };
  syncHallIr(null);
  irStore.get().then((ir) => ir && useHallIr(ir.name, ir.bytes)).catch(() => {});
  $('partialsBtn').onclick = () => {
    engine.res.setPartialsOnly(!engine.res.partialsOnly);
    $('partialsBtn').classList.toggle('on', engine.res.partialsOnly);
    $('partialsBtn').textContent = engine.res.partialsOnly ? 'on' : 'off';
    save();
  };
  $('invBtn').onclick = () => {
    engine.invert = !engine.invert;
    $('invBtn').classList.toggle('on', engine.invert);
    $('invBtn').textContent = engine.invert ? 'on' : 'off';
    engine.refreshStrips();
    save();
  };
  $('persBtn').onclick = () => {
    engine.perspective *= -1;
    $('persBtn').textContent = engine.perspective > 0 ? "player's view" : 'audience view';
    engine.refreshStrips();
    save();
  };
  $('resBtn').onclick = () => {
    engine.res.enabled = !engine.res.enabled;
    $('resBtn').classList.toggle('on', engine.res.enabled);
    $('resBtn').textContent = engine.res.enabled ? 'on' : 'off';
    // Soloing the resonance and then switching it off leaves the instrument
    // silent for no visible reason, so switching it off drops the solo too.
    if (!engine.res.enabled) setSoloRes(false);
    save();
  };
  // Solo is a monitoring switch, not a setting -- it is deliberately absent
  // from collectSettings(), so it never survives a reload or an export.
  $('resSoloBtn').onclick = () => setSoloRes(!engine.soloRes);
  $('pedalBtn').onclick = () => setPedal(engine.pedal >= 0.5 ? 0 : 1);
  $('panicBtn').onclick = panic;
  $('latencySel').value = String(latencyHint());
  $('latencySel').onchange = (e) => {
    try { localStorage.setItem(LATENCY, e.target.value); } catch { /* not kept */ }
    save();
    location.reload();
  };

  // Double-click any slider to put it back to its shipped default (the value
  // baked into the markup). Dispatching `input` runs whatever that slider is
  // bound to, so the engine and the readout follow. This includes the parameter
  // editor's per-key sliders, whose default is 0 -- a zero offset for whatever
  // scope is selected, which is exactly "back to default" for that control.
  document.addEventListener('dblclick', (e) => {
    const el = e.target;
    if (el instanceof HTMLInputElement && el.type === 'range') {
      el.value = el.defaultValue;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });

  wireMenu();
  renderNote();
  uiReady = true;          // from here, save() writes the full state
}

// The WHOLE state -- curves, envelopes, every slider, the EQ bands, the
// toggles -- not just the three that used to be kept. Guarded until the UI
// exists, because collectSettings reads the sliders out of the DOM and a save
// fired mid-build would store a half-populated set.
const save = () => { if (uiReady) localStorage.setItem(STORE, JSON.stringify(collectSettings())); };
/**
 * The simple view's Room, Hall and Resonance knobs each own their section's
 * switch: turned all the way down is off, anything above it is on. Clicking
 * the switch only when it disagrees keeps its label, class and engine in step.
 */
function linkToggles() {
  if (!uiReady) return;          // the switches are wired after the sliders
  for (const [id, btn, on] of [
    ['wet', 'roomBtn', engine.hall.on],
    ['fdnWet', 'fdnBtn', engine.early.on],
    ['resAll', 'resBtn', engine.res.enabled],
  ]) if ((+$(id).value > 0) !== on) $(btn).click();
}
/** The resonance curve's readout: flat, or how far down it pulls the top. */
function syncResCurve() {
  const out = $('resCurveV');
  if (!out || !engine) return;
  const rc = engine.res.keyCurve;
  if (rc.idle) { out.textContent = 'flat'; return; }
  let lo = 0, at = rc.lo;
  for (let m = rc.lo; m <= rc.hi; m++) { const d = rc.at(m); if (d < lo) { lo = d; at = m; } }
  out.textContent = lo < 0 ? `${lo.toFixed(1)} dB at ${noteName(at)}` : 'drawn';
}

// ------------------------------------------------------------------- EQ ----
const EQ_FREQS = (() => { const f = new Float32Array(160); for (let i = 0; i < 160; i++) f[i] = 20 * Math.pow(1000, i / 159); return f; })();

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
  const resp = engine.eq.response(EQ_FREQS);
  g.strokeStyle = engine.eq.enabled ? '#d8c4a2' : '#323b4c';
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
    save();
  };
  drawEq();
}

// Restore has two passes, because half the state belongs to things that exist
// before the UI and half to the sliders that do not exist until after it. This
// first pass is the engine-level part -- the curves and envelope shapes the UI
// is built to reflect. restoreControls() is the second, after buildUI.
function restore() {
  try { stored = JSON.parse(localStorage.getItem(STORE)); } catch { stored = null; }
  // Nothing saved yet (fresh browser, or after a reset): start from the shipped
  // defaults rather than the bare constructor values. A deep clone, so applying
  // it cannot mutate the shared constant.
  if (!stored) stored = structuredClone(DEFAULT_SETTINGS);
  if (!stored) return;
  curves.fromJSON(stored.curves);
  envelopes.fromJSON(stored.envelopes);
  if (stored.velCurve) engine.velCurve.fromJSON(stored.velCurve);
  if (stored.velLayer) engine.velLayer.fromJSON(stored.velLayer);
  if (stored.resCurve) { engine.res.keyCurve.fromJSON(stored.resCurve); engine.res.refreshKeyCurve(); }
  if (stored.eq) engine.eq.fromJSON(stored.eq);   // legacy files kept EQ here
}

/** Second restore pass: sliders, EQ bands and toggles, once they exist. */
function restoreControls() { if (stored) applyControls(stored); }

// ------------------------------------------------------- import / export ----
//
// The whole tweakable state as one JSON file: the per-key curves and the
// envelope shapes (which localStorage already keeps), plus every slider and
// every toggle, which until now lived only in the DOM. Applying it just drives
// the same events a human would -- set a slider, dispatch `input`, click a
// toggle if it disagrees -- so there is exactly one code path that moves the
// instrument and the file cannot get at anything the UI cannot.
function collectSettings() {
  const sliders = {};
  for (const el of document.querySelectorAll('input[type=range][id]')) sliders[el.id] = el.value;
  // The sustain pedal is a momentary performance control, not a setting: it must
  // not survive a reload (or an export/import), or the instrument comes up with
  // the pedal already down. So it is never persisted.
  delete sliders.ped;
  const eqBands = [...document.querySelectorAll('#eqBands .eqband')].map((row) => ({
    f: row.querySelector('.f')?.value, g: row.querySelector('.g')?.value, q: row.querySelector('.q')?.value,
  }));
  return {
    app: 'piano-sampled', version: 1, saved: new Date().toISOString(),
    curves: curves.toJSON(), envelopes: envelopes.toJSON(),
    velCurve: engine.velCurve.toJSON(), velLayer: engine.velLayer.toJSON(),
    resCurve: engine.res.keyCurve.toJSON(),
    sliders, eqBands,
    toggles: {
      limiter: engine.limiterOn, eq: engine.eq.enabled,
      res: engine.res.enabled, perspective: engine.perspective, invert: engine.invert,
      partialsOnly: engine.res.partialsOnly,
      align: engine.alignStarts,
      // Keys from when these were rooms A and B; kept so older files load.
      roomA: engine.hall.on, roomB: engine.early.on,
    },
  };
}

function applySettings(o) {
  if (!o || typeof o !== 'object' || (o.app && o.app !== 'piano-sampled')) {
    throw new Error('not a Piano Model X — Sampled settings file');
  }
  if (o.curves) curves.fromJSON(o.curves);
  if (o.envelopes) envelopes.fromJSON(o.envelopes);
  if (o.velCurve) engine.velCurve.fromJSON(o.velCurve);
  if (o.velLayer) engine.velLayer.fromJSON(o.velLayer);
  // A file from before this curve existed has none: flatten, so importing an
  // old settings file does not silently keep a curve it knows nothing about.
  engine.res.keyCurve.reset();
  if (o.resCurve) engine.res.keyCurve.fromJSON(o.resCurve);
  engine.res.refreshKeyCurve();
  if (o.eq) engine.eq.fromJSON(o.eq);   // legacy files
  applyControls(o);
  save();
}

/** Apply the DOM-side state -- sliders, EQ bands, toggles -- and redraw. */
function applyControls(o) {
  // Sliders and EQ bands are applied by dispatching the same `input` event a
  // drag would, so each one's bound handler moves the engine and the readout.
  // The send expander used to be one, shared by both rooms (expRatio...);
  // a file from then gives both rooms its settings.
  if (o.sliders) for (const k of ['Ratio', 'Thr', 'Att', 'Rel']) {
    const v = o.sliders['exp' + k];
    if (v == null) continue;
    o.sliders['aExp' + k] ??= v; o.sliders['bExp' + k] ??= v;
    delete o.sliders['exp' + k];
  }
  if (o.sliders) for (const [id, val] of Object.entries(o.sliders)) {
    if (id === 'ped') continue;   // momentary; see collectSettings -- never restore it
    const el = $(id);
    if (el) { el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); }
  }
  if (o.eqBands) {
    const rows = [...document.querySelectorAll('#eqBands .eqband')];
    o.eqBands.forEach((b, i) => {
      const row = rows[i];
      if (!row) return;
      for (const [cls, v] of [['.f', b.f], ['.g', b.g], ['.q', b.q]]) {
        const el = row.querySelector(cls);
        if (el && v != null) { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }
      }
    });
  }
  // Toggles: click the button only if it currently disagrees, so its own
  // handler keeps the label, the class and the engine in step.
  const t = o.toggles ?? {};
  if (t.limiter != null && engine.limiterOn !== t.limiter) $('limBtn').click();
  if (t.eq != null && engine.eq.enabled !== t.eq) $('eqBtn').click();
  if (t.res != null && engine.res.enabled !== t.res) $('resBtn').click();
  if (t.align != null && engine.alignStarts !== t.align) $('alignBtn').click();
  if (t.roomA != null && engine.hall.on !== t.roomA) $('roomBtn').click();
  if (t.roomB != null && engine.early.on !== t.roomB) $('fdnBtn').click();
  if (t.perspective != null && engine.perspective !== t.perspective) $('persBtn').click();
  if (t.invert != null && engine.invert !== t.invert) $('invBtn').click();
  if (t.partialsOnly != null && engine.res.partialsOnly !== t.partialsOnly) $('partialsBtn').click();
  // A saved switch that disagrees with its knob (files from before they were
  // linked): the knob wins, since it is what the simple view shows.
  linkToggles();
  // Redraw the things that read from state rather than from a slider event.
  editor?.refresh(); redrawEnvs(); for (const e of envEditors) e.draw();
  const b = $('velCurveBtn');
  if (b) {
    b.classList.toggle('on', engine.velCurve.enabled);
    b.textContent = engine.velCurve.enabled ? 'on — hand-drawn curve' : 'off — using per-key dynamic/gamma';
  }
  velCurveEditor?.draw();
  velLayerEditor?.draw();
  resCurveEditor?.draw(); syncResCurve();
  drawEq(); renderNote(); engine.refreshStrips();
}

function download(name, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function wireMenu() {
  const menu = $('menu');
  $('menuBtn').onclick = (e) => { e.stopPropagation(); menu.classList.toggle('open'); };
  // A click on the latency picker must not close the menu, or its list
  // vanishes before an option can be picked.
  document.addEventListener('click', (e) => { if (!e.target.closest('.menu-row')) menu.classList.remove('open'); });
  $('exportBtn').onclick = () =>
    download(`piano-sampled-${new Date().toISOString().slice(0, 10)}.json`,
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

/**
 * Wire one Bezier editor: the canvas, its preset buttons, and any sliders.
 *
 * The presets are starting points rather than choices -- they set the handles
 * and then you move them. A preset that could not be adjusted would be back to
 * having a fixed shape and only a time knob, which is the thing these replace.
 */
function bezierRow(id, env, { ghost = null, note = null, falling = false } = {}) {
  const canvas = $(id + 'Canvas');
  const ed = createBezierEditor(canvas, env.shape, () => { save(); }, { ghost, falling });
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
  g.fillStyle = '#0d1119'; g.fillRect(0, 0, w, h);
  const bias = Math.round(curves.at('layerBias', selNote));
  const layers = lib.layers, lmin = layers[0], lmax = layers[layers.length - 1];
  const vc = engine?.velCurve, vl = engine?.velLayer;
  // The continuous layer position for a velocity (curve + per-key bias), and
  // the level: the hand-drawn volume curve when it is on, else the interpolated
  // native layer level -- exactly what the engine plays.
  const layerAt = (v) => Math.max(lmin, Math.min(lmax, (vl ? vl.at(v) : pickLayer(v, lib.m.hivel, layers, 0)) + bias));
  const baseDb = (v) => (vc?.enabled ? vc.at(v) : nativeAt(rel, layers, layerAt(v)));
  // the layer each velocity reaches for, as a background band
  for (let v = 1; v <= 127; v++) {
    const l = nearestLayer(layers, layerAt(v));
    g.fillStyle = l % 2 ? '#121722' : '#151b28';
    g.fillRect((v - 1) / 127 * w, 0, w / 127 + 1, h);
  }
  g.strokeStyle = '#222c40';
  for (let d = 0; d >= -48; d -= 12) {
    const y = (-d / 48) * h;
    g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
  }
  g.strokeStyle = '#d8c4a2'; g.lineWidth = 2 * devicePixelRatio; g.beginPath();
  for (let v = 1; v <= 127; v++) {
    const y = Math.min(h, (-(baseDb(v) + curves.at('trim', selNote)) / 48) * h);
    v === 1 ? g.moveTo(0, y) : g.lineTo((v - 1) / 127 * w, y);
  }
  g.stroke();
  const rows = [1, 16, 32, 48, 64, 80, 96, 112, 127].map((v) => {
    const l = nearestLayer(layers, layerAt(v));
    const target = baseDb(v) + curves.at('trim', selNote);
    const already = rel[l] ?? 0;
    return `<tr><td>vel ${String(v).padStart(3)}</td><td>layer ${String(l).padStart(2)}</td>
      <td>${target.toFixed(1)} dB</td><td>${(target - already >= 0 ? '+' : '')}${(target - already).toFixed(1)} on it</td></tr>`;
  }).join('');
  $('velTable').innerHTML = `<tr><td colspan="4" style="color:var(--dim)">what each velocity does on ${noteName(selNote)}:
    which recording, the level asked for, and the trim applied to that recording to get there</td></tr>${rows}`;

  $('velHint').textContent = `${noteName(selNote)} — ${vc?.enabled ? 'hand-drawn volume curve' : 'native layer levels'}, layers spanning ${(-Math.min(...Object.values(rel))).toFixed(1)} dB${bias ? `, layer bias ${bias > 0 ? '+' : ''}${bias}` : ''}. Bands are which of the ${lib.layers.length} recordings each velocity plays.`;
}

function updateLoad() {
  if (!lib) return;
  const total = lib.layers.length * 88;
  $('statLoad').textContent = `${lib.loaded}/${total}`;
  $('statKeys').textContent = `${lib.keysReady()}/88`;
  $('statMem').textContent = `${(lib.bytes / 1048576).toFixed(0)} MB`;
  $('loadBar').style.width = `${Math.min(100, lib.loaded / total * 100)}%`;
  const s = lib.streamer;
  if (s) {
    if (!/cannot|stopped/.test($('installV').textContent)) {
      $('installV').textContent = `${s.installed}/${total} on disk${s.underruns ? ` · ${s.underruns} underruns` : ''}`;
    }
  }
}

/**
 * The install, full screen, before anything plays.
 *
 * Resolves when every sample is on disk, or when the player chooses to skip
 * the rest (what is done stays done, and the rest plays from memory).
 */
let lastStreamError = '';
function runInstall() {
  const s = lib.streamer, total = lib.noteTotal;
  $('startView').hidden = true;
  $('installView').hidden = false;
  lastStreamError = '';
  lib.install();
  return new Promise((resolve) => {
    let seen = false, t0 = 0, n0 = 0;
    const finish = () => { clearInterval(timer); resolve(); };
    const fmt = (sec) => sec < 60 ? `${Math.max(1, Math.round(sec))} s` : `${Math.round(sec / 60)} min`;
    const tick = () => {
      const done = Math.min(total, s.installed);
      $('instFill').style.width = `${(done / total * 100).toFixed(1)}%`;
      if (done >= total) { $('instStat').textContent = 'done'; finish(); return; }
      if (s.installing && !seen) { seen = true; t0 = performance.now(); n0 = done; }
      const stopped = (seen && !s.installing) || (!s.installing && lastStreamError);
      if (stopped) {
        $('instStat').textContent = `${done} of ${total} samples on disk. `
          + (lastStreamError || `${total - done} could not be installed.`);
        $('instRetry').hidden = false;
        $('instSkip').textContent = 'Play without finishing';
        return;
      }
      let eta = '';
      const el = (performance.now() - t0) / 1000;
      if (seen && el > 3 && done > n0) eta = ` · about ${fmt((total - done) / ((done - n0) / el))} left`;
      $('instStat').textContent = `${done} of ${total} samples · ${(done / total * 100).toFixed(0)}%${eta}`;
    };
    const timer = setInterval(tick, 250);
    tick();
    $('instSkip').onclick = () => { s.stopInstall(); finish(); };
    $('instRetry').onclick = () => {
      seen = false; lastStreamError = '';
      $('instRetry').hidden = true; $('instSkip').textContent = 'Skip and play now';
      lib.install();
    };
  });
}

const startFailed = (e) => {
  $('startView').hidden = false; $('installView').hidden = true;
  $('loadMsg').innerHTML = `<b style="color:#e08a6a">${e.message}</b>`;
  $('startBtn').disabled = false; $('startBtn').textContent = 'Start audio';
  $('installChk').disabled = false; $('uninstallBtn').disabled = false;
};
// The box is only honoured while it is showing: hidden means already
// installed, or nowhere to put it.
$('startBtn').onclick = () => start(!$('installOffer').hidden && $('installChk').checked).catch(startFailed);

/**
 * The disk install, on the start screen: a box (ticked by default) while it is
 * not complete, and an uninstall button while anything is on disk. What is on
 * disk is read straight from the install's own files (stream-worker.js keeps
 * them), so this is right even after the browser has cleared site data.
 */
async function pcmDirs() {
  const root = await navigator.storage.getDirectory();
  const out = [];
  for await (const [name, h] of root.entries()) {
    if (name.startsWith('piano-pcm-') && h.kind === 'directory') out.push([name, h]);
  }
  return { root, dirs: out };
}

async function offerInstall() {
  const offer = $('installOffer'), un = $('uninstallBtn');
  let total = 0, done = 0, bytes = 0;
  try {
    const m = await (await fetch('./samples/manifest.json')).json();
    for (const n of Object.values(m.notes)) total += Object.keys(n.layers).length;
  } catch { offer.hidden = true; return; }
  try {
    for (const [, dir] of (await pcmDirs()).dirs) {
      const f = await dir.getFileHandle('installed.json').catch(() => null);
      if (f) done = Math.max(done, JSON.parse(await (await f.getFile()).text()).length);
      for await (const [, h] of dir.entries()) if (h.kind === 'file') bytes += (await h.getFile()).size;
    }
  } catch { offer.hidden = true; un.hidden = true; return; }   // no OPFS: nothing to offer

  const gb = (b) => (b / 1e9).toFixed(1);
  un.hidden = bytes === 0;
  un.textContent = `Uninstall samples from disk (${gb(bytes)} GB)`;

  if (done >= total) { offer.hidden = true; return; }
  // Room for the rest? The whole install is 16-bit stereo at 48 kHz: ~2.6 GB.
  const full = 2.6e9, need = full * (1 - done / total) + 0.2e9;
  try {
    const { quota = Infinity, usage = 0 } = await navigator.storage.estimate();
    if (quota - usage < need) { offer.hidden = true; return; }
  } catch { /* no estimate: offer anyway */ }
  $('installLbl').textContent = done > 0
    ? `Finish downloading samples (${gb(need)} GB more)`
    : `Download samples for smoother playing (${gb(full)} GB)`;
  offer.hidden = false;
}

$('uninstallBtn').onclick = async () => {
  if (!confirm('Remove the piano samples from this browser\'s storage?\n\nNotes will be decoded while you play instead, until you install again.')) return;
  const un = $('uninstallBtn');
  un.disabled = true; un.textContent = 'uninstalling…';
  try {
    const { root, dirs } = await pcmDirs();
    for (const [name] of dirs) await root.removeEntry(name, { recursive: true });
  } catch (e) {
    alert(`Could not uninstall: ${e.message}\n\nIf the piano is open in another tab, close it and try again.`);
  }
  un.disabled = false;
  await offerInstall();
};
tipify();
offerInstall().finally(() => $('startView').classList.remove('checking'));
