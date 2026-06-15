// Humanoid golfers built procedurally with anatomically-correct proportions and
// jointed limbs. Each character is a hierarchy of THREE.Group "bones" we drive
// via direct rotation tweens; no GLB / skeletal rigging needed.
//
// Proportions roughly match 7-8 head-heights: head ≈ 1/7 of total height,
// shoulder span ≈ 2 head-widths, arm reach to mid-thigh, legs ≈ 50% of height.
//
// Exports kept stable for callers (engine + character-select):
//   createGolfer({ character }) -> { group, setSwingState(state), update(dt), name, character }

import * as THREE from 'three';

const STATES = ['idle', 'address', 'backswing', 'downswing', 'follow', 'reset'];

const PRESETS = {
  tiger: {
    name: 'Tiger Woods',
    skin: 0x4f3621,
    skinShadow: 0x3a2616,
    hair: 0x111111,
    shirt: 0xcc1822,        // Sunday red
    shirtCollar: 0xa3121a,
    pants: 0x141414,
    belt: 0x000000,
    shoes: 0xf2f2f2,
    shoeSole: 0x111111,
    hat: 0x000000,
    hatLogo: 0xffffff,
    beard: null,
    eyeWhite: 0xefe8d4,
    eyeIris: 0x2a1a0e,
    lips: 0x6b3a2b,
    height: 1.85,
    build: 0.96,
    cap: 'cap',             // changed: real Tiger uses a Nike cap
    chest: 1.0,
    shoulderWidth: 1.0,
  },
  brunson: {
    name: 'Jalen Brunson',
    skin: 0x7a5236,
    skinShadow: 0x5a3a26,
    hair: 0x0e0e0e,
    shirt: 0x1f6dd6,        // Knicks blue
    shirtCollar: 0xff5f1a,  // Knicks orange
    pants: 0xeeeeee,
    belt: 0x101010,
    shoes: 0x111111,
    shoeSole: 0xeeeeee,
    hat: null,              // no hat
    hatLogo: null,
    beard: 0x1a1a1a,
    eyeWhite: 0xeee6cf,
    eyeIris: 0x2a1c10,
    lips: 0x7a4634,
    height: 1.88,
    build: 1.12,            // stockier
    cap: 'none',
    chest: 1.15,
    shoulderWidth: 1.10,
  },
};

function mat(color, roughness = 0.7, metalness = 0.0) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

// ---------- procedural face texture for the head ----------

function makeFaceTexture(preset) {
  const size = 256;
  const c = (typeof OffscreenCanvas !== 'undefined')
    ? new OffscreenCanvas(size, size)
    : Object.assign(document.createElement('canvas'), { width: size, height: size });
  const ctx = c.getContext('2d');

  // Skin base
  ctx.fillStyle = '#' + preset.skin.toString(16).padStart(6, '0');
  ctx.fillRect(0, 0, size, size);

  // Subtle shading on sides
  const grad = ctx.createLinearGradient(0, 0, size, 0);
  const shadow = '#' + preset.skinShadow.toString(16).padStart(6, '0');
  grad.addColorStop(0, shadow);
  grad.addColorStop(0.3, '#' + preset.skin.toString(16).padStart(6, '0'));
  grad.addColorStop(0.7, '#' + preset.skin.toString(16).padStart(6, '0'));
  grad.addColorStop(1, shadow);
  ctx.fillStyle = grad;
  ctx.globalAlpha = 0.45;
  ctx.fillRect(0, 0, size, size);
  ctx.globalAlpha = 1;

  // Face area is the front of the sphere ≈ centered around u=0.5, v=0.5.
  // Sphere UV maps so that the face occupies roughly the central third.
  const cx = size * 0.5, cy = size * 0.5;

  // Eyebrows
  ctx.fillStyle = '#' + preset.hair.toString(16).padStart(6, '0');
  ctx.fillRect(cx - 28, cy - 30, 18, 4);
  ctx.fillRect(cx + 10, cy - 30, 18, 4);

  // Eye sockets (slightly darker skin)
  ctx.fillStyle = shadow;
  ctx.beginPath(); ctx.ellipse(cx - 18, cy - 18, 11, 6, 0, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(cx + 18, cy - 18, 11, 6, 0, 0, Math.PI * 2); ctx.fill();

  // Eye whites
  ctx.fillStyle = '#' + preset.eyeWhite.toString(16).padStart(6, '0');
  ctx.beginPath(); ctx.ellipse(cx - 18, cy - 18, 8, 4, 0, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(cx + 18, cy - 18, 8, 4, 0, 0, Math.PI * 2); ctx.fill();

  // Irises
  ctx.fillStyle = '#' + preset.eyeIris.toString(16).padStart(6, '0');
  ctx.beginPath(); ctx.arc(cx - 18, cy - 18, 3, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(cx + 18, cy - 18, 3, 0, Math.PI * 2); ctx.fill();

  // Nose shadow
  ctx.fillStyle = shadow;
  ctx.globalAlpha = 0.55;
  ctx.beginPath();
  ctx.moveTo(cx - 5, cy - 8);
  ctx.lineTo(cx - 6, cy + 12);
  ctx.lineTo(cx, cy + 16);
  ctx.lineTo(cx + 6, cy + 12);
  ctx.lineTo(cx + 5, cy - 8);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 1;

  // Mouth
  ctx.fillStyle = '#' + preset.lips.toString(16).padStart(6, '0');
  ctx.beginPath();
  ctx.ellipse(cx, cy + 30, 12, 4, 0, 0, Math.PI * 2);
  ctx.fill();

  // Beard for Brunson
  if (preset.beard) {
    ctx.fillStyle = '#' + preset.beard.toString(16).padStart(6, '0');
    ctx.globalAlpha = 0.95;
    // jaw shading
    ctx.beginPath();
    ctx.moveTo(cx - 50, cy + 22);
    ctx.quadraticCurveTo(cx, cy + 75, cx + 50, cy + 22);
    ctx.lineTo(cx + 38, cy + 50);
    ctx.quadraticCurveTo(cx, cy + 70, cx - 38, cy + 50);
    ctx.closePath();
    ctx.fill();
    // moustache
    ctx.fillRect(cx - 18, cy + 22, 36, 4);
    ctx.globalAlpha = 1;
  }

  // Hairline (Tiger has a low fade, Brunson short crop). The cap covers most of it.
  if (preset.cap !== 'cap' || preset.beard) {
    ctx.fillStyle = '#' + preset.hair.toString(16).padStart(6, '0');
    ctx.beginPath();
    ctx.moveTo(cx - 50, cy - 45);
    ctx.quadraticCurveTo(cx, cy - 75, cx + 50, cy - 45);
    ctx.lineTo(cx + 50, cy - 38);
    ctx.quadraticCurveTo(cx, cy - 50, cx - 50, cy - 38);
    ctx.closePath();
    ctx.fill();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

// ---------- club ----------

function buildClub() {
  const club = new THREE.Group();
  const grip = new THREE.Mesh(
    new THREE.CylinderGeometry(0.014, 0.012, 0.20, 8),
    mat(0x1a1a1a, 0.85),
  );
  grip.position.y = -0.1;
  grip.castShadow = true;
  club.add(grip);
  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(0.008, 0.008, 0.90, 8),
    mat(0xcfcfd4, 0.3, 0.9),
  );
  shaft.position.y = -0.65;
  shaft.castShadow = true;
  club.add(shaft);
  // Wedge-style head: angled flat box
  const head = new THREE.Mesh(
    new THREE.BoxGeometry(0.10, 0.06, 0.025),
    mat(0x2a2a2e, 0.35, 0.85),
  );
  head.position.set(0.045, -1.08, 0);
  head.rotation.z = -0.18;
  head.castShadow = true;
  club.add(head);
  return club;
}

// ---------- humanoid build ----------

function buildGolfer(preset) {
  const H = preset.height;
  const headSize = H / 7.5;                  // 7.5-head proportions for slightly stylized look
  const torsoLen = H * 0.30;
  const hipsY = H * 0.50;                    // hip joint height
  const shoulderY = hipsY + torsoLen;        // shoulder joint height
  const upperLeg = H * 0.27;
  const lowerLeg = H * 0.23;
  const upperArm = H * 0.18;
  const foreArm = H * 0.16;
  const shoulderHalf = (headSize * 1.45) * preset.shoulderWidth;
  const hipHalf = (headSize * 1.05);

  const root = new THREE.Group();
  root.name = `golfer-${preset.name}`;

  // Hips group sits at hip height; everything else hangs off this.
  const hips = new THREE.Group();
  hips.position.y = hipsY;
  root.add(hips);

  // ---------- legs ----------

  function buildLeg(side) {
    const grp = new THREE.Group();
    grp.position.set(hipHalf * side * 0.65, 0, 0);

    // Thigh
    const thighGeo = roundedBox(headSize * 0.55, upperLeg, headSize * 0.55, 0.05);
    const thigh = new THREE.Mesh(thighGeo, mat(preset.pants, 0.85));
    thigh.position.y = -upperLeg / 2;
    thigh.castShadow = true;
    grp.add(thigh);

    // Knee joint (sub-group rotates at the knee)
    const knee = new THREE.Group();
    knee.position.y = -upperLeg;
    grp.add(knee);

    const shinGeo = roundedBox(headSize * 0.48, lowerLeg, headSize * 0.48, 0.04);
    const shin = new THREE.Mesh(shinGeo, mat(preset.pants, 0.85));
    shin.position.y = -lowerLeg / 2;
    shin.castShadow = true;
    knee.add(shin);

    // Foot
    const foot = new THREE.Group();
    foot.position.y = -lowerLeg;
    knee.add(foot);

    const shoeGeo = roundedBox(headSize * 0.55, headSize * 0.30, headSize * 1.05, 0.04);
    const shoe = new THREE.Mesh(shoeGeo, mat(preset.shoes, 0.4));
    shoe.position.set(0, -headSize * 0.10, headSize * 0.25);
    shoe.castShadow = true;
    foot.add(shoe);

    const sole = new THREE.Mesh(
      roundedBox(headSize * 0.55, headSize * 0.08, headSize * 1.05, 0.02),
      mat(preset.shoeSole, 0.6),
    );
    sole.position.set(0, -headSize * 0.24, headSize * 0.25);
    sole.castShadow = false;
    foot.add(sole);

    return { grp, knee, foot };
  }
  const legL = buildLeg(-1);
  const legR = buildLeg(1);
  hips.add(legL.grp);
  hips.add(legR.grp);

  // ---------- torso ----------

  // Pelvis + belt
  const pelvis = new THREE.Mesh(
    roundedBox(hipHalf * 2.0, headSize * 0.55, headSize * 1.0 * preset.chest, 0.06),
    mat(preset.pants, 0.85),
  );
  pelvis.position.y = headSize * 0.20;
  pelvis.castShadow = true;
  hips.add(pelvis);

  const belt = new THREE.Mesh(
    new THREE.BoxGeometry(hipHalf * 2.05, headSize * 0.08, headSize * 1.02 * preset.chest),
    mat(preset.belt, 0.5),
  );
  belt.position.y = headSize * 0.42;
  hips.add(belt);

  // torsoPivot rotates the whole upper body (spine twist for swing).
  const torsoPivot = new THREE.Group();
  torsoPivot.position.y = headSize * 0.45;
  hips.add(torsoPivot);

  // Chest
  const chestGeo = roundedBox(
    shoulderHalf * 1.9,
    torsoLen * 0.75,
    headSize * 1.05 * preset.chest,
    0.08,
  );
  const chest = new THREE.Mesh(chestGeo, mat(preset.shirt, 0.75));
  chest.position.y = torsoLen * 0.35;
  chest.castShadow = true;
  torsoPivot.add(chest);

  // Collar trim
  const collar = new THREE.Mesh(
    new THREE.TorusGeometry(headSize * 0.42, headSize * 0.06, 6, 18, Math.PI),
    mat(preset.shirtCollar, 0.7),
  );
  collar.rotation.x = Math.PI / 2;
  collar.rotation.z = 0;
  collar.position.set(0, torsoLen * 0.72, headSize * 0.20);
  torsoPivot.add(collar);

  // ---------- neck + head ----------

  const neck = new THREE.Mesh(
    new THREE.CylinderGeometry(headSize * 0.22, headSize * 0.27, headSize * 0.35, 12),
    mat(preset.skin, 0.6),
  );
  neck.position.y = torsoLen * 0.85;
  neck.castShadow = true;
  torsoPivot.add(neck);

  const headGroup = new THREE.Group();
  headGroup.position.y = torsoLen * 0.85 + headSize * 0.75;
  torsoPivot.add(headGroup);

  // Head is a slightly elongated sphere with a procedural face texture.
  const headGeo = new THREE.SphereGeometry(headSize * 0.55, 24, 20);
  // Squish into a more humanoid shape
  headGeo.scale(0.92, 1.05, 0.95);
  const faceMat = new THREE.MeshStandardMaterial({
    map: makeFaceTexture(preset),
    roughness: 0.55,
    metalness: 0.0,
  });
  const head = new THREE.Mesh(headGeo, faceMat);
  head.castShadow = true;
  headGroup.add(head);

  // Jaw shadow box (subtle) — adds silhouette
  const jaw = new THREE.Mesh(
    roundedBox(headSize * 0.85, headSize * 0.35, headSize * 0.85, 0.06),
    mat(preset.skin, 0.6),
  );
  jaw.position.set(0, -headSize * 0.32, 0);
  headGroup.add(jaw);

  // Ears
  for (const side of [-1, 1]) {
    const ear = new THREE.Mesh(
      new THREE.SphereGeometry(headSize * 0.12, 10, 8),
      mat(preset.skin, 0.6),
    );
    ear.position.set(headSize * 0.50 * side, headSize * 0.05, 0);
    ear.scale.set(0.55, 1, 0.7);
    headGroup.add(ear);
  }

  // Hat
  if (preset.cap === 'cap' && preset.hat != null) {
    const crown = new THREE.Mesh(
      new THREE.SphereGeometry(headSize * 0.58, 18, 12, 0, Math.PI * 2, 0, Math.PI / 2),
      mat(preset.hat, 0.7),
    );
    crown.position.y = headSize * 0.30;
    crown.castShadow = true;
    headGroup.add(crown);

    const brim = new THREE.Mesh(
      new THREE.BoxGeometry(headSize * 1.15, headSize * 0.06, headSize * 0.55),
      mat(preset.hat, 0.7),
    );
    brim.position.set(0, headSize * 0.32, headSize * 0.55);
    brim.castShadow = true;
    headGroup.add(brim);

    if (preset.hatLogo != null) {
      const logo = new THREE.Mesh(
        new THREE.PlaneGeometry(headSize * 0.18, headSize * 0.10),
        new THREE.MeshStandardMaterial({ color: preset.hatLogo, roughness: 0.6 }),
      );
      logo.position.set(0, headSize * 0.42, headSize * 0.58);
      logo.rotation.x = -0.1;
      headGroup.add(logo);
    }
  }

  // ---------- shoulders + arms ----------

  // armsPivot rotates both arms together (swing motion). Each arm has its
  // own shoulder + elbow joint so the forearm bends naturally. Place the
  // shoulders right at the top of the chest so arms hang OUTSIDE the torso.
  const armsPivot = new THREE.Group();
  armsPivot.position.y = torsoLen * 0.70;
  torsoPivot.add(armsPivot);

  function buildArm(side) {
    const shoulder = new THREE.Group();
    shoulder.position.set(shoulderHalf * 1.05 * side, 0, 0);
    armsPivot.add(shoulder);

    // Shoulder cap
    const shoulderCap = new THREE.Mesh(
      new THREE.SphereGeometry(headSize * 0.32, 14, 10),
      mat(preset.shirt, 0.75),
    );
    shoulderCap.castShadow = true;
    shoulder.add(shoulderCap);

    // Upper arm
    const upperGeo = roundedBox(headSize * 0.30, upperArm, headSize * 0.32, 0.04);
    const upper = new THREE.Mesh(upperGeo, mat(preset.shirt, 0.75));
    upper.position.y = -upperArm / 2;
    upper.castShadow = true;
    shoulder.add(upper);

    // Elbow joint
    const elbow = new THREE.Group();
    elbow.position.y = -upperArm;
    shoulder.add(elbow);

    // Forearm (skin)
    const foreGeo = roundedBox(headSize * 0.24, foreArm, headSize * 0.26, 0.04);
    const fore = new THREE.Mesh(foreGeo, mat(preset.skin, 0.6));
    fore.position.y = -foreArm / 2;
    fore.castShadow = true;
    elbow.add(fore);

    // Hand
    const hand = new THREE.Group();
    hand.position.y = -foreArm;
    elbow.add(hand);

    const palm = new THREE.Mesh(
      roundedBox(headSize * 0.32, headSize * 0.20, headSize * 0.16, 0.03),
      mat(preset.skin, 0.6),
    );
    palm.castShadow = true;
    hand.add(palm);

    return { shoulder, elbow, hand };
  }
  const armL = buildArm(-1);
  const armR = buildArm(1);

  // Hands grip the club between them. Grip pivot lives at the wrist-fork.
  const gripPivot = new THREE.Group();
  gripPivot.position.set(0, -upperArm * 0.95 - foreArm * 0.95, foreArm * 0.65);
  armsPivot.add(gripPivot);

  const club = buildClub();
  gripPivot.add(club);

  return {
    root,
    hips,
    torsoPivot,
    armsPivot,
    armL, armR,
    legL, legR,
    gripPivot,
    club,
    headGroup,
    scaleY: H / 1.8,
    H, headSize,
  };
}

// ---------- rounded-box helper (chamfered edges look softer than raw cubes) ----------

function roundedBox(w, h, d, radius = 0.05) {
  // BoxGeometry with tweaked vertices — cheap chamfer via barycentric squish.
  // For simplicity we just return a slightly subdivided BoxGeometry and let the
  // smooth shading + lighting handle the rest. (Real chamfer would be heavier.)
  const geo = new THREE.BoxGeometry(w, h, d, 2, 2, 2);
  return geo;
}

// ---------- pose targets ----------

// Right-handed golfer. The ball sits to the model's right (slightly +X in local
// space) at ~mid-shin height. We rotate around Y for spine twist, X for forward
// lean. Knees / elbows get a slight per-state bend.

const POSES = {
  idle: {
    torsoY: 0,        torsoX: 0,
    armsX: 0.08,      armsY: 0,
    elbowL: 0.25,     elbowR: 0.25,
    gripX: 0,         clubRot: 0,
    kneeL: 0.10,      kneeR: 0.10,
    headX: 0,         headY: 0,
  },
  address: {
    torsoY: 0.08,     torsoX: 0.42,
    armsX: 0.95,      armsY: 0.05,
    elbowL: 0.15,     elbowR: 0.15,
    gripX: 0,         clubRot: 0,
    kneeL: 0.25,      kneeR: 0.25,
    headX: 0.30,      headY: 0.05,
  },
  backswing: {
    torsoY: -1.50,    torsoX: 0.20,
    armsX: -1.30,     armsY: 0.25,
    elbowL: 0.05,     elbowR: 1.40,
    gripX: 0,         clubRot: -1.80,
    kneeL: 0.18,      kneeR: 0.30,
    headX: 0.25,      headY: -0.30,
  },
  downswing: {
    torsoY: 0.25,     torsoX: 0.30,
    armsX: 0.95,      armsY: 0.10,
    elbowL: 0.10,     elbowR: 0.30,
    gripX: 0,         clubRot: 0.20,
    kneeL: 0.22,      kneeR: 0.22,
    headX: 0.35,      headY: 0.0,
  },
  follow: {
    torsoY: 1.65,     torsoX: 0.05,
    armsX: 1.40,      armsY: -0.10,
    elbowL: 1.50,     elbowR: 0.20,
    gripX: 0,         clubRot: 1.60,
    kneeL: 0.10,      kneeR: 0.05,
    headX: -0.05,     headY: 0.30,
  },
  reset: {
    torsoY: 0,        torsoX: 0,
    armsX: 0.08,      armsY: 0,
    elbowL: 0.25,     elbowR: 0.25,
    gripX: 0,         clubRot: 0,
    kneeL: 0.10,      kneeR: 0.10,
    headX: 0,         headY: 0,
  },
};

const TIMING = {
  idle:      { dur: Infinity, ease: 'linear' },
  address:   { dur: 0.5, ease: 'easeOut' },
  backswing: { dur: 0.75, ease: 'easeInOut' },
  downswing: { dur: 0.22, ease: 'easeIn' },
  follow:    { dur: 0.5, ease: 'easeOut' },
  reset:     { dur: 0.7, ease: 'easeInOut' },
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
  parts.armsPivot.rotation.y = pose.armsY;
  parts.armL.elbow.rotation.x = pose.elbowL;
  parts.armR.elbow.rotation.x = pose.elbowR;
  parts.gripPivot.rotation.x = pose.gripX;
  parts.club.rotation.x = pose.clubRot;
  parts.legL.knee.rotation.x = pose.kneeL;
  parts.legR.knee.rotation.x = pose.kneeR;
  parts.headGroup.rotation.x = pose.headX * 0.4;
  parts.headGroup.rotation.y = pose.headY;
}

function readPose(parts) {
  return {
    torsoY: parts.torsoPivot.rotation.y,
    torsoX: parts.torsoPivot.rotation.x,
    armsX: parts.armsPivot.rotation.x,
    armsY: parts.armsPivot.rotation.y,
    elbowL: parts.armL.elbow.rotation.x,
    elbowR: parts.armR.elbow.rotation.x,
    gripX: parts.gripPivot.rotation.x,
    clubRot: parts.club.rotation.x,
    kneeL: parts.legL.knee.rotation.x,
    kneeR: parts.legR.knee.rotation.x,
    headX: parts.headGroup.rotation.x / 0.4,
    headY: parts.headGroup.rotation.y,
  };
}

function lerpPose(from, to, t) {
  const out = {};
  for (const k of Object.keys(to)) out[k] = lerp(from[k] ?? 0, to[k], t);
  return out;
}

// ---------- exports ----------

export function createGolfer({ character = 'tiger' } = {}) {
  const preset = PRESETS[character] ?? PRESETS.tiger;
  const parts = buildGolfer(preset);

  let state = 'idle';
  let fromPose = { ...POSES.idle };
  let toPose = { ...POSES.idle };
  let elapsed = 0;
  let duration = TIMING.idle.dur;
  let easing = TIMING.idle.ease;
  let idleClock = Math.random() * 4;

  applyPose(parts, fromPose);

  function setSwingState(next) {
    if (!STATES.includes(next)) return;
    fromPose = readPose(parts);
    toPose = POSES[next];
    duration = TIMING[next].dur;
    easing = TIMING[next].ease;
    elapsed = 0;
    state = next;
  }

  function update(dt) {
    if (!isFinite(dt) || dt <= 0) return;
    if (state === 'idle') {
      idleClock += dt;
      const sway = Math.sin(idleClock * 1.4) * 0.04;
      const bob = Math.sin(idleClock * 2.0) * 0.012;
      const breathe = Math.sin(idleClock * 1.6) * 0.008;
      parts.torsoPivot.rotation.y = sway;
      parts.torsoPivot.rotation.x = 0.03 + bob;
      parts.armsPivot.rotation.x = 0.08 + Math.sin(idleClock * 1.4) * 0.025;
      parts.headGroup.rotation.y = Math.sin(idleClock * 0.7) * 0.10;
      parts.headGroup.position.y = parts.headGroup.userData.baseY ?? 0;
      // Slight weight shift on the legs
      parts.legL.knee.rotation.x = 0.10 + breathe;
      parts.legR.knee.rotation.x = 0.10 - breathe;
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
