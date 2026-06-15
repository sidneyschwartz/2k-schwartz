// Surface-specific shot modifiers. Consumed by golf.js — given a lie type, returns
// scalars and tags that shape the shot leaving impact and the ball's behavior after
// landing. water/oob are sentinels for the engine's penalty/drop flow; their modifier
// blocks aren't applied to a real shot.

export const LIE_LABELS = {
  tee: 'Tee',
  fairway: 'Fairway',
  rough: 'Rough',
  sand: 'Sand',
  green: 'Green',
  water: 'Water',
  oob: 'Out of bounds',
};

const MODIFIERS = {
  tee:     { powerMul: 1.00, spinMul: 1.0, loftBias: 0.00, frictionTag: 'fairway', rollMul: 1.00, description: 'Clean strike — full power and spin.' },
  fairway: { powerMul: 1.00, spinMul: 1.0, loftBias: 0.00, frictionTag: 'fairway', rollMul: 1.00, description: 'Clean strike — full power and spin.' },
  rough:   { powerMul: 0.75, spinMul: 0.5, loftBias: 0.02, frictionTag: 'rough',   rollMul: 0.55, description: 'Flier from the rough — less spin, less roll.' },
  sand:    { powerMul: 0.55, spinMul: 0.4, loftBias: 0.08, frictionTag: 'rough',   rollMul: 0.25, description: 'Buried lie — explosion shot, plugs on landing.' },
  green:   { powerMul: 1.00, spinMul: 1.0, loftBias: 0.00, frictionTag: 'fairway', rollMul: 1.00, description: 'Pure contact off the cut — putting handled separately.' },
  // Penalty-zone sentinels. Real values don't get applied; engine takes the stroke + drop path.
  water:   { powerMul: 0.00, spinMul: 0.0, loftBias: 0.00, frictionTag: 'fairway', rollMul: 0.00, description: 'Water hazard — drop with a one-stroke penalty.' },
  oob:     { powerMul: 0.00, spinMul: 0.0, loftBias: 0.00, frictionTag: 'fairway', rollMul: 0.00, description: 'Out of bounds — re-tee with a one-stroke penalty.' },
};

export function shotModifiers(lie) {
  return MODIFIERS[lie] ?? MODIFIERS.fairway;
}
