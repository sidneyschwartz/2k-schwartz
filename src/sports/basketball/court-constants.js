// ============================================================================
//  Shared half-court geometry — the SINGLE SOURCE OF TRUTH.
//  Imported by court, hoop, physics, rules, AI, and the camera so a "take it
//  back" clear, a make-sensor, and the painted arc all agree on the same
//  numbers. Never duplicate these magic values — a mismatch soft-locks the
//  clear-the-arc rule (Roadmap risk #6).
//
//  Coordinate frame (right-handed, Three.js Y-up):
//    +X = across the court (right),  +Y = up,  +Z = from the baseline out
//    toward the top of the key (where the offense brings the ball back).
//    The basket sits near Z=0; players operate in positive Z.
//  Units: meters. Hoop height is a real 3.05 m (10 ft).
// ============================================================================

// --- Hoop ---------------------------------------------------------------
export const RIM_HEIGHT = 3.05;          // 10 ft
export const RIM_RADIUS = 0.2286;        // 18" diameter rim
export const RIM_OVERHANG = 1.6;         // rim center distance from the baseline (Z)
export const BALL_RADIUS = 0.12;         // ~24 cm men's ball

// Rim center in world space. Everything hoop-related hangs off this.
export const HOOP_CENTER = { x: 0, y: RIM_HEIGHT, z: RIM_OVERHANG };

// The point on the floor directly under the rim — the origin for all
// "distance to basket" / arc tests.
export const HOOP_GROUND = { x: 0, z: RIM_OVERHANG };

export const BACKBOARD = {
  width: 1.83,                            // 6 ft
  height: 1.07,                           // 3.5 ft
  z: 1.2,                                 // backboard plane (closer to baseline than rim)
  bottom: 2.90,                           // bottom edge height
};

// --- Court bounds & markings -------------------------------------------
export const ARC_RADIUS = 6.75;          // 3-pt arc (FIBA) — beyond this = a "2", inside = a "1"
export const COURT = {
  minX: -7.5, maxX: 7.5,                  // sidelines
  minZ: 0,                                // baseline (behind the hoop)
  maxZ: 14,                               // half-court line
};

// Where the ball is checked / where the offense must clear back to on a change
// of possession. Top of the key, comfortably behind the arc.
export const CHECK_SPOT = { x: 0, y: 0, z: HOOP_GROUND.z + 7.0 }; // z = 8.6

// --- Placeholder visual palette (Milestone 0; art pass retunes in M7) ---
export const PALETTE = {
  sky: 0x9fb9d6,
  asphalt: 0x35383d,
  line: 0xe8e2d0,
  rim: 0xe8622a,
  backboard: 0xf2f4f8,
  pole: 0x4a4d52,
};
