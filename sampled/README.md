# Piano Model X — Sampled

A Yamaha C5, recorded. The other half of this repository models a piano from
its strings outwards; this half starts from a real one and spends its effort on
the things a sample library cannot record: what happens between the notes.

**One dedicated sample per key per velocity layer — 88 × 16 — not 30 × 16
stretched across the keyboard.** Every key that was not recorded is rendered
offline, once, with the instrument's own body response held still while the
pitch moves. The player on top does per-key velocity response, stereo spread,
a geometric room, Bézier envelopes on every join, and sympathetic resonance
that accumulates while the pedal is down.

```bash
npm start                 # -> http://localhost:8080/sampled/
```

**The rendered library is committed**, all 1704 files of it — 88 keys x 16
velocity layers, plus 296 release, damper and pedal samples, 183 MB of Opus.
Nothing has to be built or downloaded to play it.

To rebuild it from the recordings, which is only needed to change how it is
rendered:

```bash
npm run sampled:fetch     # 1.26 GB of Salamander recordings
npm run sampled:build     # ~12 min -> sampled/samples
npm run sampled:verify    # decode what came out and measure it
```

---

## Why a sampled piano needs a build step at all

Salamander records A0 and then every third semitone to C8: thirty notes, in
sixteen velocity layers. An SFZ player covers the other fifty-eight keys by
resampling at playback, which moves **everything** by up to a semitone and a
half — the partials, which is correct, and also the soundboard resonances, the
case air modes, the microphones and the room, which are not. Those are fixed in
absolute frequency. Dragging them around with the pitch is what puts the
audible seam in a sampled piano every third key, and it is worst in the bass,
where the fitted response has a **30 dB/octave flank** around the case's lowest
air mode.

So the repitch is done once, offline, and the body is put back:

```
G(f) = Body(f) / Body(f / ratio)
```

applied as a single zero-phase filter over the whole sample. Two things make
that both cheap and exact, and they are worth stating because the obvious
implementation is neither.

**The body is time invariant.** It is an LTI path from the bridge outwards (the
argument is in the main README). So the correction is one static filter, and a
per-frame estimate would only add variance to a quantity that does not vary.

**The body is already measured.** `fitted/salamander-body.json` is the response
of everything downstream of the bridge, fitted from *this library* by the
physical model in the other half of this repo. That matters more than it
sounds: from a single note you cannot separate the body's spectrum from the
string's, because a spectral tilt can be attributed to either and the
difference absorbed into the note's gain. The separation needs a string model
to hold one side of it still — and there is one here.

### What was tried first, and why it was dropped

The obvious approach is a per-frame true-envelope correction: estimate the
spectral envelope of each analysis frame (Röbel & Rodet's iterative method),
resample, and correct frame by frame. It was built and scored against a
synthetic instrument with a known body, and **it was worse than doing nothing
above C4**:

| | naive resample | per-frame envelope |
|---|---|---|
| C2 | 0.58 dB | 0.48 dB |
| C4 | 0.56 dB | 0.61 dB |
| C5 | 0.53 dB | 1.76 dB |
| C6 | 0.64 dB | 3.47 dB |

*(RMS spectral error against the correct answer; lower is better. Measured at
the time against a synthetic instrument, which is the only way to have a
correct answer to score against.)*

With partials 500 Hz apart there are too few of them to estimate an envelope
from, and the estimator's own noise is larger than the ~1 dB effect being
corrected. The static correction beat it everywhere, so the per-frame
machinery was deleted rather than kept as an option.

### What the repitch deliberately does not do

**It does not preserve duration.** Reading a sample faster shortens it by the
same ratio, and a real string a semitone higher really does decay faster — so a
time-stretch, with the transient smearing it costs, would be undoing something
that is already right.

**It does not touch phase.** The correction is a real, even-symmetric gain, so
it is a zero-phase filter, not a resynthesis. Measured: the pitch shift caused
by the correction is 0.0000 cents. The hammer attack comes through with its
phase relationships intact, which is the part a phase vocoder always damages.

**It does not transform inharmonicity.** Resampling scales every partial by the
same ratio, so B is unchanged, whereas a real string a semitone higher has a
slightly larger one. Over one semitone that is a few percent of B, far below
what the ear resolves — over the three semitones an SFZ player stretches a
sample across, it is not.

---

## The build pipeline

```
tools/sampler/fetch.mjs          download and unpack the recordings
tools/sampler/build.mjs          the orchestrator (a worker per core)
tools/sampler/worker.mjs         one recording -> the three keys it becomes
tools/sampler/selftest.mjs       does the repitch do what it claims?
tools/sampler/verify.mjs         decode the built library and measure it
tools/sampler/browser-test.mjs   does it play, in a real browser?

tools/sampler/lib/
  fft.mjs        radix-2, tables cached per size
  resample.mjs   128-tap Kaiser sinc, 4096 phases
  repitch.mjs    resample + the body correction
  trim.mjs       onset, tail, fades, subsonic
  pitch.mjs      f0 and B, jointly, from one FFT
  analysis.mjs   decay curves and early decay rate
  plan.mjs       which recording becomes which key, at what ratio
  encode.mjs     Opus, and why not MP3
  wav.mjs        stereo I/O
```

Each of the 480 recordings is read once and becomes up to three keys, so a
25 MB bass file is decoded once rather than three times. The two channels ride
a single complex FFT — L in the real part, R in the imaginary — because a real,
even-symmetric gain is a real filter, and a real filter applied to `l + jr`
comes back as `(h*l) + j(h*r)` with no cross-talk.

### Trimming

Stripping the leading silence is not cosmetic: a sampler's job is that the note
sounds when the key moves, and silence baked into the file is latency no buffer
size can recover. (Salamander is already tight — most files trim by 0 to 5 ms —
so this mostly proves the property rather than fixing it.) The onset threshold
is relative to the file's own peak with an absolute floor, and the cut is backed
off 2 ms with a 1 ms raised-cosine fade, because the true start of a hammer
strike is below any threshold you can set.

The tail floor is **absolute first, relative second**, and that ordering is a
quarter of the library's size. A pianissimo layer peaks 18 dB below a
fortissimo one; a purely relative floor keeps it ringing just as long, eighteen
decibels further below anything anyone will hear.

### Levels

Every sample is peak-normalised to −3 dBFS and its restoring gain written into
the manifest. That is **not** loudness matching — the player multiplies the gain
straight back, so relative levels across layers and notes are exactly preserved.
It is that a codec spends its bits relative to the signal it is given, and the
softest velocity layer sits 45 dB below the loudest. Normalising first hands
that layer the encoder's full range instead of a fortieth of it, at a cost of
one multiply per voice.

−3 dBFS and not −1: Opus is a transform codec, the waveform it reconstructs is
not the one it was given, and on a piano attack it overshoots. At −1 dBFS the
*decoded* peak measured +1.25 dBFS, which a browser clips.

### Opus, for a reason that is not quality

An MP3 decoder hands back a variable number of padding samples at the front of
the file — which, after the trouble taken to put the hammer strike on sample
zero, would put it back where it started, and differently per file. Opus
carries its pre-skip in the header and every browser decoder removes it.

### Tuning

`--tune measured` is the default, and the verifier is why. Measured off the
recordings:

| | C7 | F♯7 | A7 | C8 |
|---|---|---|---|---|
| cents sharp of equal temperament | +24 | +24 | +39 | **+100** |

A Railsback curve that runs away in the last octave is a real thing, but each
recording serves three keys, so leaving it alone puts a **60-cent step between
A♯7 and B7** — the two are a semitone apart and sound nearly a tone apart. The
default measures every key's real pitch and places it on the Railsback curve
fitted from this library, which removes the step. `--tune curve` preserves the
recording exactly, tuning warts included; `--tune none` uses exact equal-tempered
ratios.

Measuring that pitch is its own problem. **On A0 the fundamental is 37 dB below
the fourth partial** — a 27 Hz string radiates almost nothing at 27 Hz — so
looking for a peak near 27.5 Hz finds room rumble and reports a pitch eight
cents out, differently for every layer of the same note. `pitch.mjs` fits f0 and
B together across two dozen partials, progressively: five partials first, then
more, because a window centred on `n·f0` with B still wrong misses the high
partials entirely and the fit collapses toward B = 0. It agrees with the
model's own Goertzel-based fitter to about a cent and runs roughly a thousand
times faster, which is the difference between a twelve-minute build and a
four-hour one.

---

## The player

```
sampled/src/
  library.js     streaming, warm order, LRU by bytes
  velocity.js    level and timbre, separately
  engine.js      voices, channel strips, pedals
  resonance.js   sympathetic resonance
  bezier.js      the envelope shapes, and their editor
  envelopes.js   the five envelopes and the hold-time law
  room.js        the modelled room, rendered to an impulse
  curves.js      per-key parameters and the drawable editor
  keyboard.js    the keyboard widget
  main.js        MIDI, UI, wiring
```

### It has to stream, and the arithmetic says so

88 keys × 16 layers is about 190 MB of Opus, which is a reasonable download, and
**5.2 GB once decoded**, which is not a reasonable anything. So: an LRU cache
bounded by decoded bytes (not by count — one 25-second A0 costs what forty C8s
do), a warm order that loads mezzo-forte first and middle-out from the centre of
the keyboard, and a note-on that never waits. If the exact layer is not
resident it plays the closest one that is, **trimmed to exactly the right
level**, and queues the real one — a momentarily approximate timbre instead of
a dropout, which is the right way round.

Two things are **pinned**, never evicted, and both close off a failure worse
than it sounds — a key with nothing resident makes *no sound*, and a player
cannot tell that from a dud key:

| pinned | size | why |
|---|---|---|
| all 296 release, damper and pedal samples | 134 MB | wanted on every key lift, and their absence is silent. The browser test caught exactly this: the first time any key was let go, nothing happened, and the fetch it queued arrived far too late to be heard. |
| the softest layer of every key | 190 MB | the floor. The *softest*, because those are the shortest files — a mezzo-forte layer for all 88 keys is 383 MB, most of the budget spent on something that is almost never the thing actually playing. |

Two more consequences the tests forced out. A note-on for a key with nothing
resident still marks the key down, so its damper lifts, it joins the
sympathetic set, and letting it go still makes the sounds a key makes — before
that fix, a note struck while loading was silent going down *and* coming up.
And `panic()` stops one-shot samples as well as voices, because a two-second
damper thud outliving a panic makes every measurement taken just after one
wrong.

### Velocity response, per key

A sampled piano has to answer two questions from one number, and the usual
mistake is to answer them with one mechanism:

- **how loud** — a real grand runs 35–45 dB from pianissimo to fortissimo
- **how bright** — which is not a filter, it is which recording gets played

Salamander's sixteen layers answer the second perfectly and the first only
partly: measured across the library, layer 1 peaks about **18 dB** below layer
16, not 42. That is not a flaw in the recordings — most of a piano's dynamic
range is in the spectrum, and a microphone's range is narrower than the ear's
impression of it. The SFZ covers the gap with a blanket `amp_veltrack`; this
covers it per key, on a curve you can draw.

So the two are separated. **Layer** comes from velocity through a per-key bias.
**Gain** is the level the curve asked for, minus the level that recording
already has (measured, in the manifest). Changing the curve never changes the
timbre; changing the layer bias never changes the level.

Nine per-key curves in all — dynamic range, curve shape, level trim, layer bias,
stereo position, width, tuning, resonance send, damper fall speed — plus two for
the release samples. Each has one slider that moves the whole compass and one
canvas you draw single notes on. Both add, and both are offsets, so zero is
always "as shipped" and however far an edit wanders there is a defined way back.

### Envelopes are Bézier curves, not time constants

Every envelope here is a cubic Bézier with two draggable handles. That is
deliberate over the usual attack/decay knob: an ADSR's *shape* is fixed and all
you get to move is how long it takes, but the shape is what a damper argument is
about. A damper falling on a bass string does not decay exponentially — it grips
slowly, then bites. With two handles you can say that.

| envelope | what it is for |
|---|---|
| note attack | zero by default — the recording already has a hammer in it. Raise it to take the knock off the front. |
| damper fall | duration is per key; this is the shape. The same shape stops a sympathetic voice, because it is the same damper. |
| release-sample attack | these start *on top of* a note that is still sounding, so switching one on at full level is a click in the middle of a decaying chord. |
| release-sample release | so the release sample lands rather than stops. |
| release level vs hold time | see below. |

Nothing runs per audio sample: each curve is baked into a `Float32Array` and
handed to `setValueCurveAtTime`, so the browser interpolates it on the audio
thread. The envelope's value at any instant is computed in closed form rather
than read back from the `GainNode`, because a release that starts from the wrong
value is a step — audible on every key lift, and browsers do not agree about what
`gain.value` means mid-automation.

### Release level against how long the key was held

The damper-release sound is the sound of a damper **stopping** something, so it
depends on how much is left to stop — and a piano string four seconds into its
decay has very little. Salamander's SFZ models this as a flat dB per second
(`rt_decay`); here it is a curve, because a real decay is not a straight line in
dB and the first second matters far more than the eighth.

The editor draws **that key's own measured decay** behind the curve, from the
build-time analysis in the manifest. Trace the dashed line and the law is
physically right for that key; ignore it and it is whatever you wanted.

The key-up thud does *not* follow the hold law by default — a key comes up the
same way whether it was down for a moment or a minute; this is felt, not rung —
but there is a slider for anyone who disagrees. Both release samples have their
own per-key level curve, because Salamander recorded all 88 separately and they
are not even.

### Stereo spread

Every key gets its own place across the image, bass to treble, as a **rotation of
that key's recorded stereo picture** rather than a pan — or the treble would
arrive mono and hard right. The recordings are all from one microphone position,
so this is putting back something the soundboard had and the microphones could
not. Width, spread and per-key position are separate controls, and the
perspective flips between the player's view and the audience's.

The matrix is built once per key and lives on a **channel strip per key**, not
per voice: where a key sits in the image is a property of where its strings sit
on the soundboard, and outlives any particular note. It also means a sympathetic
voice lands in the same place as a struck one — which is not an optimisation but
a requirement, since they are the same strings.

### The room

Not a captured impulse response: this runs the **same room the modelled variant
uses** — `src/dsp/room.js`, an image-source model of a shoebox for the early
reflections and an eight-line feedback delay network for the tail — against an
impulse for a couple of seconds, and hands the result to a `ConvolverNode`.

That is the right division of labour in a browser. The room's parameters are
geometry, and geometry is exactly what a captured IR cannot give back: moving
the listener in an IR library means finding another IR. Here it means a redraw
costing a few milliseconds, after which the convolution runs in native code at a
cost that does not depend on how complicated the room is.

The early part earns its keep. A reverb that starts with a wash gives a piano
the distant, characterless sound of a plate; the first few dozen arrivals are
what tell the ear the size and shape of the room, and those come from real path
lengths off real surfaces, with the two ears at different distances from every
one of them.

The IR is normalised against the energy of the *first* room rendered, not its
own, so opening the room up genuinely gives you more reverb. Normalising each IR
to itself — which is what `ConvolverNode.normalize` does — would take that
straight back out and leave the geometry controls affecting only the colour.

### Sympathetic resonance

When a hammer hits a string, every other string whose damper is off is driven
through the bridge and rings at whatever partials it shares. It is why a piano
with the pedal down is a different instrument from one with the pedal up.

The modelled variant gets this for free — its strings are real waveguides on a
shared bridge. A sampler has no strings, so it is built, and the honest way to
build it from a sample library is to play the library's own softest recordings,
started past the hammer knock so what you hear is string and not a strike.

**Which** strings answer is decided by partial coincidence, with each string's
real inharmonicity and the bandwidth implied by its measured decay rate — a
Lorentzian in Hz, which is the shape a driven resonator actually has, rather
than a Gaussian in cents, which is the usual shortcut and gets the bass wrong
because bandwidth is a property of frequency and cents are not. A fifth answers
strongly; a tritone barely. The whole 88 × 88 matrix is computed once at load.

**How much** is an energy accumulator per string, not a trigger. Every strike
adds to it, scaled by velocity to a power (2 is the energy a hammer delivers),
and it leaks away at that string's own measured decay rate.

**Pile-up** falls out of the accumulator for free. With the pedal down nothing
is damped, so a second chord adds to what the first left behind and the halo
grows. Lift the pedal and every accumulator is cut at the speed of its damper.
Measured in the browser test: four strikes leave 5.8× the energy of one.

The trick that makes it sound right rather than merely correct: **the resonating
sample's own decay is divided back out of its gain**, from the decay curve
measured at build time and clamped at +12 dB. Without it the voice would die at
twice the proper rate — once because the string is decaying and once again
because the recording of it is. With it, the accumulator alone decides the
level and the recording only supplies the timbre.

The top twenty keys of a grand have no dampers at all, so they are always in the
undamped set. That is most of where a piano's shimmer comes from and it costs
nothing to get right.

### Mechanics

Key-release noise (all 88 recorded separately), damper-release string resonance
in Salamander's three variants picked by velocity, and pedal action, all on their
own bus — mechanical noise does not belong to a key's place on the soundboard.

**At Salamander's own levels, which are not the levels in the files.** The
key-release recordings sit at full scale — `rel40.wav` peaks within 2 dB of a
fortissimo C4 — and the SFZ takes **37 dB** straight back off in its group
header. Played at face value, as this did at first, every key lift sounds like
a dropped hammer. The manifest now carries that table (`mixDb`), and the
browser test checks it: a key thud measures 36.9 dB below the fortissimo note
it followed.

The sustain pedal is **continuous, not a switch**: CC 64 is read across its whole
range, and half-pedalling shortens a note without stopping it, interpolated
geometrically between the damper time and a free string. Sostenuto (CC 66)
captures what is held. Una corda (CC 67) drops the level *and* reaches for a
gentler recording two layers down — the "softer" part is the one a filter cannot
fake.

A limiter sits on the output as a seatbelt, not a sound: ten fortissimo notes
under a held pedal measures −3 dBFS RMS with it bypassed, which is a real
gesture on a real piano and really is louder than one note.

---

## Checking it

```bash
npm run sampled:selftest   # does the repitch do what it claims? (synthetic, exact)
npm run sampled:verify     # decode the built library and measure it
npm run sampled:test       # does it play, in a real browser?
```

**Neither of them tests physics, and that is the point.** A sampled instrument
cannot get a partial wrong — the recording already contains it. What a build
can get wrong is the filter it applies, a missing file, a level that clips,
silence left at the front, a step in the tuning table. So those are what is
checked, and an earlier version of these tools that scored partial levels and
re-measured inharmonicity has been thrown out.

`selftest` measures the repitch filter **directly**, with an H1 transfer
estimate between the corrected and uncorrected versions of the same resampled
noise — so what is between them is the filter and nothing else. It comes back
at **0.004 dB rms** against `Body(f)/Body(f/ratio)` and a maximum phase of
**0.04°**, which is the zero-phase claim measured rather than asserted. (The
obvious phase test — feed a symmetric impulse, look for a symmetric output —
does not work: a resampled impulse is a sinc centred *between* two samples, so
there is no sample to measure symmetry about.)

`verify` decodes the Opus files the browser will actually be handed — so codec
overshoot and any returned pre-skip show up here rather than under someone's
fingers — and checks completeness, headroom, that silence really is stripped,
that layers rise with velocity, that neighbouring keys do not jump in level,
and that the tuning table has no step in it.

`sampled:test` drives the real instrument in Chromium — twenty-two checks,
measured through an analyser on its master bus or read off the gains the engine
actually schedules: that notes sound and velocity changes level, that strings
free to ring do ring and damped ones do not, that resonance piles up and the
pedal cuts it, that a released key rings on under a held pedal and stops when
it lifts, that the attack envelope holds a note back and the damper-fall
*shape* changes the fall, that a long-held key gives a release 21 dB quieter,
that a per-key −40 dB trim lands at −40.0 dB, and that the key thud sits 37 dB
under the note it came off.

Two of those are asserted on scheduled gains rather than on the analyser, and
deliberately: a damper thud is impulsive and 40 dB below the note it followed,
so measuring one through an 85 ms window right after a note-off is not
repeatable. The first attempt read the note's own tail and reported the same
number whatever the release settings were — which is worse than no test,
because it passed.

---

## Known limits

- **Inharmonicity does not transform** under repitch. A few percent of B over
  one semitone; inaudible, but it is an approximation and not an exactness.
- **The body correction is one static filter per ratio.** Correct, because the
  body is LTI — but it cannot fix the *hammer knock*, which is broadly fixed in
  absolute frequency and does move with the resample.
- **Top-octave pitch is measured to about ±5 cents.** Three partials clear
  Nyquist, the note is under a second long, and the unison is spread. The
  estimator says so — `hzUncertain` in the manifest — rather than pretending.
- **One microphone position.** The stereo spread is reconstructed, not recorded.
  No amount of matrixing invents the soundboard's near field.
- **Sympathetic resonance is played, not solved.** It is driven by a physically
  motivated coupling matrix and a physically motivated accumulator, but the
  voices are recordings of *struck* notes with the strike cut off, not strings
  being driven through a bridge. The modelled variant is the one that does that.
- **The memory floor is 324 MB of the default 640 MB budget.** That is the
  price of never having a silent key; below a 300 MB budget the pinning is
  skipped and keys can go quiet while loading.
- **Opus in Ogg** needs Safari 15 or later; `--format webm` is there if that
  matters.

## Credit

[Salamander Grand Piano V3](https://freepats.zenvoid.org/Piano/acoustic-grand-piano.html)
by **Alexander Holm**, CC-BY 3.0 — a Yamaha C5, 48 kHz / 24-bit, sixteen
velocity layers. Everything here is a transformation of that recording and
carries the same licence and the same attribution.
