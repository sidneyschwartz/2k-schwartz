// Stylized low-poly golfers built from primitives. No external rig — bones are
// just nested THREE.Group nodes we tween between pose targets. The state machine
// drives a normalized animation clock per state.

import * as THREE from 'three';

const STATES = ['idle', 'address', 'backswing', 'downswing', 'follow', 'reset'];

const PRESETS = {
  tiger: {
    name: 'Tiger Woods',
    skin: 0x6b4a2b,
    shirt: 0xcc1822,        // Sunday red
    pants: 0x111111,
    shoes: 0xffffff,
    hat: 0x000000,
    beard: null,
    height: 1.83,
    build: 0.95,            // slimmer
    cap: 'visor',
  },
  brunson: {
    name: 'Jalen Brunson',
    skin: 0x8a5a3b,
    shirt: 0x1f6dd6,        // Knicks blue
    pants: 0xf5f5f5,
    shoes: 0x222222,
    hat: 0xf5731e,          // orange brim accent
    beard: 0x1a1a1a,
    height: 1.88,
    build: 1.12,            // stockier
    cap: 'cap',
  },
};

function mat(color, roughness = 0.7, metalness = 0.05) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

function buildClub() {
  const club = new THREE.Group();
  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(0.008, 0.008, 1.05, 8),
    mat(0xcfcfd4, 0.3, 0.9),
  );
  shaft.position.y = -0.5;
  shaft.castShadow = true;
  club.add(shaft);
  const head = new THREE.Mesh(
    new THREE.BoxGeometry(0.10, 0.05, 0.04),
    mat(0x222226, 0.4, 0.8),
  );
  head.position.set(0.05, -1.02, 0);
  head.castShadow = true;
  club.add(head);
  return club;
}

function buildGolfer(preset) {
  const root = new THREE.Group();
  root.name = `golfer-${preset.name}`;
  const scaleY = preset.height / 1.8;
  const scaleX = preset.build;

  // Torso pivot: rotates for swing. Hips group sits at ~waist height (1.0m * scale).
  const hips = new THREE.Group();
  hips.position.y = 1.0 * scaleY;
  root.add(hips);

  // Lower body (static relative to hips)
  const legL = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.09 * scaleX, 0.55 * scaleY, 4, 8),
    mat(preset.pants),
  );
  legL.position.set(-0.11 * scaleX, -0.35 * scaleY, 0);
  legL.castShadow = true;
  hips.add(legL);
  const legR = legL.clone();
  legR.position.x = 0.11 * scaleX;
  hips.add(legR);
  const shoeL = new THREE.Mesh(
    new THREE.BoxGeometry(0.12 * scaleX, 0.06, 0.22),
    mat(preset.shoes, 0.5),
  );
  shoeL.position.set(-0.11 * scaleX, -0.66 * scaleY, 0.03);
  shoeL.castShadow = true;
  hips.add(shoeL);
  const shoeR = shoeL.clone();
  shoeR.position.x = 0.11 * scaleX;
  hips.add(shoeR);

  // Torso (rotates for swing)
  const torsoPivot = new THREE.Group();
  hips.add(torsoPivot);

  const torso = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.22 * scaleX, 0.45 * scaleY, 4, 8),
    mat(preset.shirt),
  );
  torso.position.y = 0.30 * scaleY;
  torso.castShadow = true;
  torsoPivot.add(torso);

  // Neck + head
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.13 * scaleX, 20, 16),
    mat(preset.skin, 0.6),
  );
  head.position.y = 0.72 * scaleY;
  head.castShadow = true;
  torsoPivot.add(head);

  // Hat
  if (preset.cap === 'visor') {
    const visor = new THREE.Mesh(
      new THREE.CylinderGeometry(0.135 * scaleX, 0.135 * scaleX, 0.05, 16, 1, true),
      mat(preset.hat, 0.6),
    );
    visor.position.y = 0.80 * scaleY;
    head.add(visor);
    const brim = new THREE.Mesh(
      new THREE.CylinderGeometry(0.20 * scaleX, 0.20 * scaleX, 0.012, 24),
      mat(preset.hat, 0.6),
    );
    brim.position.set(0, 0.06 * scaleY, 0.06);
    visor.add(brim);
  } else {
    const cap = new THREE.Mesh(
      new THREE.SphereGeometry(0.14 * scaleX, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2),
      mat(preset.hat, 0.6),
    );
    cap.position.y = 0.78 * scaleY;
    head.add(cap);
    const brim = new THREE.Mesh(
      new THREE.BoxGeometry(0.28 * scaleX, 0.012, 0.10),
      mat(preset.hat, 0.6),
    );
    brim.position.set(0, 0.78 * scaleY, 0.13);
    head.add(brim);
  }

  // Beard
  if (preset.beard) {
    const beard = new THREE.Mesh(
      new THREE.SphereGeometry(0.10 * scaleX, 14, 10, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
      mat(preset.beard, 0.9),
    );
    beard.position.set(0, 0.69 * scaleY, 0.02);
    beard.scale.set(1, 0.7, 0.6);
    torsoPivot.add(beard);
  }

  // Shoulders -> arms. Both arms hang from a shoulder pivot we'll rotate together.
  const armsPivot = new THREE.Group();
  armsPivot.position.set(0, 0.55 * scaleY, 0);
  torsoPivot.add(armsPivot);

  function buildArm(side) {
    const grp = new THREE.Group();
    grp.position.set(0.22 * scaleX * side, 0, 0);
    const upper = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.055 * scaleX, 0.28 * scaleY, 4, 8),
      mat(preset.shirt),
    );
    upper.position.y = -0.16 * scaleY;
    upper.castShadow = true;
    grp.add(upper);
    const fore = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.05 * scaleX, 0.28 * scaleY, 4, 8),
      mat(preset.skin),
    );
    fore.position.y = -0.45 * scaleY;
    fore.castShadow = true;
    grp.add(fore);
    return grp;
  }
  const armL = buildArm(-1);
  const armR = buildArm(1);
  armsPivot.add(armL);
  armsPivot.add(armR);

  // Hands grip point (between forearms, slightly forward)
  const gripPivot = new THREE.Group();
  gripPivot.position.set(0, -0.60 * scaleY, 0.32);
  armsPivot.add(gripPivot);

  const club = buildClub();
  club.scale.setScalar(scaleY);
  gripPivot.add(club);

  return { root, hips, torsoPivot, armsPivot, gripPivot, club, scaleY };
}

// Pose targets per swing state (relative to neutral). Right-handed golfer; the
// model addresses ball in +Z, swings around Y, with club starting low (+Z, -Y).
const POSES = {
  idle:      { torsoY: 0, torsoX: 0, armsX: 0.05, gripX: 0,    clubRot: 0 },
  address:   { torsoY: 0.05, torsoX: 0.25, armsX: 0.55, gripX: 0, clubRot: 0 },
  backswing: { torsoY: -1.55, torsoX: 0.15, armsX: -1.2, gripX: 0, clubRot: -1.6 },
  downswing: { torsoY: 0.20, torsoX: 0.20, armsX: 0.70, gripX: 0, clubRot: 0.15 },
  follow:    { torsoY: 1.65, torsoX: 0.05, armsX: 1.30, gripX: 0, clubRot: 1.4 },
  reset:     { torsoY: 0, torsoX: 0, armsX: 0.05, gripX: 0,    clubRot: 0 },
};

// Per-state duration (seconds) and easing.
const TIMING = {
  idle:      { dur: Infinity, ease: 'linear' },
  address:   { dur: 0.4, ease: 'easeOut' },
  backswing: { dur: 0.7, ease: 'easeInOut' },
  downswing: { dur: 0.22, ease: 'easeIn' },
  follow:    { dur: 0.45, ease: 'easeOut' },
  reset:     { dur: 0.6, ease: 'easeInOut' },
};

function ease(t, kind) {
  if (kind === 'easeIn') return t * t;
  if (kind === 'easeOut') return 1 - (1 - t) * (1 - t);
  if (kind === 'easeInOut') return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  return t;
}

function lerp(a, b, t) { return a + (b - a) * t; }

function applyPose(parts, pose) {
  parts.torsoPivot.rotation.y = pose.torsoY;
  parts.torsoPivot.rotation.x = pose.torsoX;
  parts.armsPivot.rotation.x = pose.armsX;
  parts.gripPivot.rotation.x = pose.gripX;
  parts.club.rotation.x = pose.clubRot;
}

function lerpPose(from, to, t) {
  return {
    torsoY: lerp(from.torsoY, to.torsoY, t),
    torsoX: lerp(from.torsoX, to.torsoX, t),
    armsX:  lerp(from.armsX,  to.armsX,  t),
    gripX:  lerp(from.gripX,  to.gripX,  t),
    clubRot: lerp(from.clubRot, to.clubRot, t),
  };
}

export function createGolfer({ character = 'tiger' } = {}) {
  const preset = PRESETS[character] ?? PRESETS.tiger;
  const parts = buildGolfer(preset);

  let state = 'idle';
  let fromPose = { ...POSES.idle };
  let toPose = { ...POSES.idle };
  let elapsed = 0;
  let duration = TIMING.idle.dur;
  let easing = TIMING.idle.ease;
  let idleClock = 0;

  applyPose(parts, fromPose);

  function setSwingState(next) {
    if (!STATES.includes(next)) return;
    // capture current visual pose as "from"
    fromPose = {
      torsoY: parts.torsoPivot.rotation.y,
      torsoX: parts.torsoPivot.rotation.x,
      armsX: parts.armsPivot.rotation.x,
      gripX: parts.gripPivot.rotation.x,
      clubRot: parts.club.rotation.x,
    };
    toPose = POSES[next];
    duration = TIMING[next].dur;
    easing = TIMING[next].ease;
    elapsed = 0;
    state = next;
  }

  function update(dt) {
    if (!isFinite(dt) || dt <= 0) return;
    if (state === 'idle') {
      // light sway
      idleClock += dt;
      const sway = Math.sin(idleClock * 1.4) * 0.04;
      const bob = Math.sin(idleClock * 2.0) * 0.01;
      parts.torsoPivot.rotation.y = sway;
      parts.torsoPivot.rotation.x = 0.02 + bob;
      parts.armsPivot.rotation.x = 0.05 + Math.sin(idleClock * 1.4) * 0.02;
      return;
    }
    elapsed += dt;
    const raw = duration === Infinity ? 1 : Math.min(1, elapsed / duration);
    const t = ease(raw, easing);
    const cur = lerpPose(fromPose, toPose, t);
    applyPose(parts, cur);
  }

  return {
    group: parts.root,
    setSwingState,
    update,
    name: preset.name,
    character,
  };
}

export const CHARACTERS = Object.keys(PRESETS);
export const CHARACTER_PRESETS = PRESETS;
