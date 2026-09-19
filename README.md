# Piano Model X

A physically modelled piano. Every string is an individual digital waveguide with
its own geometry, tension and losses, and they all meet at a shared bridge — so
unison beating, double decay and sympathetic resonance emerge from the model
rather than being bolted on as effects.

Runs in the browser. Play it with a MIDI keyboard.

## Run it

```bash
npm start           # -> http://localhost:8080
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
| **Dampers** | lossy terminations that ramp, not gates; bottom two octaves have none |
| **Bridge** | 16 soundboard zones with a spread kernel, so coupling depends on register |
| **Pedals** | sustain, una corda (hammer misses the outer string, which then rings sympathetically) |

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
npm run render          # demo WAVs into renders/
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
tools/                 verify, bench, render, analyse, serve, browser-test
```

The DSP is plain ES modules with no Web Audio dependency, so the same code runs
in the AudioWorklet and in Node for offline rendering and measurement. Filter
design happens on the **main** thread and ships coefficients to the audio thread,
so turning a knob costs the audio thread nothing.

## Known limits

- **Treble dispersion.** Above ~C6 the delay budget allows too few allpass
  sections, so inharmonicity drifts tens of cents on partials above 8 kHz. Mostly
  inaudible, but it is the least accurate part of the model.
- **One polarisation per string.** Real strings vibrate vertically and
  horizontally with different bridge coupling. Double decay currently comes from
  unison coupling alone; adding the second polarisation would make it stronger and
  more realistic, at 2× the string cost.
- **No longitudinal modes.** The "phantom partials" that give loud bass notes
  their growl are not modelled.
- **Hammer contact ignores returning waves** except the first agraffe reflection.
- **Sympathetic strings run at full quality.** Tiering them down would roughly
  double the affordable polyphony with the pedal held.

## Next

The browser build exists to be playable today. The DSP core is deliberately
portable: porting it to Rust behind the same interface gives a CLAP/VST3 plugin
(`nih-plug`) and the headroom for two polarisations per string, while the MIDI,
UI and parameter layers carry over unchanged.
