# Sampled piano: continuing plan (stability + performance)

Branch: `claude/sampled-piano-stability-steks6`. Read this first after a
context reset.

## Ground rules from the user

- **Do not change the UI or the sound without discussing it first.** If a
  change can affect what is heard, say how (when, how loud, how often) and
  ask before committing it. Bug fixes that restore intended audio (e.g. a
  silent tail) are fine but must be called out.
- **Fix tests before refactoring.** A refactor starts from a green suite.
- **Tests must be fast.** Slow ones go in a separate, opt-in set.
- Measure every performance change with `npm run sampled:perf`, before and
  after, on the same machine (`--json before.json` / `--json after.json`).

## What is done (commits 085b0b5, adb7ec4, and the perf test)

Streaming: end-of-file decoder flush (silent 50-70 ms tails), decoder
recovery sample-exact, block buffers recycled worker <-> worklet, struck-note
streams prioritised over resonance streams / downloads / head decoding
(`pressed()` in stream-worker.js), early 20 ms first block for playing
voices. Page: AudioContext auto-resume, MIDI unplug releases notes/pedal,
CC 120/121/123, computer-keyboard stuck notes.

Tests:

| command | time | what |
|---|---|---|
| `npm run sampled:test` | ~40 s | unit.mjs (Node, <1 s: alignment, ranges, hold law, resonance decisions) + selftest + smoke.mjs (one page load: notes, pedal, 22 streams no underrun, killed decoders sample-identical) |
| `npm run sampled:test:full` | ~90 s | the above + browser-test.mjs (detailed real-time audio checks) |
| `npm run sampled:perf` | ~50 s | performance: dropouts under load (below) |
| `npm run sampled:stress` | ~25 s/load | underruns when playing straight after start |

All green at adb7ec4. `sampled:verify` needs ffmpeg (not in this container).

## The performance test (`sampled/tools/perf.mjs`)

Loads the page, waits for every key and every head, then per scenario:
idle 3 s; a 10-key chord struck 20x at ~7/s without pedal; the same with
pedal; a 3-octave run at 25 notes/s with pedal; one key 40x at 20/s. Each
followed by 1 s of tails.

Dropouts are measured by a probe AudioWorklet: `lag = Date.now() -
currentFrame/sampleRate*1000` per render callback. A render that falls
behind never catches up, so the rise of the lag floor = audio lost. Validated
with a deliberate CPU hog (3 ms per 2.67 ms quantum -> ~130 ms lost per s;
0-2 ms -> ~1-2 ms noise). Chrome 141 headless has no `playbackStats` /
`renderCapacity`, even with experimental flags.

Also reported: stream underruns, peak voices as the engine counts them,
**peak live sample voices** (every running StreamSource, fading included),
noteOn main-thread cost, long tasks. `--setup "js"` runs code in the page
first for A/B experiments (`engine`, `piano` in scope).

### Baseline (this container, 4 cores, adb7ec4 + perf.mjs)

| scenario | lost ms | live voices | engine count |
|---|---|---|---|
| idle | 5-45 | 0 | 0 + 0 |
| 10-key chord x20, no pedal | ~3800 | 240 | 10 + 59 |
| 10-key chord x20, pedal | ~3950 | 301 | 75 + 45 |
| fast run 25/s, pedal | ~4100 | 245 | 64 + 50 |
| one key x40 at 20/s | 500-1900 | 84 | 1 + 16 |

Same, `--setup "engine.res.sbAmount = 0"` (no soundboard): 1676 / 1936 /
2318 / 12 ms lost, live 85 / 127 / 101 / 8.
Same, `--setup "engine.res.enabled = false"`: 138 / 210 / 56 / 11 ms lost,
live 35 / 85 / 67 / 6.

Noise between runs is large (x1.5); compare totals and several runs.

## What the numbers say

1. **Resonance is ~90% of the audio-thread load.** Without it the piano
   loses ~0.5 s total; with it ~13 s.
2. **Fading voices pile up.** The engine counts ~60 resonance voices but up
   to 300 sample voices are running: every note-off lets its resonance
   voices go with a 1.2-3 s fade (`tick()` -> `release(..., symRelease /
   sbRelease)`), and the next strike 150 ms later starts new ones instead of
   taking the fading ones back. `maxVoices` counts only `this.voices`, never
   `this.fading`.
3. **The resonance cap is bypassed**: `resumeFreed()` (resonance.js ~566)
   puts voices back with `this.voices.set` without `makeRoom()`, so 59
   voices against a cap of 32.
4. **A resonance voice costs far more than a note voice**: 85 live note
   voices lose ~0.2 s, 127 live resonance-heavy voices ~1.9 s. A resonance
   voice is AudioWorkletNode + 2 high-pass + 1 low-pass biquad + 2 gains; a
   note voice is AudioWorkletNode + 3 gains. Suspect: biquads whose
   frequency has automation (`setTargetAtTime` in `setPartialFilter`,
   `setTone`) compute coefficients per sample, and `setTargetAtTime` never
   formally ends.
5. Soundboard (`sb`) resonance alone is about half the load: one chord
   starts ~50 sb voices (every string near each key, pedal or not).

## Next steps, in order

### Step 1 -- find the per-voice cost (no code change to the piano)
A micro-benchmark page (or a `perf.mjs --micro` mode): N silent voices of
each chain type, N = 25/50/100/200, measure lost ms:
  a. AudioWorkletNode (piano-voice) alone
  b. + 3 gains (note chain)
  c. + 2 HP + LP static frequency (resonance chain)
  d. same with a live `setTargetAtTime` on the filter frequency
This decides whether the fix is "fewer worklet nodes" or "no automated
biquads". Keep it fast (<30 s). Record results here.

### Step 2 -- no-sound-change optimisations (can go ahead, then report)
Depending on step 1:
- If automated biquads dominate: after a `setTargetAtTime` settles, pin the
  value with `cancelScheduledValues` + `setValueAtTime` (the value it has
  reached), so the filter goes back to k-rate coefficients. Audibly
  identical (the approach is complete to <0.1%). Verify with an A/B render
  (below).
- If worklet node count dominates: the pooled voice renderer -- one
  AudioWorkletNode per KEY (88, created once, each feeding that key's strip
  exactly as today) that mixes every sample voice on that string, with the
  per-voice gains, fades and biquads computed inside. Routing stays
  identical. Biggest refactor; needs the A/B render test first. Consider
  an intermediate step: keep per-voice nodes but move resonance voices'
  HP/HP/LP/lvl/rel into the voice worklet (1 node instead of 6).
- Disconnect finished voices' native nodes explicitly on `onended` (they
  are left for GC today).

### Step 3 -- sound-affecting fixes: DISCUSS WITH THE USER FIRST
Present each with its perf gain and what changes audibly:
- **Enforce the resonance cap in `resumeFreed()`** (a bug; changes which
  strings ring in dense pedalling).
- **Revive a fading voice for the same string on a re-strike** instead of
  starting a new one (physically what a string does; fewer voices; the
  string no longer re-blooms from silence on each strike).
- **Count fading voices toward `maxVoices`**, stealing the quietest fading
  one first (with a short fade).
- **Limit soundboard voices** (e.g. nearest N strings, or its own cap).
- Note voices can exceed MAX_VOICES (75 vs 64) because `prune()` skips held
  keys -- probably fine, mention it.

### A/B render test (needed before step 2's refactors)
Engine methods take a `when`, so a gesture can be scheduled sample-exactly.
Build `sampled/tools/ab.mjs`: schedule a fixed gesture (chords, pedal,
releases; no pedal-up jitter -- `PEDAL_JITTER` uses Math.random, stub it),
record engine output through the recorder worklet, compare against a
recording from a git worktree of the previous commit (worklets cannot be
swapped by request routing; workers can). Report max difference in dB
below the signal. Keep it < 30 s if possible; otherwise slow set.

### Lower priority
- `SharedArrayBuffer` ring buffers for streaming (needs COOP/COEP headers
  on the host). GC is not the bottleneck now; revisit after step 2.
- Remaining underruns right after load (`sampled:stress`: ~1 in 6 loads,
  in pedalled gestures).
