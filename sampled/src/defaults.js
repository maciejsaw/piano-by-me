// The shipped default settings: the tuning the instrument starts from on a
// fresh browser and returns to on "Reset everything". Exported from a tuned
// session (Export settings) and pasted here verbatim, so it has exactly the
// shape applySettings() consumes.
export const DEFAULT_SETTINGS = {
  "app": "piano-sampled",
  "version": 1,
  "curves": {
    "g": {
      "dynamic": 0,
      "gamma": 0.4284,
      "trim": 0,
      "layerBias": 0,
      "pan": 0.004,
      "width": 0,
      "tune": 0,
      "resonance": -0.108,
      "damping": 1.2449999999999999,
      "releaseLevel": -9,
      "damperLevel": -14.4
    },
    "r": {},
    "k": {}
  },
  "envelopes": {
    "noteAttack": {
      "ms": 0,
      "shape": [
        0.05,
        0.75,
        0.2,
        0.98
      ]
    },
    "noteRelease": {
      "shape": [
        0.08,
        0.62,
        0.32,
        0.9
      ]
    },
    "relAttack": {
      "ms": 4,
      "shape": [
        0.08,
        0.62,
        0.32,
        0.9
      ]
    },
    "relRelease": {
      "ms": 240,
      "shape": [
        0.08,
        0.62,
        0.32,
        0.9
      ]
    },
    "pedalAttack": {
      "ms": 6,
      "shape": [
        0.05,
        0.75,
        0.2,
        0.98
      ]
    },
    "hold": {
      "seconds": 8,
      "floorDb": -26,
      "keyNoiseFollow": 0,
      "shape": [
        0.08,
        0.62,
        0.32,
        0.9
      ]
    }
  },
  "velCurve": {
    "enabled": false,
    "points": [
      {
        "v": 1,
        "db": -68.7905859375
      },
      {
        "v": 6,
        "db": -68.733017578125
      },
      {
        "v": 67,
        "db": -68.18794921875
      },
      {
        "v": 85,
        "db": -9
      },
      {
        "v": 127,
        "db": 0
      }
    ]
  },
  "velLayer": {
    "min": 1,
    "max": 16,
    "points": [
      {
        "v": 1,
        "layer": 1
      },
      {
        "v": 26,
        "layer": 1
      },
      {
        "v": 34,
        "layer": 1.6550781250000004
      },
      {
        "v": 51,
        "layer": 2.498309326171875
      },
      {
        "v": 61,
        "layer": 3.3804260253906246
      },
      {
        "v": 74,
        "layer": 5.0953735351562495
      },
      {
        "v": 94,
        "layer": 11.509857177734375
      },
      {
        "v": 101,
        "layer": 14.581744384765626
      },
      {
        "v": 112,
        "layer": 16
      },
      {
        "v": 120,
        "layer": 16
      },
      {
        "v": 127,
        "layer": 16
      }
    ]
  },
  "sliders": {
    "gain": "0.45",
    "spread": "-0.15",
    "width": "0.56",
    "wet": "0",
    "size": "1",
    "rt60": "1.35",
    "absorb": "0.26",
    "dist": "0.72",
    "resAmt": "0.25",
    "resDrive": "3.3",
    "resSel": "14.5",
    "resTone": "5200",
    "resMax": "16",
    "resTail": "0.8",
    "sbAmt": "0.09",
    "sbTail": "4.1",
    "resDamped": "0.12",
    "resOffDrop": "0.17",
    "resOffFall": "3.5",
    "naMs": "0",
    "raMs": "4",
    "rrMs": "240",
    "paMs": "6",
    "hoSec": "8",
    "hoFloor": "-26",
    "hoKey": "0",
    "ped": "0",
    "una": "0",
    "relNoise": "0.67",
    "dampNoise": "1.22",
    "pedNoise": "0",
    "pedTail": "5",
    "pedWet": "0.6",
    "relTrim": "99",
    "relRR": "33",
    "relDelay": "1",
    "budget": "768"
  },
  "eqBands": [
    {
      "f": "4.34919738166216",
      "g": "2.3"
    },
    {
      "f": "6.28517018598809",
      "g": "-7.5",
      "q": "1"
    },
    {
      "f": "8.04161172766793",
      "g": "0",
      "q": "0.9"
    },
    {
      "f": "9.27090245954208",
      "g": "2.6"
    }
  ],
  "toggles": {
    "limiter": true,
    "eq": true,
    "res": true,
    "perspective": 1
  }
};
