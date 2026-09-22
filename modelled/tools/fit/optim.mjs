/** Nelder-Mead simplex. Derivative-free, which is what we need: the objective
 *  runs a renderer and a peak tracker, so there is no gradient to be had. */
export function nelderMead(f, x0, opts = {}) {
  const n = x0.length;
  const step = opts.step ?? x0.map((v) => (Math.abs(v) > 1e-9 ? 0.12 * Math.abs(v) : 0.12));
  const maxIter = opts.maxIter ?? 250;
  const tol = opts.tol ?? 1e-7;
  const lo = opts.lo ?? x0.map(() => -Infinity);
  const hi = opts.hi ?? x0.map(() => Infinity);
  const clamp = (v) => v.map((x, i) => Math.min(hi[i], Math.max(lo[i], x)));

  let simplex = [{ x: clamp(x0.slice()), v: f(clamp(x0.slice())) }];
  for (let i = 0; i < n; i++) {
    const p = x0.slice();
    p[i] += Array.isArray(step) ? step[i] : step;
    const c = clamp(p);
    simplex.push({ x: c, v: f(c) });
  }

  const centroid = (pts) => {
    const c = new Array(n).fill(0);
    for (const p of pts) for (let i = 0; i < n; i++) c[i] += p.x[i] / pts.length;
    return c;
  };

  for (let it = 0; it < maxIter; it++) {
    simplex.sort((a, b) => a.v - b.v);
    if (Math.abs(simplex[n].v - simplex[0].v) < tol * (Math.abs(simplex[0].v) + tol)) break;
    const best = simplex[0], worst = simplex[n];
    const c = centroid(simplex.slice(0, n));
    const move = (t) => clamp(c.map((ci, i) => ci + t * (ci - worst.x[i])));

    const refl = move(1), rv = f(refl);
    if (rv < best.v) {
      const exp = move(2), ev = f(exp);
      simplex[n] = ev < rv ? { x: exp, v: ev } : { x: refl, v: rv };
    } else if (rv < simplex[n - 1].v) {
      simplex[n] = { x: refl, v: rv };
    } else {
      const con = move(-0.5), cv = f(con);
      if (cv < worst.v) simplex[n] = { x: con, v: cv };
      else {
        for (let i = 1; i <= n; i++) {
          const x = clamp(simplex[i].x.map((xi, j) => best.x[j] + 0.5 * (xi - best.x[j])));
          simplex[i] = { x, v: f(x) };
        }
      }
    }
  }
  simplex.sort((a, b) => a.v - b.v);
  return { x: simplex[0].x, value: simplex[0].v };
}
