# Piano Model X

One piano, two ways. Both play in the browser, with a MIDI keyboard or the
computer keyboard.

| | |
|---|---|
| **Classic grand piano** — [`sampled/`](sampled/README.md) | a recorded Yamaha C5 (Salamander), one dedicated sample per key per layer |
| **Electric clavinet** — [`modelled/`](modelled/README.md) | physically modelled: 240 waveguide strings on a shared bridge |

## Run it

```bash
npm install
npm start           # -> http://localhost:8080, then pick an instrument (1 = Classic grand piano, 2 = Electric clavinet)
```

`/modelled/` and `/sampled/` open either one directly; the title in each
page's header links back to the chooser.

## Scripts

```bash
npm run verify            # modelled: checks on rendered audio
npm run bench             # modelled: CPU cost vs polyphony and quality
npm run test:browser      # modelled: worklet in real Chromium
npm run render            # modelled: demo WAVs into modelled/renders/

npm run sampled:selftest  # sampled: does the repitch do what it claims?
npm run sampled:verify    # sampled: decode the built library and measure it
npm run sampled:test      # sampled: does it play, in a real browser?
npm run sampled:render -- performance.mid   # -> sampled/renders/
npm run sampled:fetch && npm run sampled:build   # rebuild the library
```

## Layout

```
index.html        the chooser
tools/serve.mjs   static server for the whole repo
modelled/         the physical model: page, src/, tools/, fitted/, renders/
sampled/          the sampler: page, src/, tools/, samples/, renders/
```

The sampled piano borrows from the modelled one: its room is
`modelled/src/dsp/room.js`, and its build repitches with the body and scale
in `modelled/fitted/`.
