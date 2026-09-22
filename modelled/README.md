# Piano Model X

A physically modelled piano. Every string is an individual digital waveguide with
its own geometry, tension and losses, and they all meet at a shared bridge — so
unison beating, double decay and sympathetic resonance emerge from the model
rather than being bolted on as effects.

Runs in the browser. Play it with a MIDI keyboard.

**There are two instruments in this repository.** This one is modelled. The
other, in [`../sampled/`](../sampled/README.md), is a Yamaha C5 recorded — a
sample-based player built on the same measurements, with one dedicated sample
per key per velocity layer rather than one recording stretched across three
keys. Its rendered library is committed, so it plays without a build. They share the body fit, the room, and the scale data; see
[the variant's README](../sampled/README.md) for why a sampled piano needs a
build step, and what it buys.

## Run it

```bash
npm start           # from the repo root -> http://localhost:8080, pick "Modelled"
                    # (or go straight to http://localhost:8080/modelled/)
```

Open the page, click **Start audio**, and play. Web MIDI picks up an attached
keyboard automatically (Chrome or Edge; Safari and Firefox have no Web MIDI, but
the on-screen and computer keyboards still work).

- computer keyboard: `z`…`m` and `q`…`u`, `,` / `.` to shift octave
- `space` — sustain pedal (or CC 64 from your keyboard)
- CC 67 — una corda
- click a key to inspect its strings; **shift-click to hold it silently**

### Hear the sympathetic resonance

Shift-click **C4** to lift its dampers without striking it, then play **C3**
hard and release. C4 keeps ringing, driven entirely through the bridge. Release
the silent hold and it stops.

## What is modelled

| | |
|---|---|
| **Strings** | 240 waveguides: 1–3 per note, single delay loop each |
| **Stiffness** | dispersion allpass chain, fitted per string to the note's real inharmonicity `B = π³Ed⁴/(64TL²)` |
| **Wound strings** | core carries stiffness, winding adds mass — which is exactly why a short bass string can still have low inharmonicity |
| **Hammer** | nonlinear Hertzian contact `F = K·δ^p`, integrated per strike against the combined impedance of the unison, terminated by the wave reflecting off the agraffe |
| **Strike position** | comb filter; α ≈ 1/8 notches out the 8th partial |
| **Dampers** | lossy terminations that ramp, not gates; the top of the compass (above E6) has none, as on the C5 |
| **Bridge** | 16 soundboard zones with a spread kernel, so coupling depends on register |
| **Pedals** | sustain, una corda (hammer misses the outer string, which then rings sympathetically) |
| **Velocity** | two drawn curves: volume (dB below a full-velocity strike, normalised by the pulse's power at the string's partials so hammer speed keeps only the timbre) and a per-strike felt-hardness offset |
| **Output EQ** | the sampled piano's four-band EQ, after the room |
| **Body** | plate radiation efficiency, case as baffle, enclosed air as analytic box modes from real case dimensions, one lid reflection |

### Coupling

A piano has two coupling mechanisms that differ by orders of magnitude, so the
model is hierarchical:

```
strings of one note  -> near-common bridge point   strong  -> beating, double decay
note                 -> soundboard zone            weak    -> sympathetic resonance
zone                 -> neighbouring zones         weaker  -> register-dependent halo
```

Every junction value is an **average** of the waves meeting there, so each update
is a convex blend. Two properties follow, and both matter:

- **passive by construction** — it cannot add energy, so it cannot blow up
- **first-order in the coupling coefficient** — a send/return "sympathetic bus"
  would be second-order and land about 50 dB too quiet to hear

Coupling is expressed as a *fraction of each string's own loss*, never as an
absolute number. The coupling loss can never exceed the total loss (that would
need an internal loop gain above 1), so this both guarantees stability and makes
the requested T60 stay the T60 you actually get.

## The body

The string model stops at the bridge: it knows how the soundboard *loads* the
strings, but not how soundboard motion becomes pressure in a room. Measured
against a real grand, a model with no body is about **22 dB bass-heavy and
treble-shy**, and the error is the same smooth tilt for every note — the
signature of a missing radiation path, not a missing string parameter.

`src/dsp/body.js` supplies it, cheaply (~3% of a core):

- **radiation EQ** — plate radiation efficiency rising toward the critical
  frequency, with the case acting as a baffle. Either the physically-shaped
  default or a curve fitted to a real instrument.
- **cavity** — the enclosed air as real box modes, from the closed-form
  rectangular solution `f = (c/2)·√((nx/Lx)² + (ny/Ly)² + (nz/Lz)²)`. Case
  dimensions are live parameters, which a convolved impulse response can never
  be. For the default 2 m case the lowest air mode lands at 86 Hz — and the
  response measured from a real piano has a bump at 94–120 Hz.
- **lid** — one early reflection, which is most of the lid's audible effect.

**Why an LTI body is not a cheat, when commuted synthesis is.** Commuted
synthesis fails because it puts the soundboard *inside* the string feedback
loop, where an LTI block cannot support sympathetic resonance. The body sits
*downstream* of every coupling path — all the feedback has already happened —
and air loading back onto a spruce plate is a small perturbation. The test suite
checks this directly: enabling the body must tilt the spectrum and must leave
measured inharmonicity unchanged.

Truly simulating the air in 3D is possible but pointless in real time: ~4 mm
cells for 10 kHz gives ~15 M cells, CFL forces ~148 kHz stepping, and a 1 s
impulse response is ~2×10¹² cell updates — hours in optimised C. Since the
radiation path is genuinely LTI, the right move is to simulate once offline and
convolve, or to use the analytic modes above and skip the simulation entirely.

## Fitting the model to a real piano

The parameters are physical, so most of them can be **measured from recordings
of a real instrument rather than guessed** — and most need no optimiser at all.

Run these from `modelled/` -- outputs land in `renders/` and `fitted/` here.

```bash
node tools/fit/selftest.mjs                         # recover known params from renders
node tools/fit/analyze-samples.mjs <sampleDir> 12   # measure a real piano
node tools/fit/fit.mjs <sampleDir> 12 fitted.json   # fit a scale design
node tools/fit/body.mjs <sampleDir> fitted.json 12 body.json
node tools/fit/validate.mjs <sampleDir> fitted.json 12 body.json
```

| quantity | how it is obtained |
|---|---|
| tuning | measured directly per note |
| inharmonicity | measured, then **inverted in closed form** to wire gauge and length |
| strike position | fitted from the comb notch in the attack spectrum |
| decay | measured per partial, then fitted (2-D) to the loss filter |
| body | pooled residual across all notes in *absolute* frequency |
| hammer | the only genuine search — and it is 2-D per note |

The key structural point: a naive approach throws every parameter into one
black-box search against a spectrogram distance. Because this model is actually
physical, inharmonicity **inverts**: combining `B = π³Ed⁴/(64TL²)` with
`T = μ(2Lf₀)²` gives `d⁶ = 64BT²/(π⁴Eρf₀²)`, so a measured B plus a chosen
tension *determines* the wire gauge exactly. Round-trip error: 0.00%.

The body separates for a different reason — string parameters vary per note
while the body does not, so pooling residuals by *absolute* frequency across
many notes isolates it.

### Results against a Yamaha C5 (Salamander, CC-BY)

Rendering the fitted model and re-measuring it with the same extractor used on
the samples:

| | hand-designed | fitted |
|---|---|---|
| inharmonicity error | 30.2% | **12.6%** |
| tuning error | 6.4 cents | **1.7 cents** |
| attack spectrum RMS | 11.9 dB | **7.4 dB** |

The measured stretch curve is a textbook Railsback: −23 cents at A0 rising to
+20 cents in the treble.

`fitted/` holds the scale and body fitted from that library. Those same two
files are what lets the [sampled variant](../sampled/README.md) repitch a
recording without dragging the instrument's body along with the pitch — from a
single note you cannot separate the body's spectrum from the string's, and this
is where the separation already exists.

**Caveats, which matter.** The extracted body conflates soundboard radiation,
case, lid, microphones and room — it is "everything downstream of the bridge"
for *that recording*, not a pure instrument response. Decay fits inherit the
room's reverb tail, so they are biased long. Strike position is reliable in the
bass and mid and degrades in the treble where too few partials clear the noise
floor. And fitting is only as good as the model's ability to realise what it is
told: see the dispersion matching loop in `design.js`, which exists because the
allpass chain otherwise misses its target B by ~20%.

## Scale design

Editing 240 strings by hand is not viable, so `src/dsp/scale.js` holds ~12
breakpoints across the compass and interpolates. **Tension and wire gauge are the
inputs; speaking length is derived** (`L = √(T/μ) / 2f₀`) — that is how real
scaling works and it keeps tensions physical by construction. Where the derived
length exceeds the case, the winding is made heavier instead, exactly as piano
makers do in the bass.

The default design comes out at 670–750 N per string, 171 kN total (real grands
run 150–200 kN), with B rising smoothly from 1.2e-4 at A0 to 2.5e-2 at C8.

## Verifying

The point of a physical model is that the parameters mean something, so the tests
measure the *rendered audio* and check it against what was asked for.

```bash
npm run verify          # 18 checks on rendered audio
npm run bench           # CPU cost vs polyphony and quality
npm run test:browser    # loads the worklet in real Chromium and plays it
npm run render          # demo WAVs into modelled/renders/
```

`verify` measures inharmonicity (within 1.15× of spec), T60 (1.02×), unison beat
rates, sympathetic transfer, the pedal halo (−27 dB below the strike peak, and
74 dB above the same gesture with the pedal up), two-stage decay, and stability
under a fortissimo pedal-down cluster.

## Cost

At 48 kHz, percentage of one core:

| | 1 note | 10-note chord | 10 notes + pedal (all 240 ring) |
|---|---|---|---|
| quality 16 | 9% | 15% | 65% |
| quality 32 | 9% | 24% | 91% |
| quality 48 | 14% | 28% | 100% |

Quality is the allpass section count, which trades CPU against how accurately
inharmonicity is realised. Default is 16. Pedal-down is the worst case because
every string must run to receive sympathetic excitation.

## Layout

```
src/dsp/physics.js     string physics: density, tension, inharmonicity
src/dsp/scale.js       breakpoint scale design -> 240 string specs
src/dsp/design.js      parameter compiler: physical spec -> filter coefficients
src/dsp/string.js      one waveguide string
src/dsp/hammer.js      nonlinear contact solve
src/dsp/soundboard.js  bridge admittance
src/dsp/piano.js       the instrument and its junctions
src/worklet.js         audio thread host (thin)
src/main.js            MIDI, UI, and the parameter compiler
tools/                 verify, bench, render, analyse, browser-test, fit/
fitted/                scale and body fitted from Salamander (shared with ../sampled)
renders/               offline renders and A/B files

../sampled/            the sample-based variant: its own player and README
../tools/serve.mjs     the static server behind `npm start`
```

The DSP is plain ES modules with no Web Audio dependency, so the same code runs
in the AudioWorklet and in Node for offline rendering and measurement. Filter
design happens on the **main** thread and ships coefficients to the audio thread,
so turning a knob costs the audio thread nothing.

## Known limits

- **Treble dispersion.** Above ~C6 the delay budget allows too few allpass
  sections. The design now iterates so the REALISED inharmonicity matches the
  target (mean error 6.9%, from ~30% before), but the top octave still drifts.
- **One polarisation per string.** Real strings vibrate vertically and
  horizontally with different bridge coupling. Double decay currently comes from
  unison coupling alone; adding the second polarisation would make it stronger and
  more realistic, at 2× the string cost.
- **No longitudinal modes.** The "phantom partials" that give loud bass notes
  their growl are not modelled.
- **Hammer contact ignores returning waves** except the first agraffe reflection.
- **Sympathetic strings run at full quality.** Tiering them down would roughly
  double the affordable polyphony with the pedal held.
- **The body is one static filter.** Real radiation is directional and varies
  across the soundboard; this is a single average response. Per-zone radiation
  would be more faithful and is not expensive.
- **The hammer is not yet fitted.** It is the largest remaining term in the
  7.4 dB spectral residual.

## Next

The browser build exists to be playable today. The DSP core is deliberately
portable: porting it to Rust behind the same interface gives a CLAP/VST3 plugin
(`nih-plug`) and the headroom for two polarisations per string, while the MIDI,
UI and parameter layers carry over unchanged.
