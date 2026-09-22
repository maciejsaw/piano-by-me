// Invert measured acoustics back into string geometry.
//
// This is the payoff of having built a *physical* model: most of it does not
// need optimising at all. Combine
//     B = pi^3 E d^4 / (64 T L^2)      and      T = mu (2 L f0)^2
// and for a plain steel string the diameter falls out in closed form:
//     d^6 = 64 B T^2 / (pi^4 E rho f0^2)
// so a measured inharmonicity plus a chosen tension *determines* the wire gauge,
// and the speaking length then follows. For a wound string the winding adds one
// more unknown, so the length is taken from the case instead and the wrap is
// solved to supply whatever mass is missing. Either way: no search.

import { MATERIALS, linearDensity, derive } from '../../src/dsp/physics.js';

const { E: Es, rho: rhos } = MATERIALS.steel;

/** Plain string: measured B + target tension -> core diameter and length. */
export function invertPlain(B, T, f0) {
  const d6 = (64 * B * T * T) / (Math.PI ** 4 * Es * rhos * f0 * f0);
  const d = Math.pow(d6, 1 / 6);
  const mu = rhos * Math.PI * (d / 2) ** 2;
  const L = Math.sqrt(T / mu) / (2 * f0);
  return { coreDiameterMm: d * 1e3, lengthM: L, wound: false, wrapOuterDiameterMm: 0 };
}

/** Wound string: measured B + target tension + a given length -> core and wrap. */
export function invertWound(B, T, f0, L) {
  // Core diameter straight from B, since only the core carries stiffness.
  const d = Math.pow((64 * B * T * L * L) / (Math.PI ** 3 * Es), 1 / 4);
  const muNeeded = T / Math.pow(2 * L * f0, 2);
  const rc = d / 2;
  const muCore = rhos * Math.PI * rc * rc;
  const need = muNeeded - muCore;
  if (need <= 0) return { ...invertPlain(B, T, f0), note: 'wrap not needed' };
  const wrap = MATERIALS.copper;
  const ro = Math.sqrt(need / (wrap.rho * Math.PI * 0.8) + rc * rc);
  return {
    coreDiameterMm: d * 1e3,
    lengthM: L,
    wound: true,
    wrapOuterDiameterMm: 2 * ro * 1e3,
  };
}

/** Round-trip check: does the inverted geometry actually reproduce B and f0? */
export function verifyInversion(spec, f0) {
  const phys = derive(spec, f0);
  return { B: phys.B, T: phys.T, mu: phys.mu };
}
