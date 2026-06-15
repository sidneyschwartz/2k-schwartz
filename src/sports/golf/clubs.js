// Club definitions. Tuned alongside physics so a perfect driver carries ~230m, wedge ~80m.
// Loft is the launch angle in radians. maxPower is initial ball speed (m/s) on a perfect strike.
// forgiveness widens the "green" zone on the accuracy meter (0..1). sidespinScale magnifies
// curve when the accuracy strike is offline.

const deg = (d) => (d * Math.PI) / 180;

export const clubs = [
  {
    name: 'Driver',
    loft: deg(10.5),
    maxPower: 72,        // m/s ball speed -> ~230m carry on perfect strike
    forgiveness: 0.35,
    sidespinScale: 1.6,
    backspin: 60,        // rad/s baseline backspin (low for driver)
  },
  {
    name: '5-Iron',
    loft: deg(24),
    maxPower: 55,        // ~170m
    forgiveness: 0.5,
    sidespinScale: 1.1,
    backspin: 180,
  },
  {
    name: '9-Iron',
    loft: deg(42),
    maxPower: 42,        // ~120m
    forgiveness: 0.65,
    sidespinScale: 0.9,
    backspin: 320,
  },
  {
    name: 'Wedge',
    loft: deg(56),
    maxPower: 33,        // ~80m
    forgiveness: 0.75,
    sidespinScale: 0.7,
    backspin: 420,
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
