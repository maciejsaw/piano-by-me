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
| `npm run sampled:perf -- --micro` | ~3 min | capacity per voice chain |
| `npm run sampled:ab [-- REF]` | ~60 s | raw voices bit-identical to REF (default HEAD)? |

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

### Step 1 -- per-voice cost: DONE (`npm run sampled:perf -- --micro`)
N silent voices of one chain, N x1.5 per step until the probe fails
(twice running). Capacities in this container (3 runs, noisy):

| chain | capacity | |
|---|---|---|
| empty AudioWorkletNode (no-op, for scale) | 140-210 | Chrome's fixed per-node cost |
| voice worklet alone | 62 (58-90 after the loop rewrite, 58-67 before) | |
| + 3 gains (note chain) | 41-62 | gains are nearly free |
| + 2 HP + 1 LP biquad, fixed (resonance chain) | 27-41 | biquads ~ double a voice |
| same, frequencies moving (setTargetAtTime) | 8-27 | only while moving: Chrome treats a converged target as constant |
| resonance chain stopped, filters left connected | ~0 | Chrome idles them; disconnecting gains nothing |

Conclusions: a voice's cost is ~1/3 Chrome's per-AudioWorkletNode
overhead, ~2/3 the biquads + our JS. No single no-sound-change lever is
big. **The ladder fails on voice COUNT** -- one key repeated every 800 ms,
no pedal, runs 18-41 sample voices while the engine counts 1 note + 8
resonance, because every strike starts fresh resonance voices while the
last strike's are still fading (1.2-3 s). Lowering `maxVoices` to 16 does
not move the score (fading voices are outside the cap); `sbAmount = 0`
raises no-pedal from 1 to 6, pedal stays 0.

### Step 2 -- no-sound-change optimisations
- DONE: voice worklet inner loop. At rate 1 from a whole-sample position
  (every struck note unless detuned) the head / blocks are copied in runs
  instead of read() per sample; the fade is a separate pass. Verified
  bit-identical by `npm run sampled:ab` (25 voices covering every path).
- DONE: `sampled/tools/ab.mjs` (`npm run sampled:ab [-- REF]`, ~60 s, slow
  set): raw voices recorded with the working tree and with REF's
  sampled/src (served from `git show`, so worklets are covered), compared
  sample by sample. Catches a 1e-6 gain change (-176 dB). It checks the
  voice/stream only, not the engine graph (the engine's timing and
  Math.random make whole-engine renders non-deterministic).
- DROPPED: pinning settled filter automation (Chrome already does), and
  disconnecting ended voices' nodes (measured: no cost left).
- Remaining ideas, all BIG refactors with small-to-moderate gain:
  a pooled renderer (one worklet node mixing several voices -- saves the
  per-node third), JS biquads inside the voice worklet (probably slower than
  native).

### Step 3 -- sound-affecting fixes: DONE (approved by the user: "Do 1-5")
All in resonance.js, unit-checked in unit.mjs:
1. **Revive**: a strike on a string whose voice is still on its fall
   (released by tick or a damper; `resumable`) stops the fall where it is
   (`holdFade`) and drives that voice again (top-up from there, 40 ms), not
   a second voice blooming in beside it. Too far decayed -> crossfaded into
   a fresh start as before.
2. **Tails count toward maxVoices** (`tails()`: released, `resumable`).
   `makeRoom` weighs driven voices and tails together (tails by where
   their fall has got to, `loudness`); a tail that is the quietest is cut
   in CUT = 0.1 s (`cut`).
3. **Shared filters**: one HP/HP/LP chain per `kind:midi` (`chain()`),
   shared by overlapping voices at the same partial cut-off (crossfade
   restarts, ~15% of resonance voices); the lvl/rel gains now sit in front
   of the filters. Exact except while a gain moves.
4. **Soundboard cap**: `sbMax = 12`, the loudest (nearest 6 either side);
   the rest were ~7% of the soundboard's energy (-0.3 dB).
5. **resumeFreed** brings back the loudest first and never more than
   maxVoices driven.
Plus a bug found on the way: **panic / resonance off left tails ringing up
to 3 s** (allOff released only driven voices); now cut in 50 ms.

Result: live sample voices = the engine's count (pedal level 1: 30 live
for 2 notes + 28 resonance; was 44-94). Scores in this container: no pedal
2-4 (was 0-1), pedal 0 (level 1 loses 31-89 ms, was 235-874): 28-32
resonance voices is about this container's whole capacity for resonance
chains (27-41, step 1). `resMax` (UI, default 32) is the knob; 16 still
fails pedal level 1 here by ~20 ms. On a real machine expect much higher.

### Next
- Measure on a real Mac (`npm run sampled:perf`): this container is far
  slower than any machine the piano is played on.
- If the pedal ladder is still low there: a pooled voice renderer (one
  worklet node for several voices) is the remaining big structural win --
  full plan in `sampled/PLAN-voices.md` (voice node pool + one renderer);
  or the noteOn main-thread cost under the pedal.
- noteOn profiled (pedal down, one key every 250 ms, ~30 resonance voices):
  node creation is small (~0.3 ms); most was `estimate`, called for every
  voice by makeRoom for each new string (N x N). Now cached per voice per
  time (and `order` keys computed once): mean 1.9-2.2 -> 1.5-1.6 ms, same
  decisions. Left: fade-in curve + tuning per voice (~0.1 ms, invalidation
  on envelope edits not worth it); makeRoom still loops over all voices.

### A/B render test
Built for the voice/stream (`sampled:ab`, see step 2). A whole-engine A/B
(for 2b / 3) still needs: gestures scheduled with `when`, Math.random
seeded (PEDAL_JITTER, relOffset), and the resonance tick made
deterministic -- or a comparison by spectrum/level instead of samples.

### Step 1b -- the sporadic spikes at low load (not reproducible here)
10-33 ms lost with 2-4 voices and resonance off, not every time. Measured:
a bare Chrome page with only the probe gets ~1 spike / 45 s, the idle
piano 3-4 / 15 s -- but the container's own audio headroom swings 8x
between runs (a CPU-burn worklet: 30k-250k iterations per quantum on a
bare page), so it cannot be pinned down here. Retry on a real machine.
Suspects:
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
