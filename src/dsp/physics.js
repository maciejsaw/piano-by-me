// Physical constants and string physics.
// Everything here is plain math, no audio deps: runs in Node and in an AudioWorklet.

export const MATERIALS = {
  steel:  { E: 2.00e11, rho: 7850 },   // music wire
  copper: { E: 1.17e11, rho: 8940 },   // bass winding
};

// Helical winding covers less than a solid annulus of the same outer diameter.
const WRAP_PACKING = 0.80;

export const A4 = 440;
export const noteHz = (midi, a4 = A4) => a4 * Math.pow(2, (midi - 69) / 12);
const NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
export const noteName = (midi) => NAMES[midi % 12] + (Math.floor(midi / 12) - 1);

/**
 * Linear mass density (kg/m) of a string.
 * For a wound string the core carries the stiffness and the wrap adds pure mass —
 * that is precisely why bass strings can be short and still have low inharmonicity.
 */
export function linearDensity(spec) {
  const core = MATERIALS[spec.coreMaterial ?? 'steel'];
  const rc = spec.coreDiameterMm * 1e-3 / 2;
  let mu = core.rho * Math.PI * rc * rc;
  if (spec.wound) {
    const wrap = MATERIALS[spec.wrapMaterial ?? 'copper'];
    const ro = spec.wrapOuterDiameterMm * 1e-3 / 2;
    const annulus = Math.PI * (ro * ro - rc * rc);
    mu += wrap.rho * annulus * WRAP_PACKING * (spec.wrapLayers ?? 1);
  }
  return mu;
}

/** Tension (N) needed for this geometry to speak at f0: T = mu * (2 L f0)^2 */
export const tension = (mu, lengthM, f0) => mu * Math.pow(2 * lengthM * f0, 2);

/**
 * Inharmonicity coefficient: f_n = n*f0*sqrt(1 + B n^2)
 * B = pi^3 E d^4 / (64 T L^2)   -- d is the CORE diameter (stiffness source).
 */
export function inharmonicity(spec, T) {
  const E = MATERIALS[spec.coreMaterial ?? 'steel'].E;
  const d = spec.coreDiameterMm * 1e-3;
  return (Math.PI ** 3 * E * d ** 4) / (64 * T * spec.lengthM ** 2);
}

/** Frequency of partial n including stiffness dispersion. */
export const partialHz = (f0, n, B) => n * f0 * Math.sqrt(1 + B * n * n);

/** Derive the full physical picture for one string. */
export function derive(spec, f0) {
  const mu = linearDensity(spec);
  const T = tension(mu, spec.lengthM, f0);
  return { mu, T, B: inharmonicity(spec, T), f0 };
}
