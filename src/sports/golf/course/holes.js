// 18-hole course data. Each hole defines tee, pin, terrain regions, and hazards.
// Coordinates are in meters. +Z points from tee to pin by convention.
// Engine consumes this to build geometry; art agent applies materials by surfaceType.

// Par layout — front 9: 3,4,5,4,3,4,5,4,3 = 35.  back 9: 4,5,3,4,4,4,5,3,5 = 37.  total = 72.

export const HOLES = [
  // ============ FRONT 9 ============
  {
    number: 1, par: 3, name: 'Lakeside',
    description: 'Short island green over water. Pin near front — don\'t be long.',
    tee: { x: 0, z: 0 }, pin: { x: 0, z: 145 }, yardage: 158,
    wind: { speed: 4, dir: 0.2 },
    regions: [
      { type: 'tee',     shape: 'rect',   x: 0, z: 0,   w: 6,  d: 4  },
      { type: 'water',   shape: 'rect',   x: 0, z: 70,  w: 60, d: 80 },
      { type: 'fairway', shape: 'circle', x: 0, z: 145, r: 22 },
      { type: 'green',   shape: 'circle', x: 0, z: 145, r: 11 },
      { type: 'rough',   shape: 'ring',   x: 0, z: 145, r: 22, r2: 28 },
    ],
  },
  {
    number: 2, par: 4, name: 'Doglegs Right',
    description: 'Bend right around a bunker complex. Driver carries the corner if pure.',
    tee: { x: 0, z: 0 }, pin: { x: 60, z: 330 }, yardage: 405,
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
      { type: 'rough',   shape: 'fill' },
    ],
  },
  {
    number: 3, par: 5, name: 'Long Climb',
    description: 'Reachable in two if you bomb it. Risk-reward elevated green with bunkers right.',
    tee: { x: 0, z: 0 }, pin: { x: -10, z: 520 }, yardage: 562,
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
  {
    number: 4, par: 4, name: 'Birch Bend',
    description: 'Tree-lined fairway with a gentle left bend. Find the short grass.',
    tee: { x: 0, z: 0 }, pin: { x: -30, z: 360 }, yardage: 395,
    wind: { speed: 2, dir: 3.0 },
    regions: [
      { type: 'tee',     shape: 'rect',   x: 0, z: 0, w: 6, d: 4 },
      { type: 'fairway', shape: 'spline', points: [
        { x: 0, z: 10, w: 26 }, { x: -6, z: 130, w: 28 },
        { x: -18, z: 240, w: 26 }, { x: -30, z: 360, w: 26 }
      ]},
      { type: 'sand',    shape: 'circle', x: -36, z: 360, r: 8 },
      { type: 'sand',    shape: 'circle', x: -22, z: 350, r: 7 },
      { type: 'green',   shape: 'circle', x: -30, z: 360, r: 12 },
      { type: 'rough',   shape: 'fill' },
    ],
  },
  {
    number: 5, par: 3, name: 'Cliff Drop',
    description: 'Drop-shot par 3 over rocks. Wind makes the club selection a guessing game.',
    tee: { x: 0, z: 0 }, pin: { x: 0, z: 175 }, yardage: 191,
    wind: { speed: 7, dir: 2.6 },
    regions: [
      { type: 'tee',     shape: 'rect',   x: 0, z: 0, w: 6, d: 4 },
      { type: 'rough',   shape: 'rect',   x: 0, z: 90, w: 80, d: 80 },
      { type: 'green',   shape: 'circle', x: 0, z: 175, r: 13 },
      { type: 'sand',    shape: 'circle', x: -12, z: 170, r: 6 },
      { type: 'rough',   shape: 'fill' },
    ],
  },
  {
    number: 6, par: 4, name: 'Long Iron',
    description: 'Mid-length hole. Long iron in if you find the fairway.',
    tee: { x: 0, z: 0 }, pin: { x: 5, z: 410 }, yardage: 448,
    wind: { speed: 4, dir: 0.5 },
    regions: [
      { type: 'tee',     shape: 'rect',   x: 0, z: 0, w: 6, d: 4 },
      { type: 'fairway', shape: 'spline', points: [
        { x: 0, z: 10, w: 28 }, { x: 2, z: 220, w: 30 }, { x: 5, z: 410, w: 28 }
      ]},
      { type: 'sand',    shape: 'circle', x: -10, z: 400, r: 7 },
      { type: 'sand',    shape: 'circle', x: 18, z: 405, r: 6 },
      { type: 'green',   shape: 'circle', x: 5, z: 410, r: 12 },
      { type: 'rough',   shape: 'fill' },
    ],
  },
  {
    number: 7, par: 5, name: 'The Snake',
    description: 'S-shaped fairway through pine trees. Three good shots needed.',
    tee: { x: 0, z: 0 }, pin: { x: 0, z: 540 }, yardage: 591,
    wind: { speed: 5, dir: 1.8 },
    regions: [
      { type: 'tee',     shape: 'rect',   x: 0, z: 0, w: 6, d: 4 },
      { type: 'fairway', shape: 'spline', points: [
        { x: 0, z: 10, w: 26 }, { x: 20, z: 150, w: 26 },
        { x: -20, z: 320, w: 26 }, { x: 10, z: 460, w: 26 },
        { x: 0, z: 540, w: 28 }
      ]},
      { type: 'sand',    shape: 'circle', x: -8, z: 530, r: 8 },
      { type: 'sand',    shape: 'circle', x: 10, z: 530, r: 7 },
      { type: 'green',   shape: 'circle', x: 0, z: 540, r: 13 },
      { type: 'rough',   shape: 'fill' },
    ],
  },
  {
    number: 8, par: 4, name: 'Sand Lake',
    description: 'Sandy waste area runs along the right. Bail left, take your medicine.',
    tee: { x: 0, z: 0 }, pin: { x: -8, z: 385 }, yardage: 420,
    wind: { speed: 5, dir: 2.0 },
    regions: [
      { type: 'tee',     shape: 'rect',   x: 0, z: 0, w: 6, d: 4 },
      { type: 'fairway', shape: 'spline', points: [
        { x: 0, z: 10, w: 28 }, { x: -3, z: 200, w: 26 }, { x: -8, z: 385, w: 24 }
      ]},
      { type: 'sand',    shape: 'rect',   x: 25, z: 250, w: 24, d: 250 },
      { type: 'sand',    shape: 'circle', x: -14, z: 375, r: 7 },
      { type: 'green',   shape: 'circle', x: -8, z: 385, r: 11 },
      { type: 'rough',   shape: 'fill' },
    ],
  },
  {
    number: 9, par: 3, name: 'Sunday Sunday',
    description: 'Quick punch par 3 to finish the front nine. Soft greens.',
    tee: { x: 0, z: 0 }, pin: { x: 0, z: 142 }, yardage: 155,
    wind: { speed: 2, dir: 0.0 },
    regions: [
      { type: 'tee',     shape: 'rect',   x: 0, z: 0, w: 6, d: 4 },
      { type: 'green',   shape: 'circle', x: 0, z: 142, r: 14 },
      { type: 'sand',    shape: 'circle', x: -10, z: 138, r: 5 },
      { type: 'sand',    shape: 'circle', x: 12, z: 140, r: 5 },
      { type: 'rough',   shape: 'fill' },
    ],
  },

  // ============ BACK 9 ============
  {
    number: 10, par: 4, name: 'Bridge',
    description: 'Drive over a creek. Lay up to 100 yards if you don\'t fancy the carry.',
    tee: { x: 0, z: 0 }, pin: { x: 0, z: 375 }, yardage: 410,
    wind: { speed: 3, dir: 0.4 },
    regions: [
      { type: 'tee',     shape: 'rect',   x: 0, z: 0, w: 6, d: 4 },
      { type: 'water',   shape: 'rect',   x: 0, z: 220, w: 80, d: 18 },
      { type: 'fairway', shape: 'spline', points: [
        { x: 0, z: 10, w: 28 }, { x: 0, z: 190, w: 28 },
        { x: 0, z: 260, w: 28 }, { x: 0, z: 375, w: 26 }
      ]},
      { type: 'green',   shape: 'circle', x: 0, z: 375, r: 12 },
      { type: 'rough',   shape: 'fill' },
    ],
  },
  {
    number: 11, par: 5, name: 'Up The Hill',
    description: 'Uphill three-shotter to a perched green. Club up for every shot.',
    tee: { x: 0, z: 0 }, pin: { x: 4, z: 530 }, yardage: 575,
    wind: { speed: 4, dir: 3.1 },
    regions: [
      { type: 'tee',     shape: 'rect',   x: 0, z: 0, w: 6, d: 4 },
      { type: 'fairway', shape: 'spline', points: [
        { x: 0, z: 10, w: 28 }, { x: 2, z: 250, w: 28 }, { x: 4, z: 530, w: 24 }
      ]},
      { type: 'sand',    shape: 'circle', x: -8, z: 525, r: 7 },
      { type: 'sand',    shape: 'circle', x: 12, z: 525, r: 7 },
      { type: 'green',   shape: 'circle', x: 4, z: 530, r: 12, elevation: 2.0 },
      { type: 'rough',   shape: 'fill' },
    ],
  },
  {
    number: 12, par: 3, name: 'Heartbreaker',
    description: 'Long iron par 3 with bunkers everywhere. Hard 4 ain\'t bad.',
    tee: { x: 0, z: 0 }, pin: { x: 0, z: 215 }, yardage: 235,
    wind: { speed: 6, dir: 1.0 },
    regions: [
      { type: 'tee',     shape: 'rect',   x: 0, z: 0, w: 6, d: 4 },
      { type: 'green',   shape: 'circle', x: 0, z: 215, r: 12 },
      { type: 'sand',    shape: 'circle', x: -12, z: 210, r: 7 },
      { type: 'sand',    shape: 'circle', x: 12, z: 210, r: 7 },
      { type: 'sand',    shape: 'circle', x: 0, z: 224, r: 6 },
      { type: 'rough',   shape: 'fill' },
    ],
  },
  {
    number: 13, par: 4, name: 'Long Carry',
    description: 'A wide-open driving hole. Distance helps; accuracy still rules.',
    tee: { x: 0, z: 0 }, pin: { x: 0, z: 430 }, yardage: 470,
    wind: { speed: 2, dir: 0.0 },
    regions: [
      { type: 'tee',     shape: 'rect',   x: 0, z: 0, w: 6, d: 4 },
      { type: 'fairway', shape: 'spline', points: [
        { x: 0, z: 10, w: 32 }, { x: 0, z: 230, w: 34 }, { x: 0, z: 430, w: 28 }
      ]},
      { type: 'green',   shape: 'circle', x: 0, z: 430, r: 13 },
      { type: 'sand',    shape: 'circle', x: -14, z: 425, r: 6 },
      { type: 'rough',   shape: 'fill' },
    ],
  },
  {
    number: 14, par: 4, name: 'Switchback',
    description: 'Sharp left dogleg. Cut the corner or play safe down the right.',
    tee: { x: 0, z: 0 }, pin: { x: -50, z: 360 }, yardage: 395,
    wind: { speed: 3, dir: 4.2 },
    regions: [
      { type: 'tee',     shape: 'rect',   x: 0, z: 0, w: 6, d: 4 },
      { type: 'fairway', shape: 'spline', points: [
        { x: 0, z: 10, w: 26 }, { x: -4, z: 140, w: 26 },
        { x: -22, z: 240, w: 26 }, { x: -50, z: 360, w: 28 }
      ]},
      { type: 'water',   shape: 'rect',   x: -10, z: 200, w: 18, d: 60 },
      { type: 'sand',    shape: 'circle', x: -56, z: 360, r: 7 },
      { type: 'green',   shape: 'circle', x: -50, z: 360, r: 12 },
      { type: 'rough',   shape: 'fill' },
    ],
  },
  {
    number: 15, par: 4, name: 'Forest Run',
    description: 'Trees flanking a narrow fairway. Find the short grass — punch out if not.',
    tee: { x: 0, z: 0 }, pin: { x: 0, z: 385 }, yardage: 421,
    wind: { speed: 1, dir: 0.0 },
    regions: [
      { type: 'tee',     shape: 'rect',   x: 0, z: 0, w: 6, d: 4 },
      { type: 'fairway', shape: 'spline', points: [
        { x: 0, z: 10, w: 22 }, { x: 0, z: 200, w: 20 }, { x: 0, z: 385, w: 24 }
      ]},
      { type: 'green',   shape: 'circle', x: 0, z: 385, r: 11 },
      { type: 'sand',    shape: 'circle', x: 10, z: 380, r: 6 },
      { type: 'rough',   shape: 'fill' },
    ],
  },
  {
    number: 16, par: 5, name: 'Skydive',
    description: 'Downhill par 5. Long hitters can find the green in two with the right wind.',
    tee: { x: 0, z: 0 }, pin: { x: -6, z: 510 }, yardage: 558,
    wind: { speed: 7, dir: 0.1 },
    regions: [
      { type: 'tee',     shape: 'rect',   x: 0, z: 0, w: 6, d: 4 },
      { type: 'fairway', shape: 'spline', points: [
        { x: 0, z: 10, w: 30 }, { x: -2, z: 260, w: 30 }, { x: -6, z: 510, w: 28 }
      ]},
      { type: 'sand',    shape: 'circle', x: 12, z: 380, r: 12 },
      { type: 'sand',    shape: 'circle', x: -12, z: 505, r: 8 },
      { type: 'green',   shape: 'circle', x: -6, z: 510, r: 13 },
      { type: 'rough',   shape: 'fill' },
    ],
  },
  {
    number: 17, par: 3, name: 'Island Tee',
    description: 'TPC-style island green. Aim center, take the par.',
    tee: { x: 0, z: 0 }, pin: { x: 0, z: 132 }, yardage: 144,
    wind: { speed: 5, dir: 1.5 },
    regions: [
      { type: 'tee',     shape: 'rect',   x: 0, z: 0, w: 6, d: 4 },
      { type: 'water',   shape: 'rect',   x: 0, z: 70,  w: 80, d: 90 },
      { type: 'fairway', shape: 'circle', x: 0, z: 132, r: 20 },
      { type: 'green',   shape: 'circle', x: 0, z: 132, r: 12 },
      { type: 'rough',   shape: 'ring',   x: 0, z: 132, r: 20, r2: 25 },
    ],
  },
  {
    number: 18, par: 5, name: 'Home',
    description: 'Closing par 5. Risk-reward with water down the entire left side.',
    tee: { x: 0, z: 0 }, pin: { x: 8, z: 545 }, yardage: 593,
    wind: { speed: 4, dir: 2.8 },
    regions: [
      { type: 'tee',     shape: 'rect',   x: 0, z: 0, w: 6, d: 4 },
      { type: 'fairway', shape: 'spline', points: [
        { x: 0, z: 10, w: 28 }, { x: 4, z: 250, w: 28 }, { x: 8, z: 545, w: 28 }
      ]},
      { type: 'water',   shape: 'rect',   x: -28, z: 280, w: 22, d: 280 },
      { type: 'sand',    shape: 'circle', x: 18, z: 540, r: 8 },
      { type: 'sand',    shape: 'circle', x: -2, z: 540, r: 8 },
      { type: 'green',   shape: 'circle', x: 8, z: 545, r: 14 },
      { type: 'rough',   shape: 'fill' },
    ],
  },
];

// Back-compat alias for any module that imported the old name.
export const DEMO_HOLES = HOLES.slice(0, 3);

export function getHole(n) {
  return HOLES.find((h) => h.number === n) ?? HOLES[0];
}

export function holeCount() { return HOLES.length; }

export function coursePar() {
  return HOLES.reduce((sum, h) => sum + h.par, 0);
}
