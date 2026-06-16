// Per-hole heightfield. Given a hole's data and (x, z) world coords, returns the
// terrain height (m) at that point. The same height field is used by:
//   - terrain.js to displace plane vertices visually
//   - physics.js (Trimesh from the displaced verts) so collision matches what you see
//   - the greenBreakAt(x, z) gradient for putting break
//
// We deliberately keep the sampler PURE so a test can verify it: heightAt(x, z, hole)
// has no scene/render dependencies.

const TAU = Math.PI * 2;

// --- Deterministic 2D value-noise (no external deps) ---
//
// hash2 uses bit-fiddling on the integer cell coords + a per-hole seed so each hole
// gets its own unique landscape; smoothstep + bilerp gives a continuous field with
// no visible gridlines. Frequency is in cycles/meter — at 1/40 we get bumps roughly
// every 40m, which feels like fairway roll without being a minigolf course.

function hash2(ix, iz, seed) {
  let h = (ix | 0) * 374761393 + (iz | 0) * 668265263 + (seed | 0) * 2147483647;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295; // [0, 1)
}

function smoothstep(t) { return t * t * (3 - 2 * t); }

function valueNoise(x, z, seed) {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const n00 = hash2(ix,     iz,     seed);
  const n10 = hash2(ix + 1, iz,     seed);
  const n01 = hash2(ix,     iz + 1, seed);
  const n11 = hash2(ix + 1, iz + 1, seed);
  const sx = smoothstep(fx);
  const sz = smoothstep(fz);
  const a = n00 * (1 - sx) + n10 * sx;
  const b = n01 * (1 - sx) + n11 * sx;
  return a * (1 - sz) + b * sz; // [0, 1)
}

// Fractal noise (a few octaves of value-noise summed at decreasing weight) so
// the surface has gentle wide rolls layered with smaller bumps.
function fbm(x, z, seed) {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  for (let o = 0; o < 3; o++) {
    sum += amp * (valueNoise(x * freq, z * freq, seed + o * 17) * 2 - 1);
    norm += amp;
    amp *= 0.5;
    freq *= 2.1;
  }
  return sum / norm; // [-1, 1]
}

// --- Green contour: sum of radial Gaussian bumps per `contour: [...]` entry ---
//
// Each bump is { x, z, amp, sigma }. Bumps sum into a small (~0.3m) height
// modulation on top of the green's base elevation. The gradient of this field
// is what the green-break physics uses — putts curve toward the low side.

function gaussianBump(x, z, bx, bz, amp, sigma) {
  const dx = x - bx;
  const dz = z - bz;
  const r2 = dx * dx + dz * dz;
  const k = -1 / (2 * sigma * sigma);
  return amp * Math.exp(r2 * k);
}

// Public: terrain height at (x, z) for this hole. World units (meters).
//
// Composition:
//   1. Per-hole base roll (fairway humps): low-frequency fbm, amplitude from
//      hole.terrain?.amplitude (default 0.8m).
//   2. Per-region elevation: greens with an `elevation` field add a smooth radial
//      lift around the green center so they sit on a plateau (you can see the
//      raised green from the fairway).
//   3. Per-region contour: greens with a `contour: [{x,z,amp,sigma}, ...]` array
//      get summed Gaussian bumps for break.
//   4. Tee elevation: small lift if the tee region has elevation.
export function heightAt(x, z, holeData) {
  if (!holeData) return 0;

  const seed = holeData.terrain?.seed ?? holeData.number ?? 1;
  const ampBase = holeData.terrain?.amplitude ?? 0.8;
  // Sample base fbm at ~1/45m so bumps are ~45m wavelength: gentle roll, not minigolf.
  const baseRoll = ampBase * fbm(x / 45, z / 45, seed);

  let h = baseRoll;

  for (const r of holeData.regions || []) {
    if (r.type === 'green') {
      // Plateau: smooth radial lift inside green radius, falling off in a 1.3x ring.
      if (r.elevation && r.elevation !== 0) {
        const dx = x - r.x, dz = z - r.z;
        const d = Math.sqrt(dx * dx + dz * dz);
        const inner = r.r;
        const outer = r.r * 1.4;
        if (d < outer) {
          const t = d <= inner ? 1 : (1 - (d - inner) / (outer - inner));
          h += r.elevation * smoothstep(Math.max(0, t));
        }
      }
      // Contour bumps (break)
      if (Array.isArray(r.contour)) {
        for (const b of r.contour) {
          h += gaussianBump(x, z, b.x, b.z, b.amp ?? 0.15, b.sigma ?? 3);
        }
      }
    } else if (r.type === 'tee' && r.elevation) {
      // Localized lift around tee box
      const dx = x - r.x, dz = z - r.z;
      const r0 = Math.max(r.w ?? 4, r.d ?? 4) * 0.7;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d < r0 * 2) {
        const t = d <= r0 ? 1 : (1 - (d - r0) / r0);
        h += r.elevation * smoothstep(Math.max(0, t));
      }
    }
  }

  return h;
}

// Gradient of the green contour at (x, z). Used by the green-break physics
// (replaces the single global `setGreenSlope`). Returns world-frame acceleration
// (m/s²) along XZ that a slow-rolling ball "feels" — positive ax means downhill
// toward +X, etc. Magnitude is gravity-scaled so 0.1 means ~1% grade.
//
// Implementation: central-difference of heightAt restricted to the green's
// contour + plateau (excludes the base fbm, which the ball shouldn't roll on
// when it's at rest in the rough — that's handled by the static collision
// surface from terrain.js).
export function greenBreakAt(x, z, holeData) {
  if (!holeData) return { ax: 0, az: 0 };

  // Find the green the ball is on (if any).
  let onGreen = null;
  for (const r of holeData.regions || []) {
    if (r.type !== 'green') continue;
    const dx = x - r.x, dz = z - r.z;
    if (dx * dx + dz * dz <= (r.r ?? 0) ** 2) { onGreen = r; break; }
  }
  if (!onGreen) return { ax: 0, az: 0 };

  function greenH(px, pz) {
    let h = 0;
    if (onGreen.elevation) {
      const dx = px - onGreen.x, dz = pz - onGreen.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      const inner = onGreen.r;
      const outer = onGreen.r * 1.4;
      if (d < outer) {
        const t = d <= inner ? 1 : (1 - (d - inner) / (outer - inner));
        h += onGreen.elevation * smoothstep(Math.max(0, t));
      }
    }
    if (Array.isArray(onGreen.contour)) {
      for (const b of onGreen.contour) {
        h += gaussianBump(px, pz, b.x, b.z, b.amp ?? 0.15, b.sigma ?? 3);
      }
    }
    return h;
  }

  // Central difference, 0.5m step (~ a putt-length, gives smooth gradient).
  const eps = 0.5;
  const hx0 = greenH(x - eps, z);
  const hx1 = greenH(x + eps, z);
  const hz0 = greenH(x, z - eps);
  const hz1 = greenH(x, z + eps);

  // Downhill direction = -gradient. Scale by g so amplitude is acceleration (m/s²).
  // dh/dx ≈ (hx1 - hx0) / (2*eps). On a 1% grade dh/dx = 0.01 → a = g·sin(arctan(0.01)) ≈ 0.098 m/s².
  const g = 9.81;
  const dhdx = (hx1 - hx0) / (2 * eps);
  const dhdz = (hz1 - hz0) / (2 * eps);
  return { ax: -g * dhdx, az: -g * dhdz };
}
