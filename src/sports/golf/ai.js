// AI golfer for single-player vs CPU. Plans a shot based on remaining distance to pin,
// the current wind, the available clubs and a per-difficulty noise model.
//
//   const ai = createAiGolfer({ difficulty: 'pro', personaId: 'tiger-cpu', holeData, ballPos });
//   const shot = ai.planShot({ ballPos, wind });
//   // -> { club: ClubObj, power: 0..1, accuracyError: -1..1, aimYaw: rad }
//
// The shot shape matches what `launchShot` in golf.js consumes from the human swing
// controller, so the engine can run AI shots through the same physics path.

import { clubs as DEFAULT_CLUBS } from './clubs.js';

const DIFFICULTIES = {
  rookie: { powerJitter: 0.15, accuracyJitter: 0.30, aimJitter: 0.05, label: 'Rookie' },
  pro:    { powerJitter: 0.05, accuracyJitter: 0.10, aimJitter: 0.02, label: 'Pro' },
  tour:   { powerJitter: 0.02, accuracyJitter: 0.04, aimJitter: 0.008, label: 'Tour' },
};

// Two distinct CPU personas. Each has a default difficulty mapping so the lobby can
// offer "tiger-cpu (Tour)" / "brunson-cpu (Pro)" if desired — the engine still
// honors whatever `difficulty` the caller passes.
export const AI_PERSONAS = {
  'tiger-cpu': {
    id: 'tiger-cpu',
    characterId: 'tiger',
    name: 'Tiger CPU',
    defaultDifficulty: 'tour',
    persona: { aggression: 0.85, putt: 0.95 }, // shapes club-selection bias on long shots
  },
  'brunson-cpu': {
    id: 'brunson-cpu',
    characterId: 'brunson',
    name: 'Brunson CPU',
    defaultDifficulty: 'pro',
    persona: { aggression: 0.65, putt: 0.8 },
  },
};

export function listAiPersonas() {
  return Object.values(AI_PERSONAS);
}

export function listDifficulties() {
  return Object.entries(DIFFICULTIES).map(([id, d]) => ({ id, label: d.label }));
}

// Rough carry estimate (m) per club at 100% perfect strike. Matches the Phase 1
// tuning: Driver ~230, 5i ~170, 9i ~120, Wedge ~80, Putter ~6.
function clubCarry(club) {
  const v = club.maxPower;
  const loft = club.loft;
  return (v * v * Math.sin(2 * loft)) / 9.81;
}

// Pick the club whose ideal carry is closest to (or just over) the remaining
// distance. On very long shots, "aggressive" personas prefer the longer club even
// if the next-shorter would be more controllable.
function pickClub({ remainingDist, clubList, persona, onGreen }) {
  if (onGreen) return clubList.find((c) => c.name === 'Putter') ?? clubList[clubList.length - 1];
  let bestClub = clubList[0];
  let bestScore = Infinity;
  for (const c of clubList) {
    if (c.name === 'Putter') continue; // never tee off with the flat-stick
    const carry = clubCarry(c);
    const diff = Math.abs(carry - remainingDist);
    // Soft preference: prefer slightly-over (we can dial power down) more than under
    const score = diff + (carry < remainingDist ? 6 : 0);
    if (score < bestScore) { bestScore = score; bestClub = c; }
  }
  // Aggressive personas: if remaining > 150m, bias toward Driver
  if (persona?.aggression && remainingDist > 150 && persona.aggression > 0.75) {
    const driver = clubList.find((c) => c.name === 'Driver');
    if (driver && remainingDist > clubCarry(driver) * 0.55) bestClub = driver;
  }
  return bestClub;
}

function gauss(rng) {
  // Box-Muller. rng() returns [0,1).
  const u = 1 - rng();
  const v = 1 - rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

export function createAiGolfer({
  difficulty = 'pro',
  personaId = 'tiger-cpu',
  clubList = DEFAULT_CLUBS,
  holeData,
  rng = Math.random,
} = {}) {
  const diff = DIFFICULTIES[difficulty] ?? DIFFICULTIES.pro;
  const persona = AI_PERSONAS[personaId] ?? AI_PERSONAS['tiger-cpu'];

  const self = {};
  function planShot({ ballPos, wind }) {
    const hd = self.holeData ?? holeData;
    const pin = hd?.pin ?? { x: 0, z: 150 };
    const dx = pin.x - ballPos.x;
    const dz = pin.z - ballPos.z;
    const remaining = Math.sqrt(dx * dx + dz * dz);
    const baseYaw = Math.atan2(dx, dz);

    // Wind compensation: if wind has a crosswind component relative to the
    // shot direction, aim slightly into it. Headwind/tailwind we just adjust power.
    let powerScale = 1.0;
    let aimComp = 0;
    if (wind && wind.speed > 0) {
      const wx = Math.sin(wind.dir) * wind.speed;
      const wz = Math.cos(wind.dir) * wind.speed;
      // Decompose wind into along (toward pin) and across (perpendicular) the shot
      const ux = Math.sin(baseYaw);
      const uz = Math.cos(baseYaw);
      const along = wx * ux + wz * uz;         // +ve = tailwind
      const across = wx * uz - wz * ux;        // +ve = wind blowing ball to the right
      // Headwind hurts carry; add ~1% power per m/s headwind (cap at +20%)
      powerScale += clamp(-along * 0.012, -0.20, 0.20);
      // Cross: aim into the wind. Magnitude scales with how far the shot has to fly.
      aimComp = -across * 0.012;
    }

    const onGreen = remaining < 12; // anything inside ~12m we putt
    const club = pickClub({ remainingDist: remaining, clubList, persona: persona.persona, onGreen });

    // Target power: distance / clubCarry, scaled by wind. Putter is special: linear power
    // for the rolling distance (5m carry on full power -> distance fraction).
    let targetPower;
    if (club.name === 'Putter') {
      // Putter "carry" is the ground-roll distance for full power. Tune so 6m full power.
      targetPower = clamp(remaining / 6, 0.15, 1.0);
    } else {
      const carry = clubCarry(club);
      targetPower = clamp((remaining / carry) * powerScale, 0.3, 1.0);
    }

    // Noise (Gaussian, scaled by difficulty)
    const powerNoise = gauss(rng) * diff.powerJitter * 0.5; // half-sigma so ±jitter is ~2sigma range
    const accuracyError = clamp(gauss(rng) * diff.accuracyJitter * 0.5, -1, 1);
    const aimNoise = gauss(rng) * diff.aimJitter * 0.5;

    const power = clamp(targetPower + powerNoise, 0.1, 1.0);
    const aimYaw = aimComp + aimNoise; // relative to ball→pin baseline; engine adds baseYaw

    return { club, power, accuracyError, aimYaw, debug: { remaining, targetPower, powerScale, aimComp } };
  }

  Object.assign(self, {
    name: persona.name,
    persona: persona.persona,
    personaId: persona.id,
    characterId: persona.characterId,
    difficulty,
    difficultyLabel: diff.label,
    holeData,
    planShot,
  });
  return self;
}
