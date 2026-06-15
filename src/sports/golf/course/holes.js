// 3-hole demo course data. Each hole defines tee, pin, terrain regions, and hazards.
// Coordinates are in meters. +Z points from tee to pin by convention.
// Engine consumes this to build geometry; art agent applies materials by surfaceType.

export const DEMO_HOLES = [
  {
    number: 1,
    par: 3,
    name: 'Lakeside',
    description: 'Short island green over water. Pin near front — don\'t be long.',
    tee: { x: 0, z: 0 },
    pin: { x: 0, z: 145 },
    yardage: 158,
    wind: { speed: 4, dir: 0.2 }, // m/s, radians (0 = with player, π = headwind)
    regions: [
      { type: 'tee',     shape: 'rect',   x: 0, z: 0,   w: 6,  d: 4  },
      { type: 'water',   shape: 'rect',   x: 0, z: 70,  w: 60, d: 80 },
      { type: 'fairway', shape: 'circle', x: 0, z: 145, r: 22 }, // island
      { type: 'green',   shape: 'circle', x: 0, z: 145, r: 11 },
      { type: 'rough',   shape: 'ring',   x: 0, z: 145, r: 22, r2: 28 },
    ],
  },
  {
    number: 2,
    par: 4,
    name: 'Doglegs Right',
    description: 'Bend right around a bunker complex. Driver carries the corner if pure.',
    tee: { x: 0, z: 0 },
    pin: { x: 60, z: 330 },
    yardage: 405,
    wind: { speed: 6, dir: 1.2 },
    regions: [
      { type: 'tee',     shape: 'rect',   x: 0, z: 0,   w: 6,  d: 4  },
      { type: 'fairway', shape: 'spline', points: [
        { x: 0, z: 10, w: 26 }, { x: 0, z: 100, w: 28 },
        { x: 12, z: 180, w: 26 }, { x: 40, z: 240, w: 24 },
        { x: 60, z: 330, w: 30 }
      ]},
      { type: 'sand',    shape: 'circle', x: -8, z: 180, r: 12 },
      { type: 'sand',    shape: 'circle', x: 6,  z: 215, r: 10 },
      { type: 'sand',    shape: 'circle', x: 50, z: 310, r: 8 },
      { type: 'green',   shape: 'circle', x: 60, z: 330, r: 13 },
      { type: 'rough',   shape: 'fill' }, // implicit: everything-not-otherwise-colored
    ],
  },
  {
    number: 3,
    par: 5,
    name: 'Long Climb',
    description: 'Reachable in two if you bomb it. Risk-reward elevated green with bunkers right.',
    tee: { x: 0, z: 0 },
    pin: { x: -10, z: 520 },
    yardage: 562,
    wind: { speed: 3, dir: 0.0 },
    regions: [
      { type: 'tee',     shape: 'rect',   x: 0, z: 0,   w: 6,  d: 4  },
      { type: 'fairway', shape: 'spline', points: [
        { x: 0, z: 10, w: 28 }, { x: 0, z: 200, w: 32 },
        { x: -4, z: 350, w: 28 }, { x: -10, z: 520, w: 22 }
      ]},
      { type: 'sand',    shape: 'circle', x: 8,   z: 240, r: 14 },
      { type: 'sand',    shape: 'circle', x: 6,   z: 510, r: 10 },
      { type: 'sand',    shape: 'circle', x: 0,   z: 510, r: 8 },
      { type: 'water',   shape: 'rect',   x: -28, z: 480, w: 25, d: 40 },
      { type: 'green',   shape: 'circle', x: -10, z: 520, r: 14, elevation: 1.5 },
      { type: 'rough',   shape: 'fill' },
    ],
  },
];

export function getHole(n) {
  return DEMO_HOLES.find((h) => h.number === n) ?? DEMO_HOLES[0];
}
