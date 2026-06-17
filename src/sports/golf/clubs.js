// Club definitions. Tuned alongside the realistic-aero physics model:
//   - maxPower is the initial ball speed (m/s) on a perfect strike. Real PGA driver
//     ball speeds are ~70-75 m/s, but with our dimpled-drag + spin-lift model that
//     would carry ~300m. We use lower numbers to land in golf-MVP territory.
//   - loft is launch angle (radians) — close to real lofts at impact (driver dynamic
//     loft ~10°, wedge ~50°).
//   - backspin (rad/s) is the baseline rotation about the perpendicular-to-flight
//     axis. The lift model uses spin ratio S = ω·r/v to compute Cl. Real values:
//     driver ~250 rad/s (~40 rev/s), wedge ~700 rad/s (~110 rev/s).
//   - forgiveness widens the "green" zone on the accuracy meter (0..1).
//   - sidespinScale magnifies fade/draw curve when the accuracy strike is offline.

const deg = (d) => (d * Math.PI) / 180;

// NOTE: recalibrated after measuring the actual aero model — the prior 53 m/s
// "ball speed" ballooned (23m apex) and only carried ~110m. Real driver ball speed
// is ~70 m/s; combined with lower backspin (flatter, more penetrating) these land
// the carries in realistic ranges. Measured full-power driver ≈ 230m after this.
export const clubs = [
  {
    name: 'Driver',
    loft: deg(11),
    maxPower: 76,        // ~230m carry, ~24m apex (penetrating tour-driver flight)
    forgiveness: 0.35,
    sidespinScale: 1.6,
    backspin: 220,       // ~35 rev/s — low spin for max carry; height comes from loft
  },
  {
    name: '5-Iron',
    loft: deg(20),
    maxPower: 58,        // ~180m
    forgiveness: 0.5,
    sidespinScale: 1.1,
    backspin: 340,
  },
  {
    name: '9-Iron',
    loft: deg(37),
    maxPower: 46,        // ~140m
    forgiveness: 0.65,
    sidespinScale: 0.9,
    backspin: 480,
  },
  {
    name: 'Wedge',
    loft: deg(52),
    maxPower: 40,        // ~95m, high apex, checks up
    forgiveness: 0.75,
    sidespinScale: 0.7,
    backspin: 620,
  },
  {
    name: 'Putter',
    loft: deg(4),
    maxPower: 12,        // ground-roll speed; engine treats putter shots as flat (isPutt flag)
    forgiveness: 0.9,
    sidespinScale: 0.1,
    backspin: 0,
  },
];

export function clubByName(name) {
  return clubs.find((c) => c.name === name) ?? clubs[0];
}
