// The shipped default settings: what the instrument starts from on a fresh
// browser and returns to on "Reset everything". Exported from a tuned session
// (Export settings) and pasted here verbatim, so it has exactly the shape
// applySettings() consumes. The fitted curves in scale.js stay the reference --
// the offsets here are departures from them, visible in the parameter editor.
export const DEFAULT_SETTINGS = {
  "app": "piano-modelled",
  "version": 1,
  "sliders": {
    "gain": "12.5",
    "uc": "0.55",
    "bc": "0.3",
    "cw": "1.45",
    "cl": "2",
    "cd": "0.26",
    "cmix": "0.18",
    "cq": "26",
    "lid": "0.28",
    "rMix": "0.205",
    "rEr": "1",
    "rTail": "1",
    "rRt": "0.3",
    "rW": "6.5",
    "rD": "8.5",
    "rH": "3.6",
    "rAbs": "0.28",
    "rPre": "14",
    "rDamp": "3200",
    "rPos": "0.72"
  },
  "toggles": {
    "body": false,
    "room": true
  },
  "offsets": {
    "global": {
      "hammerMass": 0.855,
      "feltP": 0.1456,
      "feltEps": -0.21,
      "hammerWidthMm": 0.603,
      "strikeOffsetUs": 0.884,
      "hammerMassSpread": 1.482,
      "hammerForceSpread": 1.392,
      "knockGain": 0.83,
      "knockNoise": 1.338,
      "knockDecayS": 1.094,
      "knockFc": 0.20850000000000002,
      "hardness": -0.08800000000000001,
      "t60Low": 0.7124999999999999
    },
    "keys": {}
  },
  "notes": {}
};
