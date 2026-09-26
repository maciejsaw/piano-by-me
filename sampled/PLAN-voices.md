# Plan: fewer audio nodes per voice (voice pool, then one voice renderer)

Written to be picked up after a context compaction. Read this, then
`sampled/PLAN.md` (history, measurements, tools). Branch:
`claude/sampled-piano-stability-steks6`.

## Ground rules (from the user -- they still hold)
- No UI or sound change without discussing it first. Where a step may change
  the sound, say how and by how much (measured, in dB below the signal),
  and keep it behind a switch that is OFF by default until the user says yes.
- Bug fixes that restore intended audio are fine, but call them out.
- Tests stay fast (`npm run sampled:test`); slow ones go in the opt-in set
  (`sampled:test:full`, `sampled:ab`, `sampled:perf`).
- Goal: the highest ladder score with no dropouts (`npm run sampled:perf`),
  and fewer of the occasional low-load glitches (PLAN.md step 1b).
- Commits end with the Co-Authored-By / Claude-Session trailer used on this
  branch (see `git log`). No model names in commits or code. No PR unless asked.
- Measure before and after every step, in the same session (the container's
  headroom swings a lot between runs): 2-3 runs each, compare medians.

## Why

Measured (PLAN.md step 1, `npm run sampled:perf -- --micro`):

- Chrome charges a fixed cost per AudioWorkletNode per render quantum:
  an empty worklet node manages only 140-210 before dropouts here. That is
  about a third of what a voice costs; the rest is the biquads and our JS.
- Today every voice is its own graph:
  - **struck note**: a `piano-voice` worklet node, then `lvl`, `att` and
    `rel` gains, into the key's strip `direct` (`engine.js` noteOn);
  - **resonance voice**: a worklet node, then `lvl` and `rel` gains, into a
    chain of HP, HP and LP filters per string (shared per `kind:midi`), into
    the strip's `in` (`resonance.js` start / chain).
- Under the pedal that is about 30 worklet nodes, 60+ gains and up to 90
  biquads, with ~28 of them created on every key press. Creating them costs
  ~0.3 ms of main thread per key. What it costs the audio thread is not
  measured; node creation and teardown are suspects for the low-load
  glitches (graph changes take a lock the audio thread waits on).

Everything a voice goes through before its strip is per-voice gain
automation plus, for resonance, 3 fixed or slowly moving filters. All of
that can be done in plain JS inside one worklet.

## Stage 0 -- measurements that decide what to build (no product change)

Add these to `sampled/tools/perf.mjs --micro` (or a sibling mode) and record
the numbers in this file:

1. **Idle pooled node cost**: N `piano-voice` nodes created but not playing
   (process returns true, writes nothing), with the output connected versus
   disconnected. If an idle node costs about as much as an empty one (~1/170
   of the budget each), a big pool is a net loss: 32 idle nodes would eat
   about 20% of the headroom.
2. **Creation cost on the audio thread**: create and end K voice nodes per
   second (K = 10, 30, 100) with nothing else playing, and count probe
   dropouts. If creation shows up as dropouts, pooling is worth it even at
   some idle cost. If not, skip stage A.
3. **JS renderer prototype capacity**: one worklet node that plays N voices
   (copy from the heads at rate 1, per-sample gain from a JS ramp, and for
   the resonance case 3 JS biquads per voice), output muted. Compare its
   capacity with the `note` and `res` chains. Go ahead with stage B only if
   it is at least 1.5x the node-per-voice capacity for both.
4. **JS biquad versus native**: the same filter with fixed and with moving
   frequency. Chrome recomputes coefficients every sample while the
   frequency automates; JS can do it once per 128-sample block (cheaper, but
   a tiny sound change -- see stage B, step 5).

Record results, decide A and/or B, and tell the user the numbers before
starting on B.

## Stage A -- voice node pool (small; only if Stage 0.2 says creation hurts)

Reuse `piano-voice` nodes instead of creating one per note.

1. `stream-worklet.js`, PianoVoice:
   - Add an `arm` message: `{ id, key, total }`. It resets every field that
     the constructor sets (state, pos, queue, fade, stopFrame, underrun) and
     re-registers in `voices` under the new id.
   - When a voice finishes, instead of returning false it reports
     `ended`, goes idle (state 3: writes nothing, returns true), and waits
     for the next `arm`.
   - The worker must not send blocks for the old id after the re-arm
     (stream ids are per note already; check `giveBack` and the worker's
     stream close).
2. `stream.js`:
   - A pool of idle nodes (`Streamer.pool`) with a small cap (from 0.1,
     e.g. 8-16 spares).
   - `StreamSource` takes a node from the pool (else creates one), sends
     `arm`, and on `ended` disconnects the node and returns it to the pool
     (or lets it return false and die if the pool is full).
   - `playbackRate` must be reset on reuse.
3. The gains after the voice stay as they are (creating a GainNode is cheap
   and has no audio-thread process cost when idle).
4. Checks:
   - `npm run sampled:ab` must stay IDENTICAL: same samples, same code path.
   - `npm run sampled:test`.
   - Stage 0.2's churn test before/after.
   - Ladder before/after.

## Stage B -- one voice renderer (big; the real structural win)

One `piano-voices` processor renders every voice: sample playback, per-voice
gains, resonance filters, and the per-key strip mix. Native nodes remain
only after it. Built behind `engine.renderer = true|false` (default false)
so both paths live side by side until the user approves.

### Where it plugs in

The strip (`engine.js` makeStrip) is: `direct` gain -> `in` gain -> channel
swap -> 2x2 width/pan matrix (4 gains) -> `out` -> dry and send. All of that
is per-key numbers, so the renderer can apply it itself:

    renderer (all voices, per-key matrix in JS) --► dry
                                               └──► send

- One stereo output, connected to `this.dry` and `this.send` exactly where
  the strips' `out` connects.
- The native strips stay for what does not move to the renderer: release
  and damper one-shots (AudioBufferSources into `strip.direct`). Move those
  later, or never.
- Strip state has to be mirrored:
  - `refreshStrips` posts each key's 4 matrix gains and its trim;
  - `setSoloRes` posts the `direct` mute with its 20 ms ramp.
  Do both from the same engine method that sets the native gains, so they
  cannot drift apart.

### Steps

1. **Split PianoVoice into a plain `Voice` class plus a processor.** The
   playback code (begin, copy, read, fade, push, eof, stop, resume, reports
   to the worker) moves into `Voice`, which renders into given arrays.
   `piano-voice` becomes a thin processor holding one `Voice`.
   `npm run sampled:ab` must stay IDENTICAL -- this is a pure refactor.
2. **JS automation timeline** (new `sampled/src/automation.js`, imported by
   the worklet and unit-testable in Node). It covers the calls the engine
   and resonance make today, with the Web Audio spec's formulas:
   - setValueAtTime;
   - linearRampToValueAtTime;
   - setTargetAtTime;
   - setValueCurveAtTime (linear interpolation over `(N-1)*(t-t0)/dur`,
     same as `fadeAt`);
   - cancelScheduledValues;
   - the `holdFade` pattern (cancel from t, then ramp to the curve's value
     at t).

   Values are per sample, like native a-rate gains. It also needs clamping
   of late events to "now", the same as native. Unit tests: compare against
   an OfflineAudioContext render of the same events on a GainNode, in the
   browser test set, and assert closeness (float32 vs double: expect
   < -120 dB).
3. **Renderer processor** `piano-voices` in `stream-worklet.js` (same scope,
   so it shares `heads` and the block routing by id):
   - A voice pool on the audio thread: preallocated `Voice` objects, no
     allocation per note (GC on the audio thread is a glitch).
   - Each voice carries:
     - its gains as automation timelines (`lvl`, `att`, `rel`, and the
       resonance `lvl` top-ups);
     - its key;
     - whether it enters through `direct` (struck) or `in` (resonance);
     - an optional filter chain id.
   - Resonance filter chains, one per `kind:midi` as now: 2 HP + LP biquads
     in JS with the same coefficient formulas as Chrome (Audio EQ Cookbook,
     as in the spec's BiquadFilterNode section). Voices sharing a chain are
     summed before it, which is exactly what the shared native chain does
     today.
   - Mix: each voice into its key's accumulator, apply the key's matrix and
     the `direct` mute, then sum into the output.
   - Batched `ended` messages, with underrun counts as today.
   - A try/catch per voice: an exception kills that voice, not all of them.
4. **Main-thread facade** (`stream.js` or a new `voices.js`): handles with
   the interface the engine already uses, so `engine.js` and `resonance.js`
   change as little as possible.
   - The voice: `start`, `stop`, `resume`, `onended`, `playbackRate`.
   - Param-like objects for each gain, with the automation calls above
     (they post events instead of scheduling a native param).
   - `holdFade` / `fadeAt` keep working unchanged: they only call those
     methods.
   - A filter-chain handle with `frequency.setTargetAtTime` for
     `setPartialFilter` and `setTone`.
   - **Messages batched**: everything posted during one task goes out as a
     single postMessage, flushed in a microtask. So a pedalled key press is
     one message instead of ~100.
5. **Filter automation rate** (decide with the user): computing moving
   filter coefficients per sample in JS is expensive (that is why moving
   native filters cost 2-3x). Per 128-sample block is cheap. The difference
   only exists while `setTone` or `setPartialFilter` is gliding (tau 20-50
   ms). Measure the difference in dB on a recorded glide and present it;
   default to per-sample if the user does not want any change.
6. **Wire the engine**:
   - `engine.renderer` chooses the path in noteOn / kill / release, and
     `resonance.start` / `chain` / `release` / `cut` / `revive` /
     `resumeFreed` / `allOff`;
   - `stats()` and the `live` count in perf must count renderer voices;
   - `prune`, `forget` and the UI's held-key display must work from the
     same voice records.
7. **Verify** (sound first, then speed):
   - Extend `sampled/tools/ab.mjs` with an engine-level mode: the same
     scripted gesture set (notes, pedal, re-strikes, releases, panic) played
     with `renderer=false` and `renderer=true` in one page. That needs:
     - every event scheduled with an explicit `when`;
     - Math.random stubbed to a seeded generator (PEDAL_JITTER, relOffset);
     - the resonance tick driven by the script, not by the 40 ms timer;
     - the dry bus recorded with room/hall off.

     Compare by max difference in dB below peak, plus level per band. The
     pass threshold is agreed with the user; propose -90 dB. Report every
     place it is worse.
   - `npm run sampled:test` and `sampled:test:full` green with the renderer
     on and off.
   - Ladder and `--micro` (add a `renderer` chain) before and after, and
     record them here.
8. **Hand-over to the user**: numbers, the measured sound difference, and
   the question "switch the default?". Only after a yes: default on, and
   later delete the node-per-voice path.

### Risks to keep in mind
- One node now carries all voices: a bug there silences everything, not one
  note. Hence the per-voice try/catch and the long gesture tests (smoke,
  stress, decoders killed mid-note) with the renderer on.
- The audio thread still renders everything on one thread (Chrome does not
  parallelise nodes), so nothing is lost by merging. But one long voice loop
  must not allocate: preallocate the accumulators and mix buffers.
- Strip state mirrored in two places (native for one-shots, JS for voices):
  one setter for both, and a unit check that they agree.
- Tempo of messages: late messages are clamped to "now" exactly like native
  params, so a loaded main thread gives the same smooth-but-late behaviour
  the engine relies on (see the comments in noteOn about `rel`).

## Order of work after compaction
1. Stage 0 (measure, write the numbers here, tell the user).
2. Stage A if 0.2 says creation hurts, otherwise skip it.
3. Stage B steps 1-2 (pure refactor + automation with tests), then 3-4,
   then 6-7 with the switch off; step 5's choice and step 8 go to the user.

Commit after each step that passes its checks; push to the branch.
