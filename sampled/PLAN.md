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

## The performance test (`sampled/tools/perf.mjs`, `npm run sampled:perf`)

A ramp. After load (every key and every head in) it climbs 20 levels, each
a chord struck repeatedly for 1.6 s plus 0.6 s of tails, geometric in both
size and speed: level 1 = 1 key every 800 ms ... level 20 = 21 keys every
35 ms. Two ladders: without pedal, and with the pedal held for the level.

- A level FAILS if it loses >= 10 ms of audio or a stream underruns, twice
  running (a failed level is replayed once; passing the replay = "flaky").
- A ladder stops after 3 failed levels, so a bad build finishes in ~30 s.
- **SCORE = last level before the first failure. The goal is to raise it.**
- Per level it prints lost ms, drops (steps >= 3 ms), underruns, peak live
  sample voices (every running StreamSource, fading included) vs the
  engine's own count, and median noteOn cost.
- `--setup "js"` runs code in the page first (`engine`, `piano` in scope)
  for A/B experiments; `--json file` saves the rows.

Dropout probe: an AudioWorklet computes `lag = Date.now() -
currentFrame/sampleRate*1000` each render callback and keeps the minimum per
50 ms window (raw lag saw-tooths 3-6 ms because callbacks come in bursts --
a first version without the window counted that as hundreds of false
drops). A render that falls behind never catches up, so a step up of the
windowed minimum = audio lost. Validated standalone: idle 0 ms; CPU hog 2.5
ms per 2.67 ms quantum -> ~120 ms lost per s. Chrome 141 headless has no
`playbackStats` / `renderCapacity`, even with experimental flags.

**Noise:** even at 2-4 voices with resonance off there are sporadic 10-33
ms spikes (hence the replay rule). Run it 2-3 times and compare medians.

### Baseline scores (this container, 4 cores)

| build | no pedal | pedal | notes |
|---|---|---|---|
| as shipped (6bbdb55) | 0-1 | 0 | pedal level 1 (1 key / 800 ms) loses 235-874 ms with 44-94 live voices; no-pedal level 4 (2 keys / 488 ms) 92 live voices, 721 ms lost |
| `--setup "engine.res.enabled = false"` | 6-12 | 7-9 | fails around 18-50 live note voices |

The older scenario version of the test (commit 6bbdb55) gave, as shipped:
~3.8-4.1 s lost per 4 s burst of chords/runs, 240-300 live voices while
the engine counted ~60; with soundboard off about half; with resonance off
~0.5 s total. Those findings still stand:

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

Workflow for every performance change: `npm run sampled:perf -- --json
before.json` (2-3 runs), make the change, same again, compare the median
SCORE of each ladder and the live-voice counts. `npm run sampled:test` must
stay green.

### Step 1 -- find the per-voice cost (no code change to the piano)
A micro-ramp in the same style (a `perf.mjs --micro` mode, <30 s): start N
silent sample voices of one chain type, raise N (10, 20, 40, 80, 160...)
until the probe fails; the N reached is that chain's capacity. Chains:
  a. AudioWorkletNode (piano-voice) alone
  b. + 3 gains (note chain)
  c. + 2 high-pass + 1 low-pass biquad, static frequency (resonance chain)
  d. c with a live `setTargetAtTime` on the filter frequencies
This decides whether the fix is "fewer worklet nodes" or "no automated
biquads". Record the capacities here.

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

### Step 1b -- the sporadic spikes at low load
10-33 ms lost with 2-4 voices and resonance off, not every time. Suspects:
garbage collection on the audio thread (the worklet scope holds ~80 MB of
heads and receives many messages), AudioWorkletNode creation/teardown per
note (graph changes take a lock the audio thread waits on), the main-thread
40 ms UI/resonance ticker. Try: `window.piano.ui = false`; many notes with
no new nodes (reuse); count spikes vs node creations per second.

### Lower priority
- `SharedArrayBuffer` ring buffers for streaming (needs COOP/COEP headers
  on the host). GC is not the bottleneck now; revisit after step 2.
- Remaining underruns right after load (`sampled:stress`: ~1 in 6 loads,
  in pedalled gestures).
