// cannon-es world for golf. Fixed timestep accumulator with realistic dimpled-ball
// aerodynamics: dimpled drag (Cd ~ 0.24), separate spin-driven lift coefficient
// (the thing that lets a real golf ball hang in the air far longer than a thrown
// rock), and exponential spin decay over the flight.
//
// Air density is parameterized: setAir({ tempC, humidity, altitudeM }) lets the
// engine model thin mountain air or muggy summer afternoons. Default sea-level
// 20°C / 50% RH / 0m gives rho ≈ 1.204 kg/m^3.

import * as CANNON from 'cannon-es';

const BALL_RADIUS = 0.0213;     // real golf ball (m)
const BALL_MASS = 0.0459;       // kg
const FRONTAL_AREA = Math.PI * BALL_RADIUS * BALL_RADIUS;

// ---- Aerodynamic coefficients ----
// Cd_DIMPLED: dimpled golf ball at PGA-tour Re (~1.5e5). Smooth-sphere Cd ~ 0.47;
// dimples drop it to ~0.24-0.27 at flight Re. We use a mild speed-dependent ramp
// (very low speeds skirt the laminar/turbulent transition where drag rises).
function dragCoefficient(speed) {
  if (speed < 12) return 0.30;  // sub-Re_critical: more drag
  if (speed < 25) return 0.27;
  return 0.24;                   // typical driver-flight Cd
}

// Cl from spin ratio S = omega * r / |v|. Bearman/Harvey-style saturating curve;
// caps near 0.30 at S ~ 0.25 (typical driver) and stays flat for high-S short irons.
// At S=0 (no spin) lift is zero — putters and knock-downs don't float.
function liftCoefficient(spinRatio) {
  if (spinRatio < 1e-4) return 0;
  // Smooth saturating curve: Cl ≈ 1 / (2 + 1/S^0.4). Empirical fit to wind-tunnel
  // data for dimpled spheres; bounded above by ~0.5 even at unrealistic spin.
  const s04 = Math.pow(spinRatio, 0.4);
  return 1 / (2 + 1 / s04);
}

// Lift calibration scalar. The bare Cl(S) curve over-lifts at our club params and
// balloons shots; ~0.45 lands realistic 230m driver carries with a ~30m apex.
const LIFT_SCALE = 0.45;

// Spin decay time constant (seconds). Real golf balls lose ~10-15% of backspin
// over a 6s flight; tau ~ 20s matches that with exp(-6/20) = 0.74 retention.
const SPIN_DECAY_TAU = 20;

// Standard-atmosphere reference values for the air-density formula.
const P0 = 101325;        // Pa (sea level)
const T0_K = 288.15;      // K (15°C reference; we shift by tempC at evaluation time)
const R_DRY = 287.058;    // J/(kg·K) dry air
const R_VAP = 461.495;    // J/(kg·K) water vapor
const ALT_LAPSE = 0.0065; // K/m
const P_EXP = 5.2561;     // -g·M/(R·L)

// Saturation vapor pressure (Pa) — Tetens approximation, T in °C.
function pSat(tempC) {
  return 610.78 * Math.exp((17.27 * tempC) / (tempC + 237.3));
}

// rho for moist air at altitude. Defaults: 20°C, 50% RH, 0m → ~1.204 kg/m^3.
function computeRho({ tempC = 20, humidity = 0.5, altitudeM = 0 } = {}) {
  const T = tempC + 273.15;
  // Pressure at altitude (ISA model)
  const P = P0 * Math.pow(1 - (ALT_LAPSE * altitudeM) / T0_K, P_EXP);
  // Partial pressures
  const pv = humidity * pSat(tempC);
  const pd = Math.max(0, P - pv);
  return pd / (R_DRY * T) + pv / (R_VAP * T);
}

export function createPhysics() {
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.81, 0) });
  world.broadphase = new CANNON.NaiveBroadphase();
  world.allowSleep = true;
  world.defaultContactMaterial.contactEquationStiffness = 1e7;
  world.defaultContactMaterial.contactEquationRelaxation = 4;

  // Per-surface materials. Greens roll the fastest and barely bounce; fairway is
  // a hair grippier and has a real bounce; rough deadens; sand plugs.
  //   friction = sliding/rolling friction in cannon contact
  //   restitution = bounciness (0 = perfectly plastic, 1 = elastic)
  // We pick numbers from real-ball-on-turf measurements: green stimp ≈ 10 → ball
  // rolls a long way at low friction; sand absorbs ~80% of impact energy.
  const fairwayMat = new CANNON.Material('fairway');
  const roughMat = new CANNON.Material('rough');
  const greenMat = new CANNON.Material('green');
  const sandMat = new CANNON.Material('sand');
  const ballMat = new CANNON.Material('ball');

  world.addContactMaterial(new CANNON.ContactMaterial(ballMat, fairwayMat, {
    friction: 0.05, restitution: 0.40,
  }));
  world.addContactMaterial(new CANNON.ContactMaterial(ballMat, greenMat, {
    friction: 0.03, restitution: 0.25,   // green: smooth roll, low check-bounce
  }));
  world.addContactMaterial(new CANNON.ContactMaterial(ballMat, roughMat, {
    friction: 0.40, restitution: 0.25,
  }));
  world.addContactMaterial(new CANNON.ContactMaterial(ballMat, sandMat, {
    friction: 0.85, restitution: 0.05,   // sand: plugs hard, dead bounce
  }));

  // Ball
  const ballShape = new CANNON.Sphere(BALL_RADIUS);
  const ball = new CANNON.Body({
    mass: BALL_MASS,
    shape: ballShape,
    material: ballMat,
    linearDamping: 0.0,    // handled manually via drag force
    angularDamping: 0.25,
  });
  ball.allowSleep = true;
  ball.sleepSpeedLimit = 0.05;
  ball.sleepTimeLimit = 0.8;
  world.addBody(ball);

  // Default infinite ground plane (rough) at y=0. Per-hole terrain stacks slight Y offsets
  // on top (greens > fairway > rough) so the ball rolls on the correct surface. This plane
  // is also the catch-all for shots that fly off the course.
  const groundBody = new CANNON.Body({ mass: 0, material: roughMat });
  groundBody.addShape(new CANNON.Plane());
  groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
  world.addBody(groundBody);

  const staticBodies = [];

  function addStaticMesh(threeMesh, surfaceType = 'fairway') {
    const geo = threeMesh.geometry;
    if (!geo) return null;
    const posAttr = geo.attributes.position;
    const idxAttr = geo.index;
    const vertices = new Array(posAttr.count * 3);
    for (let i = 0; i < posAttr.count; i++) {
      vertices[i * 3] = posAttr.getX(i);
      vertices[i * 3 + 1] = posAttr.getY(i);
      vertices[i * 3 + 2] = posAttr.getZ(i);
    }
    let indices;
    if (idxAttr) {
      indices = Array.from(idxAttr.array);
    } else {
      indices = new Array(posAttr.count);
      for (let i = 0; i < posAttr.count; i++) indices[i] = i;
    }
    const shape = new CANNON.Trimesh(vertices, indices);
    // Map surfaceType to the cannon Material. Order matters: more-specific tags
    // override the fairway fallback. terrain.js still passes 'fairway'/'rough'
    // for fast-roll vs sticky-roll regions; 'green'/'sand' bring the new feel.
    const mat = surfaceType === 'green' ? greenMat
              : surfaceType === 'sand' ? sandMat
              : surfaceType === 'rough' ? roughMat
              : fairwayMat;
    const body = new CANNON.Body({ mass: 0, material: mat });
    body.addShape(shape);
    body.position.set(threeMesh.position.x, threeMesh.position.y, threeMesh.position.z);
    body.quaternion.set(
      threeMesh.quaternion.x,
      threeMesh.quaternion.y,
      threeMesh.quaternion.z,
      threeMesh.quaternion.w,
    );
    world.addBody(body);
    staticBodies.push(body);
    return body;
  }

  // Wind state (set per hole). dir is radians in XZ plane; 0 = +Z (with player toward pin).
  // Drag/lift are computed against (v - wind), which naturally produces head/tail/cross effects.
  const wind = { vec: new CANNON.Vec3(0, 0, 0), speed: 0 };
  function setWind({ speed = 0, dir = 0 } = {}) {
    wind.speed = speed;
    wind.vec.set(Math.sin(dir) * speed, 0, Math.cos(dir) * speed);
  }

  // Air state. setAir() updates rho for the rest of the round (or until next call).
  const air = { tempC: 20, humidity: 0.5, altitudeM: 0, rho: computeRho() };
  function setAir({ tempC, humidity, altitudeM } = {}) {
    if (Number.isFinite(tempC)) air.tempC = tempC;
    if (Number.isFinite(humidity)) air.humidity = Math.max(0, Math.min(1, humidity));
    if (Number.isFinite(altitudeM)) air.altitudeM = altitudeM;
    air.rho = computeRho({ tempC: air.tempC, humidity: air.humidity, altitudeM: air.altitudeM });
  }

  // Green-slope state (set per-hole or when the ball enters the green). (ax, az) is the
  // acceleration vector (m/s^2) in world XZ — ~0.3 for a typical 3% green grade. Applied
  // only when the ball is rolling slowly on the ground so it doesn't shove an airborne ball.
  const slope = { ax: 0, az: 0 };
  const _slopeForce = new CANNON.Vec3();
  function setGreenSlope({ ax = 0, az = 0 } = {}) {
    slope.ax = ax;
    slope.az = az;
  }
  function applyGreenSlope() {
    if (ball.sleepState === CANNON.Body.SLEEPING) return;
    if (slope.ax === 0 && slope.az === 0) return;
    const v = ball.velocity;
    const onGround = ball.position.y < BALL_RADIUS * 3;
    const slow = v.length() < 4; // only break the putt when speed is reasonable
    if (!onGround || !slow) return;
    const k = BALL_MASS * 0.6;
    _slopeForce.set(slope.ax * k, 0, slope.az * k);
    ball.applyForce(_slopeForce, ball.position);
  }

  // Current ball surface — set by the engine each frame based on terrain.lieAt.
  // Used by the rollout damper, the green-check landing model, and putting feel.
  let ballSurface = 'fairway';
  function setBallSurface(s) { ballSurface = s || 'fairway'; }
  function getBallSurface() { return ballSurface; }

  // Pin position for cup-capture + rim-out. y is the surface height at the pin.
  // Engine calls setPin({ x, y, z }) per hole.
  const pin = { x: NaN, y: NaN, z: NaN, set: false };
  function setPin({ x, y = 0, z } = {}) {
    if (Number.isFinite(x) && Number.isFinite(z)) {
      pin.x = x; pin.y = y; pin.z = z; pin.set = true;
    } else {
      pin.set = false;
    }
  }

  // ---- Surface-aware rollout damper ----
  //
  // Cannon's per-material friction handles sliding contact, but the ball still
  // wants to roll too far on the rough/green without an extra rolling drag. This
  // function adds a small velocity damping on each step that's tagged by surface.
  // - green: very light damping (wants to roll a long way at putt speeds)
  // - fairway: light
  // - rough: heavier
  // - sand: VERY heavy (plug)
  // Damping only applies while the ball is on the ground (low Y, low speed).
  const ROLL_DAMP = { green: 0.15, fairway: 0.30, rough: 1.40, sand: 3.50, tee: 0.30 };
  function applyRollout(dt) {
    if (ball.sleepState === CANNON.Body.SLEEPING) return;
    const v = ball.velocity;
    const sp = Math.hypot(v.x, v.z);
    if (sp < 1e-3) return;
    const onGround = ball.position.y < BALL_RADIUS * 2.5;
    if (!onGround) return;
    const k = ROLL_DAMP[ballSurface] ?? ROLL_DAMP.fairway;
    // Exponential decay so dt is correct
    const f = Math.exp(-k * dt);
    v.x *= f;
    v.z *= f;
  }

  // ---- Green-check landing (wedge backspin pulls the ball back) ----
  //
  // When a high-spin ball lands on a green at a steep descent angle, the spin
  // transfers into reverse rolling. We watch for the moment the ball's Y goes
  // from "in the air" to "rolling": if landing surface is 'green' AND backspin
  // (component of omega around the side-perp axis) is high AND descent is steep,
  // reverse the horizontal velocity by a fraction proportional to spin × steepness.
  let _wasInAir = false;
  let _prevVy = 0;
  function applyGreenCheck() {
    const v = ball.velocity;
    const y = ball.position.y;
    const inAir = y > BALL_RADIUS * 3;
    if (inAir) { _wasInAir = true; _prevVy = v.y; return; }
    if (!_wasInAir) return;
    _wasInAir = false;
    if (ballSurface !== 'green') return;

    // descent steepness: steeper landing = stronger check. Use vy at impact / |vXZ|
    const vyImpact = -_prevVy;            // positive number now (was negative going down)
    const hSpeed = Math.hypot(v.x, v.z);
    if (hSpeed < 0.5 || vyImpact < 1) return;
    const steepness = Math.min(1.5, vyImpact / hSpeed); // ~1 for wedge, ~0.3 for driver

    const w = ball.angularVelocity;
    // Backspin = the component of omega perpendicular to the horizontal velocity
    // direction (the side axis). We approximate: in our convention backspin is set
    // about the axis (-vZ, 0, vX) at launch, but spin decays — use total omega
    // magnitude scaled by how aligned it is with horizontal.
    const omegaH = Math.hypot(w.x, w.z);
    if (omegaH < 50) return;
    // Check force: scales with steepness * (omegaH / typical_wedge_spin)
    const spinFactor = Math.min(1.5, omegaH / 600);
    const checkFactor = Math.min(0.85, 0.55 * steepness * spinFactor);
    // Reverse horizontal velocity by checkFactor, and zero vertical bounce-back
    // so the ball doesn't pogo on a hard check.
    v.x *= -checkFactor;
    v.z *= -checkFactor;
    v.y *= 0.3;
  }

  // ---- Cup attraction + rim-out ----
  //
  // On slopes the 11cm cup is a tiny target; balls rolling 2 m/s within an inch
  // of the edge would otherwise miss every time. We add a soft attraction toward
  // the cup when the ball is slow + close, scaling with proximity so it's not
  // arcade-magnetic. Outside this window we model rim-out: a fast ball clipping
  // the cup lip deflects off rather than dropping.
  const CUP_RADIUS = 0.054;                 // standard cup is 4.25", radius 0.054m
  const CUP_GIMME_RADIUS = CUP_RADIUS * 2.8; // ~15cm — within this + slow, attract
  const CUP_RIMOUT_RADIUS = CUP_RADIUS * 1.3;
  const CUP_SLOW_SPEED = 1.5;               // m/s
  const CUP_RIMOUT_SPEED = 2.5;             // m/s
  const _toCup = new CANNON.Vec3();
  function applyCupCapture(dt) {
    if (!pin.set) return;
    if (ball.sleepState === CANNON.Body.SLEEPING) return;
    if (ballSurface !== 'green') return;
    const v = ball.velocity;
    const speed = v.length();
    const dx = pin.x - ball.position.x;
    const dz = pin.z - ball.position.z;
    const dist = Math.hypot(dx, dz);
    const onGround = ball.position.y < pin.y + BALL_RADIUS * 4;
    if (!onGround) return;

    // ---- Rim-out: fast ball clipping the cup lip deflects ----
    if (dist > CUP_RADIUS && dist < CUP_RIMOUT_RADIUS && speed > CUP_RIMOUT_SPEED) {
      // Push the ball perpendicular to its velocity, away from the cup center.
      // Magnitude scales with overlap into the rim-out band.
      const overlap = (CUP_RIMOUT_RADIUS - dist) / (CUP_RIMOUT_RADIUS - CUP_RADIUS);
      const hSpeed = Math.max(0.5, Math.hypot(v.x, v.z));
      // Tangent vector to velocity in XZ (rotate 90°)
      const tx = -v.z / hSpeed, tz = v.x / hSpeed;
      // Direction away from cup, projected onto tangent
      const awayX = -dx / Math.max(0.001, dist);
      const awayZ = -dz / Math.max(0.001, dist);
      const sign = tx * awayX + tz * awayZ >= 0 ? 1 : -1;
      const kick = overlap * hSpeed * 0.6;
      v.x += sign * tx * kick;
      v.z += sign * tz * kick;
      return;
    }

    // ---- Cup gimme: slow ball near the cup gets a soft pull ----
    if (dist > CUP_RADIUS && dist < CUP_GIMME_RADIUS && speed < CUP_SLOW_SPEED) {
      // Acceleration toward cup, scaled by (1 - dist/GIMME) and slow-speed factor
      const proximity = 1 - (dist - CUP_RADIUS) / (CUP_GIMME_RADIUS - CUP_RADIUS);
      const slow = 1 - speed / CUP_SLOW_SPEED;
      const accelMag = 1.6 * proximity * slow;  // m/s² toward cup
      const inv = 1 / Math.max(0.001, dist);
      _toCup.set(dx * inv * accelMag, 0, dz * inv * accelMag);
      // Apply as force = mass * a
      ball.applyForce(
        new CANNON.Vec3(_toCup.x * BALL_MASS, 0, _toCup.z * BALL_MASS),
        ball.position,
      );
    }
  }

  // Per-step aerodynamics. Three forces act on a flying ball:
  //   1. Drag: F_d = -0.5 * rho * Cd(v) * A * |vRel| * vRel
  //   2. Lift: F_l = 0.5 * rho * Cl(S) * A * |vRel|^2 * (omega x vRel) / (|omega| * |vRel|)
  //              where S = |omega| * r / |vRel| is the spin ratio. The vector
  //              (omega × vRel) is perpendicular to motion and aligned with the
  //              Magnus side (backspin → upward, sidespin → side). Normalizing by
  //              |omega| · |vRel| extracts the unit force direction; we then scale
  //              by 0.5·rho·Cl·A·|vRel|^2 to get the lift magnitude. Net result:
  //              lift scales with v^2 (so faster shots get more lift, which is
  //              what makes drivers fly so high) but the per-step force is bounded
  //              by Cl_max ~ 0.5, far below anything that destabilizes the
  //              integrator at our 1/60s dt.
  //   3. Spin decay: omega exponentially bleeds off (tau ~ 20s).
  // Wind: drag and lift use vRel = v - wind so head/tail/cross all matter.
  const _drag = new CANNON.Vec3();
  const _vRel = new CANNON.Vec3();
  const _lift = new CANNON.Vec3();
  function applyAerodynamics(dt) {
    if (ball.sleepState === CANNON.Body.SLEEPING) return;
    const v = ball.velocity;
    const w = ball.angularVelocity;
    // Only apply wind to the ball while it's in flight (above ground a bit) so
    // a putt isn't pushed sideways by a 6 m/s breeze.
    const inFlight = ball.position.y > BALL_RADIUS * 3 && v.length() > 0.5;
    if (inFlight) {
      _vRel.set(v.x - wind.vec.x, v.y - wind.vec.y, v.z - wind.vec.z);
    } else {
      _vRel.set(v.x, v.y, v.z);
    }
    const relSpeed = _vRel.length();
    if (relSpeed < 0.05) return;

    const rho = air.rho;
    const Cd = dragCoefficient(relSpeed);

    // ---- Drag ----
    const kd = 0.5 * rho * Cd * FRONTAL_AREA * relSpeed;
    _drag.set(-_vRel.x * kd, -_vRel.y * kd, -_vRel.z * kd);
    ball.applyForce(_drag, ball.position);

    // ---- Lift (spin-driven) ----
    const omega = w.length();
    if (omega > 1e-3) {
      // omega × vRel — perpendicular to motion, in the spin-axis "up" direction.
      const cx = w.y * _vRel.z - w.z * _vRel.y;
      const cy = w.z * _vRel.x - w.x * _vRel.z;
      const cz = w.x * _vRel.y - w.y * _vRel.x;
      const cmag = Math.sqrt(cx * cx + cy * cy + cz * cz);
      if (cmag > 1e-6) {
        const S = (omega * BALL_RADIUS) / relSpeed;
        const Cl = liftCoefficient(S);
        if (Cl > 0) {
          // Lift magnitude (N). Unit direction = cross / cmag. Combine into one scale.
          // LIFT_SCALE calibration: the textbook Cl(S) curve produced ~2x gravity of
          // lift at driver launch, which ballooned every shot (52m apex, 130m carry).
          // Scaling to ~1x-weight lift gives a penetrating flight that carries ~230m.
          const kl = (LIFT_SCALE * 0.5 * rho * Cl * FRONTAL_AREA * relSpeed * relSpeed) / cmag;
          _lift.set(cx * kl, cy * kl, cz * kl);
          ball.applyForce(_lift, ball.position);
        }
      }

      // ---- Spin decay (exponential, dt-correct) ----
      if (dt > 0) {
        const decay = Math.exp(-dt / SPIN_DECAY_TAU);
        w.x *= decay; w.y *= decay; w.z *= decay;
      }
    }
  }

  // Safety net: clamp absurd speeds and reset any non-finite state so a single bad
  // step can never propagate NaN into the renderer/camera.
  const MAX_SPEED = 120;   // m/s — above any real golf ball speed
  const MAX_SPIN = 1300;   // rad/s — above realistic wedge spin (~12k rpm = 1257 rad/s)
  const MAX_POS = 2000;    // m — no hole is bigger; anything past this is a blow-up
  let _lastSafePos = new CANNON.Vec3(0, BALL_RADIUS, 0);
  function sanitize() {
    const p = ball.position, v = ball.velocity, w = ball.angularVelocity;
    const finite = Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z) &&
                   Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
    const sane = finite && Math.abs(p.x) < MAX_POS && Math.abs(p.y) < MAX_POS && Math.abs(p.z) < MAX_POS;
    if (!sane) {
      // Snap back to the last known-good position, dead stop.
      ball.position.set(_lastSafePos.x, _lastSafePos.y, _lastSafePos.z);
      ball.velocity.set(0, 0, 0);
      ball.angularVelocity.set(0, 0, 0);
      ball.sleep();
      return;
    }
    // Record good position and clamp extreme but finite values.
    _lastSafePos.set(p.x, p.y, p.z);
    const sp = v.length();
    if (sp > MAX_SPEED) v.scale(MAX_SPEED / sp, v);
    const wp = w.length();
    if (wp > MAX_SPIN) w.scale(MAX_SPIN / wp, w);
  }
  function markSafePos(x, y, z) { _lastSafePos.set(x, y, z); }

  const FIXED_DT = 1 / 60;
  const MAX_SUBSTEPS = 6;
  let accumulator = 0;

  function step(dt) {
    accumulator += Math.min(dt, 0.1);
    let steps = 0;
    while (accumulator >= FIXED_DT && steps < MAX_SUBSTEPS) {
      applyAerodynamics(FIXED_DT);
      applyGreenSlope();
      applyRollout(FIXED_DT);
      applyCupCapture(FIXED_DT);
      // Green-check evaluates BEFORE world.step so the impulse hits the
      // velocity we'll integrate this frame, not next.
      applyGreenCheck();
      world.step(FIXED_DT);
      sanitize();
      accumulator -= FIXED_DT;
      steps += 1;
    }
  }

  function dispose() {
    while (world.bodies.length) world.removeBody(world.bodies[0]);
  }

  function removeStaticBodies() {
    for (const b of staticBodies) world.removeBody(b);
    staticBodies.length = 0;
  }

  return {
    world,
    ball,
    addStaticMesh,
    removeStaticBodies,
    setWind,
    setAir,
    getAir: () => ({ ...air }),
    setGreenSlope,
    setBallSurface,
    getBallSurface,
    setPin,
    markSafePos,
    step,
    dispose,
    BALL_RADIUS,
    CUP_RADIUS,
    materials: { fairwayMat, roughMat, greenMat, sandMat, ballMat },
  };
}
