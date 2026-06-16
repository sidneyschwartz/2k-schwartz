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

export const clubs = [
  {
    name: 'Driver',
    loft: deg(10.5),
    maxPower: 53,        // m/s ball speed -> ~230m carry with lift model
    forgiveness: 0.35,
    sidespinScale: 1.6,
    backspin: 264,       // ~42 rev/s — low spin keeps trajectory penetrating
  },
  {
    name: '5-Iron',
    loft: deg(22),
    maxPower: 45,        // ~170m
    forgiveness: 0.5,
    sidespinScale: 1.1,
    backspin: 420,       // ~67 rev/s
  },
  {
    name: '9-Iron',
    loft: deg(38),
    maxPower: 36,        // ~120m
    forgiveness: 0.65,
    sidespinScale: 0.9,
    backspin: 600,       // ~95 rev/s
  },
  {
    name: 'Wedge',
    loft: deg(52),
    maxPower: 28,        // ~80m, high apex
    forgiveness: 0.75,
    sidespinScale: 0.7,
    backspin: 720,       // ~115 rev/s — checks up on the green
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
